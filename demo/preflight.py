"""Pre-pitch preflight: fail-loud gate over the live-demo path.

Run this before every demo and before walking on stage. It automates the
manual checklist in demo/README.md and exits non-zero the instant anything
the audience would see is wrong, so a broken fixture is caught backstage
instead of in front of judges.

What it checks (all offline, zero network, zero docker):

1. The three pitch incidents are discoverable.
2. Each incident's MODEL verdict matches the verdict we claim on stage
   (postmark-mcp-1.0.16 -> block, the two clean releases -> allow). This is
   the load-bearing claim of the demo; a drift here is a stage-killer.
3. The deterministic gate agrees independently: the compromised release
   raises at least one FAIL row (so the gate would quarantine it on its
   own, even with the model offline), and the clean releases raise zero
   FAIL rows (so we are not stamping BLOCK on everything).
4. The verdict-pinning invariant holds: a model `block` is never softened.
   The gate may only ever be equal-or-stricter than the model.
5. The Control Evidence Memo writes and contains its required sections.

Optional, non-fatal:

6. Probe the production api-proxy health endpoint. If it is up, the live
   `npm install -> 403` moment is available; if not, the offline CLI path
   above is the demo and that is fine. A down proxy is reported, never a
   failure, because the offline path is the bulletproof one.

Usage:

    python -m demo.preflight                 # full preflight, exit 0/1
    python -m demo.preflight --quiet         # only the final verdict line
    python -m demo.preflight --proxy-url http://localhost:8080
"""

from __future__ import annotations

import argparse
import sys
import urllib.error
import urllib.request
from pathlib import Path

from demo.run_incident_replay import (
    OUTPUTS_DIR,
    _available_incidents,
    _gate_verdict,
    _load_paired_fixture,
    _run_deterministic_gate,
    _write_evidence_memo,
)

# The contract the audience sees on stage. Keyed by incident id.
#   model_verdict: what the cited audit report must say.
#   gate_must_fail: the deterministic gate must raise >=1 FAIL row.
#   gate_verdict: what the deterministic gate (model-independent) must return.
#   effective: the stricter of (gate, model) - what actually governs the
#   install. The gate may escalate (quarantine on FAIL) and the model may
#   escalate further (block on confirmed compromise); the strictest wins.
EXPECTED = {
    "postmark-mcp-1.0.16": {
        "model_verdict": "block",
        "gate_must_fail": True,
        "gate_verdict": "quarantine",
        "effective": "block",
    },
    "postmark-mcp-1.0.12": {
        "model_verdict": "allow",
        "gate_must_fail": False,
        "gate_verdict": "allow",
        "effective": "allow",
    },
    "lodash-4.17.21": {
        "model_verdict": "allow",
        "gate_must_fail": False,
        "gate_verdict": "allow",
        "effective": "allow",
    },
}

# Ordered least-to-most strict. The effective verdict is the strictest of the
# gate action and the model verdict.
_STRICTNESS = {"allow": 0, "quarantine": 1, "block": 2}


def _check(label: str, ok: bool, detail: str, failures: list[str], quiet: bool) -> None:
    mark = "PASS" if ok else "FAIL"
    if not quiet or not ok:
        print(f"  [{mark}] {label}: {detail}")
    if not ok:
        failures.append(f"{label}: {detail}")


