import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from azure.data.tables import TableServiceClient
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

ROOT = Path(__file__).resolve().parent
REPORTS = ROOT / "reports"

app = FastAPI(title="SentinelDR Dashboard API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

PRIMARY_RG = "rg-dr-primary-indiasouthcentral"
PRIMARY_VM = "vm-dr-primary"

PRIMARY_URL = "http://172.198.68.165"
SECONDARY_URL = "http://20.235.89.90"
TM_URL = "http://amaan-mrdr-2026.trafficmanager.net"

FAILOVER_TIMEOUT = 240
RESTORE_TIMEOUT = 300
DEALLOCATION_TIMEOUT = 180
POLL_INTERVAL = 2

failover_lock = threading.Lock()

LIVE_ENDPOINTS = [
    {
        "endpoint": "primary",
        "url": PRIMARY_URL,
        "expected_text": "PRIMARY REGION",
    },
    {
        "endpoint": "secondary",
        "url": SECONDARY_URL,
        "expected_text": "SECONDARY REGION",
    },
    {
        "endpoint": "traffic_manager",
        "url": TM_URL,
        "expected_text": None,
    },
]


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path):
    if not path.exists():
        return None

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def get_page(url, timeout=8):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "SentinelDR-Dashboard/1.0"},
    )

    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read().decode(
            "utf-8", errors="replace"
        )


