
import json
import logging
import os
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

import azure.functions as func
from azure.data.tables import TableServiceClient

app = func.FunctionApp()

PRIMARY_URL = "http://172.198.68.165"
SECONDARY_URL = "http://20.235.89.90"
TRAFFIC_MANAGER_URL = "http://amaan-mrdr-2026.trafficmanager.net"


def check_endpoint(url, expected_text):
    started = time.perf_counter()

    try:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "DR-Health-Validator/1.0"},
        )

        with urllib.request.urlopen(request, timeout=8) as response:
            body = response.read().decode("utf-8", errors="replace")
            latency_ms = round((time.perf_counter() - started) * 1000, 2)

            return {
                "healthy": response.status == 200 and expected_text in body,
                "latency_ms": latency_ms,
                "error": None,
            }

    except Exception as exc:
        return {
            "healthy": False,
            "latency_ms": None,
            "error": str(exc),
        }


@app.timer_trigger(
    schedule="0 */5 * * * *",
    arg_name="timer",
    run_on_startup=False,
    use_monitor=True,
)
def scheduled_dr_health_check(timer: func.TimerRequest) -> None:
    test_id = str(uuid.uuid4())

    endpoints = {
        "primary": check_endpoint(PRIMARY_URL, "PRIMARY REGION"),
        "secondary": check_endpoint(SECONDARY_URL, "SECONDARY REGION"),
        "traffic_manager": (
            check_endpoint(TRAFFIC_MANAGER_URL, "PRIMARY REGION")
        ),
    }

    if not endpoints["traffic_manager"]["healthy"]:
        endpoints["traffic_manager"] = check_endpoint(
            TRAFFIC_MANAGER_URL, "SECONDARY REGION"
        )

    healthy_count = sum(
        result["healthy"] for result in endpoints.values()
    )

    report = {
        "project": "multi-region-disaster-recovery",
        "test_id": test_id,
        "test_type": "scheduled_health_check",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "endpoint_health": endpoints,
        "summary": {
            "total_endpoints": len(endpoints),
            "healthy_endpoints": healthy_count,
            "unhealthy_endpoints": len(endpoints) - healthy_count,
            "overall_status": (
                "READY" if healthy_count == len(endpoints)
                else "DEGRADED"
            ),
        },
    }

    connection_string = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")

    if not connection_string:
        logging.error("Storage connection string is not configured.")
        raise RuntimeError("Missing AZURE_STORAGE_CONNECTION_STRING")

    service = TableServiceClient.from_connection_string(connection_string)

    try:
        table = service.get_table_client("DRTestLogs")
        table.upsert_entity({
            "PartitionKey": "scheduled_health_check",
            "RowKey": test_id,
            "TestType": "scheduled_health_check",
            "OverallStatus": report["summary"]["overall_status"],
            "GeneratedAt": report["generated_at"],
            "HealthyEndpoints": healthy_count,
            "TotalEndpoints": len(endpoints),
            "ReportJson": json.dumps(report),
        })
    finally:
        service.close()

    logging.info(
        "DR health check %s: %s (%s/3 endpoints healthy)",
        test_id,
        report["summary"]["overall_status"],
        healthy_count,
    )
