"""Live advisory lookups for arbitrary npm packages (read-only, metadata only).

Turns the "I have no dossier for that package" shrug into a real answer: when
an underwriter types any package name, hit two authoritative live sources and
report what they say.

  - GitHub Advisory Database (GHSA) REST API: reviewed + malware advisories
    for the npm ecosystem. https://api.github.com/advisories
  - OSSF malicious-packages feed: confirmed-malicious package reports
    (MAL-YYYY-NNNN). https://github.com/ossf/malicious-packages

SAFETY: stdlib urllib only. These are read-only HTTPS GETs for JSON METADATA.
Nothing here downloads a tarball, installs a package, or executes any code.
A malicious package name is only ever looked up as a string. Every call is
timeout-bounded and fail-soft: a network error returns
``{"available": False, ...}`` and never raises into the chat or the demo.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

_UA = "ModuleWarden-UnderwriterAssistant/0.1 (+https://github.com/apetersson/ModuleWarden)"
_GHSA_API = "https://api.github.com/advisories"
_OSSF_CONTENTS = "https://api.github.com/repos/ossf/malicious-packages/contents/osv/malicious/npm/"


def _get_json(url: str, timeout: float) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def check_ghsa(package: str, timeout: float = 8.0) -> dict[str, Any]:
    """Query the GHSA REST API for npm advisories affecting `package`.

    Returns {available, count, malware_count, max_severity, advisories:[...]}.
    Fail-soft: returns {available: False, error} on any failure.
    """
    q = urllib.parse.urlencode({"ecosystem": "npm", "affects": package, "per_page": 10})
    try:
        rows = _get_json(f"{_GHSA_API}?{q}", timeout)
    except Exception as exc:  # network, rate-limit, parse - never raise into the chat
        return {"available": False, "error": f"{type(exc).__name__}: {str(exc)[:80]}"}
    if not isinstance(rows, list):
        return {"available": False, "error": "unexpected GHSA response shape"}
    sev_rank = {"low": 1, "medium": 2, "high": 3, "critical": 4}
    advisories = []
    malware = 0
    max_sev = ""
    for r in rows:
        if not isinstance(r, dict):
            continue
        sev = (r.get("severity") or "").lower()
        if r.get("type") == "malware":
            malware += 1
        if sev_rank.get(sev, 0) > sev_rank.get(max_sev, 0):
            max_sev = sev
        advisories.append(
            {
                "ghsa_id": r.get("ghsa_id"),
                "summary": (r.get("summary") or "")[:160],
                "severity": sev,
                "type": r.get("type"),
            }
        )
    return {
        "available": True,
        "count": len(advisories),
        "malware_count": malware,
        "max_severity": max_sev or None,
        "advisories": advisories,
    }


def check_ossf_malicious(package: str, timeout: float = 8.0) -> dict[str, Any]:
    """Check the OSSF malicious-packages feed for confirmed-malicious reports.

    The feed stores one directory per flagged package with MAL-*.json reports.
    A 200 listing means the package is flagged; 404 means not flagged.
    Fail-soft. Scoped packages (@scope/name) are path-encoded.
    """
    path = urllib.parse.quote(package, safe="")  # @scope/name -> %40scope%2Fname
    try:
        rows = _get_json(f"{_OSSF_CONTENTS}{path}", timeout)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {"available": True, "malicious": False, "reports": []}
        return {"available": False, "error": f"HTTP {exc.code}"}
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {str(exc)[:80]}"}
    reports = []
    if isinstance(rows, list):
        reports = [r.get("name") for r in rows if isinstance(r, dict) and str(r.get("name", "")).startswith("MAL-")]
    return {"available": True, "malicious": bool(reports), "reports": reports}


def live_check(package: str, timeout: float = 8.0) -> dict[str, Any]:
    """Combine GHSA + OSSF into one structured result for the chat/memo."""
    ghsa = check_ghsa(package, timeout=timeout)
    ossf = check_ossf_malicious(package, timeout=timeout)
    return {"package": package, "ghsa": ghsa, "ossf": ossf}