def run_az(*args, timeout=300):
    command = subprocess.list2cmdline(["az", *args])

    return subprocess.run(
        ["cmd.exe", "/d", "/c", command],
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def check_endpoint_health(url, expected_text):
    try:
        status, body = get_page(url)
        return status == 200 and expected_text in body
    except Exception:
        return False


def wait_for_region(marker, timeout):
    deadline = time.perf_counter() + timeout
    last_error = None

    while time.perf_counter() < deadline:
        try:
            status, body = get_page(TM_URL)

            if status == 200 and marker in body:
                return {
                    "recovered": True,
                    "elapsed_seconds": None,
                    "observed_at": utc_now(),
                    "error": None,
                }

            last_error = f"HTTP {status}; expected {marker}"

        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = str(exc)

        time.sleep(POLL_INTERVAL)

    return {
        "recovered": False,
        "elapsed_seconds": None,
        "observed_at": utc_now(),
        "error": last_error or "Recovery timeout",
    }


def wait_for_primary_restore(timeout):
    started = time.perf_counter()
    deadline = started + timeout
    last_error = None

    while time.perf_counter() < deadline:
        try:
            status, body = get_page(PRIMARY_URL)

            if status == 200 and "PRIMARY REGION" in body:
                return {
                    "restored": True,
                    "elapsed_seconds": round(
                        time.perf_counter() - started, 2
                    ),
                    "observed_at": utc_now(),
                    "error": None,
                }

            last_error = f"HTTP {status}; unexpected primary page"

        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = str(exc)

        time.sleep(POLL_INTERVAL)

    return {
        "restored": False,
        "elapsed_seconds": None,
        "observed_at": utc_now(),
        "error": last_error or "Primary restoration timeout",
    }


def save_failover_report(report):
    REPORTS.mkdir(parents=True, exist_ok=True)

    connection_string = os.environ.get(
        "AZURE_STORAGE_CONNECTION_STRING"
    )

    if not connection_string:
        report["azure_upload"] = {
            "uploaded": False,
            "error": "Storage connection is not configured.",
        }
    else:
        service = None

        try:
            service = TableServiceClient.from_connection_string(
                connection_string
            )
            table = service.get_table_client("DRTestLogs")

            table.upsert_entity({
                "PartitionKey": "failover_test",
                "RowKey": report["test_id"],
                "GeneratedAt": report["generated_at"],
                "TestType": "failover_test",
                "OverallStatus": (
                    "RECOVERED" if report["recovered"]
                    else "RECOVERY_UNCONFIRMED"
                ),
                "HealthyEndpoints": report["summary"]["healthy_endpoints"],
                "TotalEndpoints": report["summary"]["total_endpoints"],
                "ReportJson": json.dumps(report),
            })

            report["azure_upload"] = {
                "uploaded": True,
                "error": None,
            }

        except Exception:
            report["azure_upload"] = {
                "uploaded": False,
                "error": "Azure Table Storage upload failed.",
            }

        finally:
            if service is not None:
                service.close()

    report_path = REPORTS / f"failover-{report['test_id']}.json"
    report_path.write_text(
        json.dumps(report, indent=2),
        encoding="utf-8",
    )

    with (REPORTS / "dr-history.jsonl").open(
        "a", encoding="utf-8"
    ) as history_file:
        history_file.write(json.dumps(report) + "\n")


@app.get("/api/health")
def api_health():
    return {
        "api_status": "online",
        "generated_at": utc_now(),
    }


@app.get("/api/status")
def dashboard_status():
    report = read_json(REPORTS / "latest-report.json")

    if not report:
        return {
            "data_status": "unavailable",
            "message": "No readable health report found.",
            "report": None,
        }

    return {
        "data_status": "stored_report",
        "report": report,
    }


@app.get("/api/failover")
def failover_history():
    reports = []

    for path in REPORTS.glob("failover-*.json"):
        report = read_json(path)

        if report:
            reports.append(report)

    reports.sort(
        key=lambda item: item.get("generated_at", ""),
        reverse=True,
    )

    return {
        "count": len(reports),
        "reports": reports,
    }


def check_live_endpoint(endpoint):
    started = time.perf_counter()

    try:
        status, body = get_page(endpoint["url"], timeout=5)
        expected = endpoint["expected_text"]

        healthy = status == 200

        if expected:
            healthy = healthy and expected in body
        else:
            healthy = healthy and (
                "PRIMARY REGION" in body
                or "SECONDARY REGION" in body
            )

        observed_region = (
            "primary" if "PRIMARY REGION" in body
            else "secondary" if "SECONDARY REGION" in body
            else "unknown"
        )

        return {
            "endpoint": endpoint["endpoint"],
            "url": endpoint["url"],
            "healthy": healthy,
            "status_code": status,
            "latency_ms": round(
                (time.perf_counter() - started) * 1000, 2
            ),
            "observed_region": observed_region,
            "checked_at": utc_now(),
            "error": None,
        }

    except Exception as exc:
        return {
            "endpoint": endpoint["endpoint"],
            "url": endpoint["url"],
            "healthy": False,
            "status_code": None,
            "latency_ms": None,
            "observed_region": None,
            "checked_at": utc_now(),
            "error": str(exc),
        }


@app.get("/api/live")
def live_health_check():
    results = [
        check_live_endpoint(endpoint)
        for endpoint in LIVE_ENDPOINTS
    ]

    healthy_count = sum(item["healthy"] for item in results)

    return {
        "data_status": "live_check",
        "checked_at": utc_now(),
        "summary": {
            "total_endpoints": len(results),
            "healthy_endpoints": healthy_count,
            "unhealthy_endpoints": len(results) - healthy_count,
            "overall_status": (
                "READY" if healthy_count == len(results)
                else "DEGRADED"
            ),
        },
        "results": results,
    }


@app.get("/api/azure-logs")
def azure_logs():
    connection_string = os.environ.get(
        "AZURE_STORAGE_CONNECTION_STRING"
    )

    if not connection_string:
        return {
            "data_status": "unavailable",
            "message": (
                "Storage connection is not configured "
                "for the API process."
            ),
            "count": 0,
            "logs": [],
        }

    service = None

    try:
        service = TableServiceClient.from_connection_string(
            connection_string
        )
        table = service.get_table_client("DRTestLogs")

        entities = list(
            table.query_entities(
                query_filter="PartitionKey eq 'scheduled_health_check'",
                results_per_page=100,
            )
        )

        entities.sort(
            key=lambda item: str(item.get("GeneratedAt", "")),
            reverse=True,
        )

        logs = []

        for entity in entities[:50]:
            logs.append({
                "test_type": entity.get("TestType"),
                "status": entity.get("OverallStatus"),
                "generated_at": entity.get("GeneratedAt"),
                "healthy_endpoints": entity.get("HealthyEndpoints"),
                "total_endpoints": entity.get("TotalEndpoints"),
                "report_json": entity.get("ReportJson"),
            })

        return {
            "data_status": "connected",
            "source": "Azure Table Storage / DRTestLogs",
            "count": len(logs),
            "logs": logs,
        }

    except Exception:
        return {
            "data_status": "error",
            "message": (
                "Could not read Azure monitoring logs. "
                "Check storage access and table configuration."
            ),
            "count": 0,
            "logs": [],
        }

    finally:
        if service is not None:
            service.close()


@app.post("/api/failover/run")
def run_failover_test():
    if not failover_lock.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail="A failover test is already running.",
        )

    try:
        # Preflight: never deliberately interrupt an already unhealthy setup.
        for url, marker in [
            (PRIMARY_URL, "PRIMARY REGION"),
            (SECONDARY_URL, "SECONDARY REGION"),
        ]:
            if not check_endpoint_health(url, marker):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Preflight failed: {marker} page is not healthy. "
                        "No outage was initiated."
                    ),
                )

        if not check_endpoint_health(TM_URL, "PRIMARY REGION"):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Preflight failed: Traffic Manager is not serving "
                    "the primary page. No outage was initiated."
                ),
            )

        test_id = str(uuid.uuid4())
        outage_started_at = utc_now()
        outage_started = time.perf_counter()

        deallocation_requested = False
        recovered = False
        rto_seconds = None
        recovery_error = None

        restoration = {
            "restored": False,
            "elapsed_seconds": None,
            "observed_at": None,
            "error": "Not attempted",
        }

        try:
            # Set this first so cleanup still attempts startup if the
            # CLI command succeeds remotely but the client reports an error.
            deallocation_requested = True

            run_az(
                "vm", "deallocate",
                "--resource-group", PRIMARY_RG,
                "--name", PRIMARY_VM,
                "--no-wait",
                timeout=60,
            )

            deadline = time.perf_counter() + FAILOVER_TIMEOUT
            last_error = None

            while time.perf_counter() < deadline:
                try:
                    status, body = get_page(TM_URL)

                    if status == 200 and "SECONDARY REGION" in body:
                        recovered = True
                        rto_seconds = round(
                            time.perf_counter() - outage_started, 2
                        )
                        break

                    last_error = (
                        f"HTTP {status}; secondary page not yet served"
                    )

                except (urllib.error.URLError, TimeoutError, OSError) as exc:
                    last_error = str(exc)

                time.sleep(POLL_INTERVAL)

            if not recovered:
                recovery_error = last_error or "Recovery timed out"

        except Exception as exc:
            recovery_error = str(exc)

        finally:
            if deallocation_requested:
                deadline = time.perf_counter() + DEALLOCATION_TIMEOUT

                while time.perf_counter() < deadline:
                    try:
                        state = run_az(
                            "vm", "get-instance-view",
                            "--resource-group", PRIMARY_RG,
                            "--name", PRIMARY_VM,
                            "--query",
                            "instanceView.statuses[?contains(code, 'PowerState/')].displayStatus | [0]",
                            "--output", "tsv",
                            timeout=30,
                        ).stdout.strip()

                        if state == "VM deallocated":
                            break

                    except Exception:
                        pass

                    time.sleep(5)

                try:
                    run_az(
                        "vm", "start",
                        "--resource-group", PRIMARY_RG,
                        "--name", PRIMARY_VM,
                        timeout=RESTORE_TIMEOUT,
                    )
                    restoration = wait_for_primary_restore(
                        RESTORE_TIMEOUT
                    )

                except Exception:
                    restoration = {
                        "restored": False,
                        "elapsed_seconds": None,
                        "observed_at": utc_now(),
                        "error": (
                            "Primary startup or HTTP verification failed. "
                            "Check the VM in Azure Portal."
                        ),
                    }

        primary_healthy = check_endpoint_health(
            PRIMARY_URL, "PRIMARY REGION"
        )
        secondary_healthy = check_endpoint_health(
            SECONDARY_URL, "SECONDARY REGION"
        )
        traffic_manager_healthy = (
            check_endpoint_health(TM_URL, "PRIMARY REGION")
            or check_endpoint_health(TM_URL, "SECONDARY REGION")
        )

        healthy_count = sum([
            primary_healthy,
            secondary_healthy,
            traffic_manager_healthy,
        ])

        report = {
            "project": "multi-region-disaster-recovery",
            "test_id": test_id,
            "test_type": "failover_test",
            "generated_at": utc_now(),
            "outage_started_at": outage_started_at,
            "primary_deallocation_requested": deallocation_requested,
            "recovered": recovered,
            "rto_seconds": rto_seconds,
            "recovery_error": recovery_error,
            "primary_restoration": restoration,
            "endpoint_health": {
                "primary": primary_healthy,
                "secondary": secondary_healthy,
                "traffic_manager": traffic_manager_healthy,
            },
            "summary": {
                "total_endpoints": 3,
                "healthy_endpoints": healthy_count,
                "unhealthy_endpoints": 3 - healthy_count,
                "overall_status": (
                    "RECOVERED" if recovered
                    else "RECOVERY_UNCONFIRMED"
                ),
            },
        }

        save_failover_report(report)

        return {
            "test_status": "completed",
            "report": report,
            "message": (
                "Failover recovered and primary restoration confirmed."
                if recovered and restoration["restored"]
                else "Test finished. Review recovery and restoration results."
            ),
        }

    finally:
        failover_lock.release()