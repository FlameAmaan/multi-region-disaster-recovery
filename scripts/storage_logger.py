import json
import os
from datetime import datetime, timezone

from azure.data.tables import TableServiceClient


def upload_report(report):
    connection_string = os.environ.get(
        "AZURE_STORAGE_CONNECTION_STRING"
    )

    if not connection_string:
        raise RuntimeError(
            "AZURE_STORAGE_CONNECTION_STRING is not configured"
        )

    service = TableServiceClient.from_connection_string(
        connection_string
    )

    try:
        table = service.get_table_client("DRTestLogs")

        summary = report.get("summary", {})

        entity = {
            "PartitionKey": report.get("test_type", "health_check"),
            "RowKey": report["test_id"],
            "TestType": report.get("test_type", "health_check"),
            "OverallStatus": summary.get("overall_status", "UNKNOWN"),
            "GeneratedAt": report["generated_at"],
            "HealthyEndpoints": summary.get("healthy_endpoints", 0),
            "TotalEndpoints": summary.get("total_endpoints", 0),
            "ReportJson": json.dumps(report),
        }

        table.upsert_entity(entity=entity)
        return entity["RowKey"]
    finally:
        service.close()


if __name__ == "__main__":
    import uuid

    now = datetime.now(timezone.utc).isoformat()

    test_report = {
        "test_id": str(uuid.uuid4()),
        "test_type": "storage_smoke_test",
        "generated_at": now,
        "summary": {
            "overall_status": "STORAGE_OK",
            "healthy_endpoints": 0,
            "total_endpoints": 0,
        },
        "message": "Azure Table Storage connectivity test",
    }

    row_key = upload_report(test_report)
    print("Azure Table Storage write successful")
    print(f"Test record ID: {row_key}")
