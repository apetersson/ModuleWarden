"""Tests for the deterministic ATT&CK kill-chain mapper.

Guards: the mapper is deterministic, orders the chain initial-access ->
impact, never invents techniques for unknown capabilities, and produces the
expected chain for the real postmark-mcp-1.0.16 compromise.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

from finetune.python.decepticon.mapper import (
    kill_chain_narrative,
    map_capabilities_to_attack,
)


def test_postmark_compromise_maps_to_supply_chain_kill_chain():
    """The real compromised release must map to a supply-chain -> creds -> exfil chain."""
    caps = ["lifecycle_script", "credential_or_env_access", "network_access"]
    kc = kill_chain_narrative(caps)
    assert kc["technique_ids"][0] == "T1195.002"  # supply chain compromise leads
    assert "T1552.001" in kc["technique_ids"]  # credential access
    assert kc["technique_ids"][-1] == "T1041"  # exfiltration is the final phase
    assert kc["chain"].startswith("Initial Access")
    assert kc["chain"].endswith("Exfiltration")
    assert kc["depth"] >= 3


def test_chain_is_ordered_not_input_order():
    """Even if capabilities arrive out of order, the chain sequences correctly."""
    caps = ["network_access", "lifecycle_script", "credential_or_env_access"]
    kc = kill_chain_narrative(caps)
    assert kc["technique_ids"][0] == "T1195.002"
    assert kc["technique_ids"][-1] == "T1041"


def test_unknown_capabilities_are_skipped_not_guessed():
    steps = map_capabilities_to_attack(["totally_unknown_capability", "network_access"])
    ids = [s["technique_id"] for s in steps]
    assert ids == ["T1041"]


def test_empty_input_is_empty_chain():
    kc = kill_chain_narrative([])
    assert kc["steps"] == []
    assert kc["depth"] == 0
    assert kc["technique_ids"] == []


def test_handles_dict_shaped_capability_deltas():
    """capability_deltas in real dossiers are dicts with a 'capability' key."""
    caps = [
        {"capability": "lifecycle_script", "severity": "high"},
        {"capability": "network_access", "severity": "high"},
    ]
    kc = kill_chain_narrative(caps)
    assert kc["technique_ids"] == ["T1195.002", "T1041"]


def test_deterministic_repeatable():
    caps = ["network_access", "credential_or_env_access", "lifecycle_script"]
    assert kill_chain_narrative(caps) == kill_chain_narrative(caps)


def test_real_postmark_dossier_if_present():
    """Run the mapper over the actual demo dossier (no execution, JSON read only)."""
    p = REPO_ROOT / "demo" / "incidents" / "postmark-mcp-1.0.16.dossier.json"
    if not p.exists():
        return
    dossier = json.loads(p.read_text(encoding="utf-8"))
    kc = kill_chain_narrative(dossier.get("capability_deltas") or [])
    assert kc["depth"] >= 3
    assert "T1195.002" in kc["technique_ids"]
    assert "T1041" in kc["technique_ids"]