def run_preflight(quiet: bool = False, proxy_url: str | None = None) -> int:
    failures: list[str] = []

    if not quiet:
        print("ModuleWarden demo preflight")
        print("=" * 60)

    # 1. Catalog present.
    available = set(_available_incidents())
    for incident_id in EXPECTED:
        _check(
            f"discoverable {incident_id}",
            incident_id in available,
            "found" if incident_id in available else "MISSING fixture pair",
            failures,
            quiet,
        )

    # 2-5. Per-incident gate + verdict + memo.
    for incident_id, want in EXPECTED.items():
        if incident_id not in available:
            continue  # already recorded as a failure above
        try:
            dossier, report = _load_paired_fixture(incident_id)
        except Exception as exc:  # fixture unreadable / schema-broken
            _check(f"load {incident_id}", False, f"could not load: {exc}", failures, quiet)
            continue

        gate = _run_deterministic_gate(dossier)
        gate_action = _gate_verdict(gate)
        fail_rules = [r.rule for r in gate if r.status == "FAIL"]
        model_verdict = (report.get("verdict") or "unknown").lower()

        # 2. Model verdict matches the on-stage claim.
        _check(
            f"model verdict {incident_id}",
            model_verdict == want["model_verdict"],
            f"got {model_verdict!r}, expect {want['model_verdict']!r}",
            failures,
            quiet,
        )

        # 3. Gate agrees independently.
        if want["gate_must_fail"]:
            _check(
                f"gate independent flag {incident_id}",
                len(fail_rules) >= 1,
                f"FAIL rows={fail_rules or 'NONE (gate did not flag a known-bad release)'}",
                failures,
                quiet,
            )
        else:
            _check(
                f"gate clean {incident_id}",
                len(fail_rules) == 0,
                f"FAIL rows={fail_rules} (expected none on a clean release)",
                failures,
                quiet,
            )
        _check(
            f"gate action {incident_id}",
            gate_action == want["gate_verdict"],
            f"got {gate_action!r}, expect {want['gate_verdict']!r}",
            failures,
            quiet,
        )

        # 4. Effective-verdict invariant: the strictest of (gate, model)
        #    governs, and a known-bad release is never effectively allowed.
        gate_strict = _STRICTNESS.get(gate_action, 0)
        model_strict = _STRICTNESS.get(model_verdict, 0)
        effective = (
            gate_action if gate_strict >= model_strict else model_verdict
        )
        _check(
            f"effective verdict {incident_id}",
            effective == want["effective"],
            f"strictest(gate={gate_action}, model={model_verdict})={effective}, expect {want['effective']!r}",
            failures,
            quiet,
        )
        if want["effective"] != "allow":
            _check(
                f"known-bad never allowed {incident_id}",
                gate_action != "allow" and model_verdict != "allow",
                f"gate={gate_action} model={model_verdict} (neither may be 'allow' for a known-bad release)",
                failures,
                quiet,
            )

        # 5. Memo writes and carries its sections.
        try:
            memo_path = _write_evidence_memo(
                incident_id, dossier, report, gate, OUTPUTS_DIR / "preflight"
            )
            memo_text = Path(memo_path).read_text(encoding="utf-8")
            has_sections = (
                "verdict:" in memo_text.lower()
                and "Deterministic policy gate" in memo_text
                and "Control Evidence Memo" in memo_text
            )
            _check(
                f"memo {incident_id}",
                has_sections,
                f"wrote {Path(memo_path).name}"
                if has_sections
                else "memo missing verdict/incident sections",
                failures,
                quiet,
            )
        except Exception as exc:
            _check(f"memo {incident_id}", False, f"memo write failed: {exc}", failures, quiet)

    # 6. Optional proxy probe (never fatal).
    if proxy_url:
        status = _probe_proxy(proxy_url)
        if not quiet:
            print(f"  [INFO] api-proxy {proxy_url}: {status}")

    if not quiet:
        print("=" * 60)
        print(f"outputs dir: {OUTPUTS_DIR}")

    if failures:
        print(f"PREFLIGHT FAILED ({len(failures)} issue(s)) - do not go on stage:")
        for f in failures:
            print(f"  - {f}")
        return 1

    print(f"PREFLIGHT OK - {len(EXPECTED)} incidents verified, demo path is green.")
    return 0


def _probe_proxy(proxy_url: str) -> str:
    """Best-effort health probe. Returns a human string, never raises."""
    for path in ("/health", "/healthz", "/-/ping", "/"):
        try:
            with urllib.request.urlopen(proxy_url.rstrip("/") + path, timeout=2) as resp:
                return f"UP (HTTP {resp.status} on {path}) - live npm-install demo available"
        except urllib.error.HTTPError as exc:
            # A 4xx still proves something is listening.
            return f"UP (HTTP {exc.code} on {path}) - service responding"
        except Exception:
            continue
    return "DOWN - use the offline CLI path (this is the bulletproof demo)"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ModuleWarden demo preflight")
    parser.add_argument("--quiet", action="store_true", help="only print the final verdict line")
    parser.add_argument(
        "--proxy-url",
        default=None,
        help="optional api-proxy base URL to health-probe (non-fatal)",
    )
    args = parser.parse_args(argv)
    return run_preflight(quiet=args.quiet, proxy_url=args.proxy_url)


if __name__ == "__main__":
    raise SystemExit(main())
