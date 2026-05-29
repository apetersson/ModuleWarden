"""MITRE ATT&CK kill-chain mapping for ModuleWarden audit findings.

This package maps a package's already-extracted STATIC signals
(capability_deltas in an audit dossier) to MITRE ATT&CK techniques and
orders them into a kill chain, so a verdict reads as an attack narrative an
underwriter can price.

Honesty note: this is ATT&CK taxonomy adoption, not a live Decepticon run.
Decepticon (the autonomous red-team framework that uses this same taxonomy)
is ModuleWarden's named offensive-validation roadmap partner - "the offense
to our defense." Nothing here executes package code, installs a tarball, or
runs Decepticon. It is a deterministic lookup over signals the dossier
already carries.
"""

from .mapper import map_capabilities_to_attack, kill_chain_narrative

__all__ = ["map_capabilities_to_attack", "kill_chain_narrative"]
