import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from storage_logger import upload_report

PRIMARY_RG = "rg-dr-primary-indiasouthcentral"
PRIMARY_VM = "vm-dr-primary"
PRIMARY_URL = "http://172.198.68.165"
SECONDARY_URL = "http://20.235.89.90"
TM_URL = "http://amaan-mrdr-2026.trafficmanager.net"

REPORT_DIR = Path(__file__).resolve().parent.parent / "reports"
FAILOVER_TIMEOUT = 240
RESTORE_TIMEOUT = 300
POLL_INTERVAL = 2


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def get_page(url, timeout=8):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "DR-Failover-Validator/1.0"},
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



def wait_for_region(marker, timeout):
    started = time.perf_counter()
    deadline = started + timeout
    last_error = None

    while time.perf_counter() < deadline:
        try:
            status, body = get_page(TM_URL)
            if status == 200 and marker in body:
                return {
                    "recovered": True,
                    "elapsed_seconds": round(
                        time.perf_counter() - started, 2
                    ),
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

def check_endpoint_health(url, expected_text):
    try:
        status, body = get_page(url)
        return status == 200 and expected_text in body
    except Exception:
        return False

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


def main():
    print("Preflight: checking both regional web servers...")

    for url, marker in [
        (PRIMARY_URL, "PRIMARY REGION"),
        (SECONDARY_URL, "SECONDARY REGION"),
    ]:
        status, body = get_page(url)
        if status != 200 or marker not in body:
            raise RuntimeError(
                f"Preflight failed for {url}. No outage initiated."
            )

    baseline = wait_for_region("PRIMARY REGION", 45)
    if not baseline["recovered"]:
        raise RuntimeError(
            "Traffic Manager did not serve the primary reliably. "
            "No outage initiated."
        )

    endpoints = run_az(
        "network", "traffic-manager", "endpoint", "list",
        "--resource-group", PRIMARY_RG,
        "--profile-name", "tm-dr-amaan-web",
        "--type", "azureEndpoints",
        "--output", "json",
    )
    endpoint_data = json.loads(endpoints.stdout)
    health = {
        item["name"]: item.get("endpointMonitorStatus")
        for item in endpoint_data
    }

    if (
        health.get("primary-endpoint") != "Online"
        or health.get("secondary-endpoint") != "Online"
    ):
        raise RuntimeError(
            f"Traffic Manager preflight failed: {health}. "
            "No outage initiated."
        )

    print("Preflight passed. Both web servers and endpoints are healthy.")
    print("This test will deliberately deallocate the PRIMARY VM.")
    if input("Type FAILOVER to proceed: ").strip() != "FAILOVER":
        print("Cancelled. No outage initiated.")
        return

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
        print("Requesting primary VM deallocation...")
        run_az(
            "vm", "deallocate",
            "--resource-group", PRIMARY_RG,
            "--name", PRIMARY_VM,
            "--no-wait",
        )
        deallocation_requested = True

        print("Polling Traffic Manager for the secondary page...")
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
                    print(f"Secondary confirmed after {rto_seconds}s")
                    break
                last_error = f"HTTP {status}; secondary not yet served"
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = str(exc)

            time.sleep(POLL_INTERVAL)

        if not recovered:
            recovery_error = last_error or "Failover recovery timed out"
            print(f"Recovery not confirmed: {recovery_error}")

    except Exception as exc:
        recovery_error = str(exc)
        print(f"Failover test error: {exc}")

    finally:
        if deallocation_requested:
            print("Cleanup: waiting for primary deallocation to finish...")
            deadline = time.perf_counter() + 180

            while time.perf_counter() < deadline:
                try:
                    state = run_az(
                        "vm", "get-instance-view",
                        "--resource-group", PRIMARY_RG,
                        "--name", PRIMARY_VM,
                        "--query",
                        "instanceView.statuses[?contains(code, 'PowerState/')].displayStatus | [0]",
                        "--output", "tsv",
                    ).stdout.strip()

                    if state == "VM deallocated":
                        break
                except Exception:
                    pass

                time.sleep(5)

            print("Cleanup: requesting primary VM startup...")
            try:
                run_az(
                    "vm", "start",
                    "--resource-group", PRIMARY_RG,
                    "--name", PRIMARY_VM,
                    timeout=RESTORE_TIMEOUT,
                )
                restoration = wait_for_primary_restore(RESTORE_TIMEOUT)
            except Exception as exc:
                restoration = {
                    "restored": False,
                    "elapsed_seconds": None,
                    "observed_at": utc_now(),
                    "error": str(exc),
                }

            print(f"Primary restored: {restoration['restored']}")

    
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

    healthy_endpoints = sum([
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
            "healthy_endpoints": healthy_endpoints,
            "unhealthy_endpoints": 3 - healthy_endpoints,
            "overall_status": (
                "RECOVERED" if recovered else "RECOVERY_UNCONFIRMED"
            ),
        },
    }


    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / f"failover-{test_id}.json"
    report_path.write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )

    with (REPORT_DIR / "dr-history.jsonl").open(
        "a", encoding="utf-8"
    ) as history_file:
        history_file.write(json.dumps(report) + "\n")

    try:
        upload_report(report)
        print("Azure Table Storage: UPLOAD SUCCESSFUL")
    except Exception as exc:
        print(f"Azure Table Storage upload failed: {exc}")

    print(f"Report: {report_path}")
    print(f"Test ID: {test_id}")
    print(f"Observed RTO: {rto_seconds} seconds")
    print(f"Primary restored: {restoration['restored']}")

    if not restoration["restored"]:
        print("WARNING: Check primary VM and web page manually.")


if __name__ == "__main__":
    main()
