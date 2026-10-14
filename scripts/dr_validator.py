import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from storage_logger import upload_report

ENDPOINTS = {
    "primary": "http://172.198.68.165",
    "secondary": "http://20.235.89.90",
    "traffic_manager": "http://amaan-mrdr-2026.trafficmanager.net",
}

EXPECTED_CONTENT = {
    "primary": "PRIMARY REGION",
    "secondary": "SECONDARY REGION",
    "traffic_manager": None,
}

REPORT_DIR = Path(__file__).resolve().parent.parent / "reports"


def check_endpoint(name, url):
    started = time.perf_counter()

    try:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "DR-Validator/1.0"},
        )

        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8", errors="replace")
            expected = EXPECTED_CONTENT[name]

            if name == "traffic_manager":
                content_valid = (
                    "PRIMARY REGION" in body
                    or "SECONDARY REGION" in body
                )
            else:
                content_valid = expected in body

            return {
                "endpoint": name,
                "url": url,
                "healthy": response.status == 200 and content_valid,
                "status_code": response.status,
                "latency_ms": round(
                    (time.perf_counter() - started) * 1000, 2
                ),
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "error": None if content_valid else "Unexpected response content",
                "observed_region": (
                    "primary" if "PRIMARY REGION" in body
                    else "secondary" if "SECONDARY REGION" in body
                    else None
                ),
            }

    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {
            "endpoint": name,
            "url": url,
            "healthy": False,
            "status_code": None,
            "latency_ms": round(
                (time.perf_counter() - started) * 1000, 2
            ),
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "error": str(exc),
            "observed_region": None,
        }


def main():
    test_id = str(uuid.uuid4())
    generated_at = datetime.now(timezone.utc).isoformat()
    results = [
        check_endpoint(name, url)
        for name, url in ENDPOINTS.items()
    ]

    healthy_count = sum(result["healthy"] for result in results)
    total_count = len(results)

    report = {
        "project": "multi-region-disaster-recovery",
        "test_id": test_id,
        "test_type": "endpoint_health_check",
        "generated_at": generated_at,
        "results": results,
        "summary": {
            "total_endpoints": total_count,
            "healthy_endpoints": healthy_count,
            "unhealthy_endpoints": total_count - healthy_count,
            "overall_status": (
                "READY" if healthy_count == total_count else "DEGRADED"
            ),
        },
        "rto_seconds": None,
        "rto_note": "Not measured during a routine health check.",
    }

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / "latest-report.json"
    history_path = REPORT_DIR / "dr-history.jsonl"

    for result in results:
        status = "HEALTHY" if result["healthy"] else "UNHEALTHY"
        print(
            f'{result["endpoint"].upper()}: {status} '
            f'| latency={result["latency_ms"]} ms'
        )
        if result["error"]:
            print(f'  Error: {result["error"]}')

    print(
        f'\nDR STATUS: {report["summary"]["overall_status"]} '
        f'({healthy_count}/{total_count} endpoints healthy)'
    )

    storage_error = None

    try:
        upload_report(report)
        print("Azure Table Storage: UPLOAD SUCCESSFUL")
    except Exception as exc:
        storage_error = str(exc)
        print(f"Azure Table Storage: UPLOAD FAILED ({storage_error})")

    report["storage"] = {
        "uploaded": storage_error is None,
        "error": storage_error,
    }

    report_path.write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )

    with history_path.open("a", encoding="utf-8") as history_file:
        history_file.write(json.dumps(report) + "\n")

    print(f"Report saved to: {report_path}")
    print(f"History saved to: {history_path}")
    print(f"Test ID: {test_id}")

    if storage_error:
        sys.exit(1)


if __name__ == "__main__":
    main()
