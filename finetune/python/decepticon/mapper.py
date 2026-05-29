"""Deterministic capability -> MITRE ATT&CK kill-chain mapper.

Input: a list of capability_delta keys from an audit dossier (the static
signals ModuleWarden already extracts - lifecycle scripts, credential/env
reads, network egress, etc.). Output: an ordered ATT&CK kill chain.

No execution. No network. No Decepticon process. Pure dictionary lookup over
signals the dossier already carries. The technique ids are authoritative
(deterministic); a downstream model narrates them but cannot change them -
the same pinning discipline that protects the verdict.

Capability keys are the ones the corpus actually uses (verified against
finetune/corpus/sft-records.jsonl): network_access, process_execution,
native_or_wasm, credential_or_env_access, filesystem_sensitive_access,
dynamic_code_execution, obfuscation, lifecycle_script. behavioral_change_runtime
appears in some dossiers and is mapped too.
"""

from __future__ import annotations

from typing import Any

# Each capability maps to one ATT&CK technique plus the kill-chain phase it
# occupies. `order` sequences the narrative from initial access to impact.
# (tactic, technique_id, technique_name, order, procedure-template)
_CAPABILITY_TO_ATTACK: dict[str, dict[str, Any]] = {
    "lifecycle_script": {
        "tactic": "Initial Access",
        "technique_id": "T1195.002",
        "technique_name": "Compromise Software Supply Chain: Compromise Software Dependencies and Development Tools",
        "order": 10,
        "procedure": "A new install/postinstall lifecycle hook runs attacker code at dependency install time, before any application code executes.",
    },
    "dynamic_code_execution": {
        "tactic": "Execution",
        "technique_id": "T1059.007",
        "technique_name": "Command and Scripting Interpreter: JavaScript",
        "order": 20,
        "procedure": "The package evaluates code assembled at runtime (eval/Function), so the payload is not visible in the published source.",
    },
    "process_execution": {
        "tactic": "Execution",
        "technique_id": "T1059",
        "technique_name": "Command and Scripting Interpreter",
        "order": 21,
        "procedure": "The package spawns a child process or shell, executing commands outside the Node runtime.",
    },
    "native_or_wasm": {
        "tactic": "Execution",
        "technique_id": "T1106",
        "technique_name": "Native API",
        "order": 22,
        "procedure": "The package loads a native addon or WASM module, executing compiled code the static JS scan cannot read.",
    },
    "obfuscation": {
        "tactic": "Defense Evasion",
        "technique_id": "T1027",
        "technique_name": "Obfuscated Files or Information",
        "order": 30,
        "procedure": "Payload strings or logic are obfuscated to evade source review and signature scanners.",
    },
    "credential_or_env_access": {
        "tactic": "Credential Access",
        "technique_id": "T1552.001",
        "technique_name": "Unsecured Credentials: Credentials In Files",
        "order": 40,
        "procedure": "The package reads environment variables or credential files (tokens, .npmrc, cloud keys) available to the install/runtime context.",
    },
    "filesystem_sensitive_access": {
        "tactic": "Collection",
        "technique_id": "T1005",
        "technique_name": "Data from Local System",
        "order": 50,
        "procedure": "The package reads sensitive local files beyond its own package directory.",
    },
    "behavioral_change_runtime": {
        "tactic": "Execution",
        "technique_id": "T1059",
        "technique_name": "Command and Scripting Interpreter",
        "order": 23,
        "procedure": "Runtime behavior diverges from the prior release in a way not explained by the changelog.",
    },
    "network_access": {
        "tactic": "Exfiltration",
        "technique_id": "T1041",
        "technique_name": "Exfiltration Over C2 Channel",
        "order": 60,
        "procedure": "The package opens an undeclared outbound connection, the path by which read credentials or data leave the host.",
    },
}


def _capability_keys(capability_deltas: list[Any]) -> list[str]:
    """Pull capability keys out of dossier capability_deltas (robust to shape)."""
    keys: list[str] = []
    for c in capability_deltas or []:
        if isinstance(c, dict):
            k = c.get("capability") or c.get("name")
            if k:
                keys.append(k)
        elif isinstance(c, str):
            keys.append(c)
    return keys


def map_capabilities_to_attack(capability_deltas: list[Any]) -> list[dict[str, Any]]:
    """Map capability_deltas to an ordered list of ATT&CK technique dicts.

    Returns a kill chain ordered initial-access -> impact. Unknown
    capabilities are skipped (never guessed). Deterministic; no execution.
    """
    seen: set[str] = set()
    steps: list[dict[str, Any]] = []
    for key in _capability_keys(capability_deltas):
        entry = _CAPABILITY_TO_ATTACK.get(key)
        if entry is None or entry["technique_id"] in seen:
            continue
        seen.add(entry["technique_id"])
        steps.append(
            {
                "capability": key,
                "tactic": entry["tactic"],
                "technique_id": entry["technique_id"],
                "technique_name": entry["technique_name"],
                "procedure": entry["procedure"],
                "_order": entry["order"],
            }
        )
    steps.sort(key=lambda s: s["_order"])
    for s in steps:
        s.pop("_order", None)
    return steps


def kill_chain_narrative(capability_deltas: list[Any]) -> dict[str, Any]:
    """Build a structured kill-chain object for the report / underwriter memo.

    Shape:
      {
        "steps": [ {tactic, technique_id, technique_name, procedure}, ... ],
        "technique_ids": ["T1195.002", "T1552.001", "T1041"],
        "chain": "Initial Access -> Credential Access -> Exfiltration",
        "depth": 3,
        "source": "mitre_attck_deterministic_map",
      }
    `depth` is how many kill-chain phases the package reaches - a natural
    severity signal (deeper chain = stronger loss path).
    """
    steps = map_capabilities_to_attack(capability_deltas)
    tactics_in_order: list[str] = []
    for s in steps:
        if s["tactic"] not in tactics_in_order:
            tactics_in_order.append(s["tactic"])
    return {
        "steps": steps,
        "technique_ids": [s["technique_id"] for s in steps],
        "chain": " -> ".join(tactics_in_order),
        "depth": len(tactics_in_order),
        "source": "mitre_attck_deterministic_map",
    }
