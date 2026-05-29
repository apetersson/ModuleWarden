"""Acting agent for the Sybilion forecasting product.

Sybilion forecasts a calibrated probability that an internal code or
dependency submission introduces a supply-chain compromise. This module is
the agent layer that acts on that forecast. It turns a probability into a
discrete action through a threshold policy, and when the action escalates it
attaches the MITRE ATT&CK attack path so a human reviewer sees how the
compromise would unfold.

The two threat personas behind a high forecast are the disgruntled employee
(intentional) and the lazy employee who pulls an unvetted GitHub dependency
tree (negligent). Either way the underwriter sees one action plus an optional
kill-chain narrative.

The module is dependency-light. It imports only the standard library and the
existing ATT&CK mapper. No model, GPU, or network is required.
"""

from __future__ import annotations

from dataclasses import dataclass

from finetune.python.decepticon.mapper import kill_chain_narrative

__all__ = [
    "ActionPolicy",
    "DEFAULT_POLICY",
    "decide_action",
    "summarize_decision",
]


@dataclass
class ActionPolicy:
    """Threshold policy for turning a probability into an action.

    A probability below allow_below is allowed. A probability at or above
    escalate_above is escalated. Anything in the band between the two is
    quarantined for review.
    """

    allow_below: float = 0.15
    escalate_above: float = 0.60

    def __post_init__(self) -> None:
        if not (0 <= self.allow_below <= self.escalate_above <= 1):
            raise ValueError(
                "thresholds must satisfy "
                "0 <= allow_below <= escalate_above <= 1, got "
                f"allow_below={self.allow_below}, "
                f"escalate_above={self.escalate_above}"
            )


DEFAULT_POLICY = ActionPolicy()


def _clamp01(value: float) -> float:
    """Clamp a probability to the closed interval [0, 1]."""
    if value < 0:
        return 0.0
    if value > 1:
        return 1.0
    return float(value)


def decide_action(
    probability: float,
    dossier: dict | None = None,
    policy: ActionPolicy = DEFAULT_POLICY,
) -> dict:
    """Decide what to do about a compromise probability.

    Returns a dict with action, probability, reason, and attack_path.

    action is "allow" when the probability is below policy.allow_below,
    "escalate" when it is at or above policy.escalate_above, and
    "quarantine" otherwise. The probability is clamped to [0, 1] first.

    attack_path is populated only when the action is "escalate" or
    "quarantine" and the dossier carries a non-empty capability_deltas list.
    In that case kill_chain_narrative is called and the result is attached
    only if its depth is greater than 0. Otherwise attack_path is None.
    """
    prob = _clamp01(probability)

    if prob < policy.allow_below:
        action = "allow"
        reason = (
            f"probability {prob:.3f} is below allow threshold "
            f"{policy.allow_below:.3f}; allowing submission"
        )
    elif prob >= policy.escalate_above:
        action = "escalate"
        reason = (
            f"probability {prob:.3f} is at or above escalate threshold "
            f"{policy.escalate_above:.3f}; escalating for human action"
        )
    else:
        action = "quarantine"
        reason = (
            f"probability {prob:.3f} is in the quarantine band "
            f"[{policy.allow_below:.3f}, {policy.escalate_above:.3f}); "
            f"holding for review"
        )

    attack_path = None
    if action in ("escalate", "quarantine") and dossier:
        deltas = dossier.get("capability_deltas")
        if deltas:
            narrative = kill_chain_narrative(deltas)
            if narrative.get("depth", 0) > 0:
                attack_path = narrative

    return {
        "action": action,
        "probability": prob,
        "reason": reason,
        "attack_path": attack_path,
    }


def summarize_decision(decision: dict) -> str:
    """Render one human line for the underwriter or reviewer memo.

    Includes the ATT&CK chain string when an attack_path is present.
    """
    action = decision.get("action", "unknown")
    prob = decision.get("probability", 0.0)
    line = f"[{action.upper()}] compromise probability {prob:.1%}"

    attack_path = decision.get("attack_path")
    if attack_path:
        chain = attack_path.get("chain") or ""
        tids = attack_path.get("technique_ids") or []
        if chain:
            line += f"; ATT&CK path: {chain}"
        if tids:
            line += f" ({', '.join(tids)})"

    return line
