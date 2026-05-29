"""Lock the demo preflight contract into CI.

The preflight script is what stands between a drifted fixture and a broken
on-stage demo. These tests make fixture drift fail the build instead of the
pitch: if someone edits a report verdict or a dossier so the gate no longer
agrees, `run_preflight()` returns non-zero and CI goes red.
"""

from __future__ import annotations

import sys
from pathlib import Path

DEMO_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = DEMO_ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from demo.preflight import EXPECTED, run_preflight


def test_preflight_passes_clean():
    """The shipped fixtures must pass preflight (exit 0)."""
    assert run_preflight(quiet=True) == 0


def test_preflight_covers_the_three_pitch_incidents():
    """The contract must pin exactly the three slide-5 incidents."""
    assert set(EXPECTED) == {
        "postmark-mcp-1.0.16",
        "postmark-mcp-1.0.12",
        "lodash-4.17.21",
    }


def test_block_incident_is_never_effectively_allowed():
    """The compromised release must carry a non-allow effective verdict."""
    assert EXPECTED["postmark-mcp-1.0.16"]["effective"] == "block"
    # And the gate must independently flag it, so the demo holds even with
    # the model offline.
    assert EXPECTED["postmark-mcp-1.0.16"]["gate_must_fail"] is True


def test_proxy_probe_is_non_fatal(monkeypatch):
    """A down proxy must never fail preflight - the offline path is the demo."""
    # An unreachable proxy URL must still leave the run green.
    assert run_preflight(quiet=True, proxy_url="http://127.0.0.1:1") == 0
