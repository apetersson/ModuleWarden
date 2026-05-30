"""Authorized verification of our Sybilion integration against the live API.

Confirms that the numbers and shapes the pitch claims actually reproduce, using
ONLY the documented endpoints with our own API key. Read-only by default: it
hits the free GET endpoints (/health, /me, /jobs, /usage, /regions,
/categories) and asserts the documented response shapes. The billed POST
endpoints are gated behind an explicit, off-by-default flag and a second
confirmation, so this script never spends money by accident.

This is the authorized way to verify: participant API access covers calling the
documented endpoints. It does not probe, enumerate, or touch anything
undocumented.

Key handling: the API key is read from the SYBILION_API_TOKEN environment
variable. It is never hardcoded. If your key was ever pasted into a chat or a
file, rotate it in the portal first, then export the new one.

Usage:
    export SYBILION_API_TOKEN=lin_...        # the rotated key
    python -m finetune.python.serving.verify_sybilion          # free reads only
    python -m finetune.python.serving.verify_sybilion --json   # machine output

    # billed checks are opt-in and require BOTH flags:
    python -m finetune.python.serving.verify_sybilion --billed --yes-i-will-spend

Pure standard library (urllib). No third-party deps, no network unless run.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://api.sybilion.dev"
JOB_STATUSES = {"queued", "running", "completed", "failed", "canceled"}
BILLED_ENDPOINTS = {"forecast", "drivers", "alerts"}


def _get(path: str, token: str | None, timeout: float = 20.0) -> tuple[int, object]:
    """GET a path; return (status_code, parsed_json_or_text)."""
    url = path if path.startswith("http") else BASE + path
    req = urllib.request.Request(url, method="GET")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            code = resp.getcode()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        code = e.code
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"error": str(e)}
    try:
        return code, json.loads(body)
    except json.JSONDecodeError:
        return code, body


class Check:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, name: str, ok: bool, detail: str) -> None:
        self.rows.append({"check": name, "ok": ok, "detail": detail})

    @property
    def passed(self) -> bool:
        return all(r["ok"] for r in self.rows)


def verify_reads(token: str) -> Check:
    """Exercise the free, documented GET endpoints and assert their shapes."""
    c = Check()

    # 1. /health (unauthenticated)
    code, body = _get("/health", token=None)
    ok = code == 200 and isinstance(body, dict) and "overall" in body
    c.add("GET /health", ok, f"status={code} overall={body.get('overall') if isinstance(body, dict) else body!r}")

    # 2. /api/v1/me -> balance fields the budget claim relies on
    code, body = _get("/api/v1/me", token)
    has_balance = isinstance(body, dict) and "available_eur_cents" in body
    c.add(
        "GET /api/v1/me",
        code == 200 and has_balance,
        f"status={code} available_eur_cents={body.get('available_eur_cents') if isinstance(body, dict) else body!r}",
    )

    # 3. /api/v1/jobs -> eur_cents_final, status enum (the ~3-cent cost claim)
    code, body = _get("/api/v1/jobs?limit=5", token)
    jobs = body.get("jobs", []) if isinstance(body, dict) else []
    settled = [j for j in jobs if j.get("eur_cents_final") is not None]
    status_ok = all((j.get("status") in JOB_STATUSES) for j in jobs)
    sample_cost = settled[0]["eur_cents_final"] if settled else None
    c.add(
        "GET /api/v1/jobs",
        code == 200 and isinstance(jobs, list) and status_ok,
        f"status={code} n_jobs={len(jobs)} sample_eur_cents_final={sample_cost}",
    )

    # 4. /api/v1/usage -> billed endpoint keys
    code, body = _get("/api/v1/usage?limit=5", token)
    events = body.get("usage_events", []) if isinstance(body, dict) else []
    endpoints = {e.get("endpoint") for e in events if e.get("endpoint")}
    unknown = endpoints - BILLED_ENDPOINTS
    c.add(
        "GET /api/v1/usage",
        code == 200 and isinstance(events, list),
        f"status={code} n_events={len(events)} endpoints={sorted(endpoints)}"
        + (f" UNKNOWN={sorted(unknown)}" if unknown else ""),
    )

    # 5. /regions and /categories -> integer-id catalogs
    for path in ("/api/v1/regions", "/api/v1/categories"):
        code, body = _get(path, token)
        items = body.get("items", []) if isinstance(body, dict) else []
        ok = code == 200 and isinstance(items, list) and (not items or "id" in items[0])
        c.add(f"GET {path}", ok, f"status={code} n_items={len(items)}")

    return c


def verify_billed(token: str) -> Check:
    """Opt-in: confirm the alerts response shape we built sybilion_alerts on.

    Billed. Only runs behind --billed --yes-i-will-spend. POST /alerts is
    synchronous and cheap, and it is the shape (pct_change, trending, news)
    that sybilion_alerts.py consumes, so verifying it reproduces is the most
    relevant billed check.
    """
    c = Check()
    payload = {
        "metadata": {
            "title": "npm package adoption trajectory verification probe",
            "keywords": ["npm", "package", "adoption"],
        },
        "context_enriched": False,
        "filters": {"limit": 5},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE + "/api/v1/alerts", data=data, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=40.0) as resp:
            code = resp.getcode()
            body = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        code = e.code
        body = e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        c.add("POST /api/v1/alerts", False, f"transport error: {e}")
        return c

    alerts = body.get("alerts", []) if isinstance(body, dict) else []
    shape_ok = all(("pct_change" in a and "trending" in a) for a in alerts) if alerts else True
    c.add(
        "POST /api/v1/alerts",
        code == 200 and isinstance(alerts, list) and shape_ok,
        f"status={code} n_alerts={len(alerts)} shape_ok={shape_ok}",
    )
    return c


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Authorized verification of the Sybilion integration.")
    p.add_argument("--billed", action="store_true", help="also run the billed POST /alerts check")
    p.add_argument("--yes-i-will-spend", action="store_true", help="required confirmation for --billed")
    p.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = p.parse_args(argv)

    token = os.environ.get("SYBILION_API_TOKEN")
    if not token:
        print(
            "SYBILION_API_TOKEN is not set. Export your (rotated) key first:\n"
            "    export SYBILION_API_TOKEN=...\n"
            "The script never embeds the key.",
            file=sys.stderr,
        )
        return 2

    checks = verify_reads(token)

    if args.billed:
        if not args.yes_i_will_spend:
            print(
                "Refusing to run billed checks without --yes-i-will-spend. "
                "POST /alerts is a billed call.",
                file=sys.stderr,
            )
            return 2
        billed = verify_billed(token)
        checks.rows.extend(billed.rows)

    if args.json:
        print(json.dumps({"passed": checks.passed, "checks": checks.rows}, indent=2))
    else:
        for r in checks.rows:
            badge = "PASS" if r["ok"] else "FAIL"
            print(f"  [{badge}] {r['check']:<26} {r['detail']}")
        print(f"\n  {'all checks passed' if checks.passed else 'SOME CHECKS FAILED'}")

    return 0 if checks.passed else 1


if __name__ == "__main__":
    sys.exit(main())
