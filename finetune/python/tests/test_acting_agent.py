from __future__ import annotations

import pytest

from finetune.python.serving.acting_agent import (
    ActionPolicy,
    DEFAULT_POLICY,
    decide_action,
    summarize_decision,
)


def _dossier():
    return {
        "verdict": "block",
        "confidence": "high",
        "risk_level": "critical",
        "capability_deltas": [
            {"capability": "lifecycle_script"},
            {"capability": "network_access"},
        ],
    }


def test_low_probability_allows_with_no_attack_path():
    decision = decide_action(0.05, _dossier())
    assert decision["action"] == "allow"
    assert decision["attack_path"] is None
    assert decision["probability"] == pytest.approx(0.05)
    assert "0.050" in decision["reason"]


def test_high_probability_with_dossier_escalates_with_techniques():
    decision = decide_action(0.92, _dossier())
    assert decision["action"] == "escalate"
    assert decision["attack_path"] is not None
    assert decision["attack_path"]["technique_ids"]
    assert decision["attack_path"]["depth"] > 0


def test_mid_probability_quarantines():
    decision = decide_action(0.40, _dossier())
    assert decision["action"] == "quarantine"
    assert decision["attack_path"] is not None
    assert decision["attack_path"]["depth"] > 0


def test_high_probability_without_dossier_escalates_no_path():
    decision = decide_action(0.95)
    assert decision["action"] == "escalate"
    assert decision["attack_path"] is None


def test_quarantine_without_dossier_has_no_path():
    decision = decide_action(0.40)
    assert decision["action"] == "quarantine"
    assert decision["attack_path"] is None


def test_empty_capability_deltas_gives_no_path():
    dossier = {"capability_deltas": []}
    decision = decide_action(0.90, dossier)
    assert decision["action"] == "escalate"
    assert decision["attack_path"] is None


def test_boundary_at_allow_below_is_quarantine():
    decision = decide_action(DEFAULT_POLICY.allow_below)
    assert decision["action"] == "quarantine"


def test_just_below_allow_below_is_allow():
    decision = decide_action(DEFAULT_POLICY.allow_below - 0.0001)
    assert decision["action"] == "allow"


def test_boundary_at_escalate_above_is_escalate():
    decision = decide_action(DEFAULT_POLICY.escalate_above)
    assert decision["action"] == "escalate"


def test_just_below_escalate_above_is_quarantine():
    decision = decide_action(DEFAULT_POLICY.escalate_above - 0.0001)
    assert decision["action"] == "quarantine"


def test_probability_clamped_high():
    decision = decide_action(1.7)
    assert decision["probability"] == 1.0
    assert decision["action"] == "escalate"


def test_probability_clamped_low():
    decision = decide_action(-0.5)
    assert decision["probability"] == 0.0
    assert decision["action"] == "allow"


def test_custom_policy_bands():
    policy = ActionPolicy(allow_below=0.30, escalate_above=0.70)
    assert decide_action(0.25, None, policy)["action"] == "allow"
    assert decide_action(0.50, None, policy)["action"] == "quarantine"
    assert decide_action(0.80, None, policy)["action"] == "escalate"


def test_plain_string_capability_deltas():
    dossier = {"capability_deltas": ["lifecycle_script", "network_access"]}
    decision = decide_action(0.90, dossier)
    assert decision["attack_path"] is not None
    assert decision["attack_path"]["technique_ids"]


def test_policy_rejects_allow_above_escalate():
    with pytest.raises(ValueError):
        ActionPolicy(allow_below=0.70, escalate_above=0.30)


def test_policy_rejects_negative_threshold():
    with pytest.raises(ValueError):
        ActionPolicy(allow_below=-0.1, escalate_above=0.5)


def test_policy_rejects_threshold_above_one():
    with pytest.raises(ValueError):
        ActionPolicy(allow_below=0.5, escalate_above=1.5)


def test_summarize_includes_chain_when_present():
    decision = decide_action(0.92, _dossier())
    line = summarize_decision(decision)
    assert "ESCALATE" in line
    assert "ATT&CK path" in line
    assert ("T1059" in line) or ("T1041" in line)


def test_summarize_no_chain_when_absent():
    decision = decide_action(0.05, _dossier())
    line = summarize_decision(decision)
    assert "ALLOW" in line
    assert "ATT&CK path" not in line


# --- band-driven review routing (#1b) ------------------------------------


def test_band_does_not_change_action():
    # A wide band on a clearly-allow probability must stay "allow".
    narrow = decide_action(0.05, None, band=(0.04, 0.06))
    wide = decide_action(0.05, None, band=(0.01, 0.95))
    assert narrow["action"] == "allow"
    assert wide["action"] == "allow"


def test_wide_band_routes_to_human_and_raises_urgency():
    decision = decide_action(0.05, None, band=(0.01, 0.95))
    assert decision["route_to_human"] is True
    assert decision["review_urgency"] == "urgent"
    assert decision["band_width"] == pytest.approx(0.94)


def test_narrow_band_allow_is_routine_no_human():
    decision = decide_action(0.05, None, band=(0.04, 0.06))
    assert decision["route_to_human"] is False
    assert decision["review_urgency"] == "routine"


def test_no_band_quarantine_still_routes_to_human():
    decision = decide_action(0.40, None)
    assert decision["band_width"] is None
    assert decision["route_to_human"] is True


def test_band_reversed_bounds_are_normalized():
    # high, low passed backwards still yields the same width.
    decision = decide_action(0.05, None, band=(0.95, 0.01))
    assert decision["band_width"] == pytest.approx(0.94)
    assert decision["route_to_human"] is True


def test_summarize_includes_review_urgency_for_wide_band():
    decision = decide_action(0.05, None, band=(0.01, 0.95))
    line = summarize_decision(decision)
    assert "review urgent" in line
    assert "forecast band" in line
