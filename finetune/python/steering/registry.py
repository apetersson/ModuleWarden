"""Versioned steering-vector registry - the defense layer that adapts without
retraining.

The model is fine-tuned once (the SFT run fixes its shape). The attack surface
is not fixed: new injection phrasings appear after the checkpoint is frozen.
Every steering vector lives here, keyed by attack family and versioned, so a
new attack is answered by registering a new vector - never by retraining the
weights.

An entry records not just the vector but the evidence that it is safe to ship:
the layer and coefficient it was validated at, the robustness gain it bought,
and the clean-accuracy delta it cost (the guardrail from decision-4). A vector
that helped against attack-vN but hurt clean accuracy is kept with
status='rejected' so the record of WHY it was not shipped survives.

Storage is a single JSON file (``registry.json``) under a directory. Vectors
are stored inline as float lists - portable, diffable, no numpy/torch needed to
READ the registry or its metadata. ``to_steering_vector`` lazily imports torch
only when an entry is actually applied, so a CI box without torch can still
inspect, audit, and diff the registry.

Reference: representation engineering / steering-vector libraries (Zou et al.,
Representation Engineering, arXiv:2310.01405; Turner et al., arXiv:2308.10248).
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from .activation_steering import SteeringVector

GENERATOR_VERSION = "adaptive-steering/1"

# Lifecycle of a registered vector.
STATUS_ACTIVE = "active"        # validated, shipped, applied at inference
STATUS_REJECTED = "rejected"    # failed the clean-accuracy guardrail; kept for the record
STATUS_DEPRECATED = "deprecated"  # superseded by a newer vector for the same key
_VALID_STATUS = {STATUS_ACTIVE, STATUS_REJECTED, STATUS_DEPRECATED}


def examples_hash(prompts: Sequence[str]) -> str:
    """Stable SHA-256 over the contrastive prompts a vector was built from, so
    two registrations from the same examples are identifiable and a vector can
    be traced back to its source set without storing the prompts in full."""
    h = hashlib.sha256()
    for p in prompts:
        h.update(p.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()[:16]


@dataclass
class RegistryEntry:
    """One versioned steering vector plus the evidence it is safe to ship."""
    key: str                      # attack family, e.g. "injection_resist" or "unicode_smuggle_v2"
    version: int                  # monotonic per key
    layer: int
    coefficient: float
    hidden_size: int
    vector: list[float]
    status: str = STATUS_ACTIVE
    generated_at: str = ""
    generator_version: str = GENERATOR_VERSION
    pos_hash: str = ""
    neg_hash: str = ""
    # Validation evidence (from calibrate.select_coefficient). All optional so a
    # hand-registered vector is still valid, but a shipped one should carry them.
    asr_before: float | None = None
    asr_after: float | None = None
    clean_accuracy_before: float | None = None
    clean_accuracy_after: float | None = None
    description: str = ""

    def to_steering_vector(self) -> SteeringVector:
        """Reconstruct a usable SteeringVector (lazy torch import)."""
        import torch

        v = torch.tensor(self.vector, dtype=torch.float32)
        return SteeringVector(
            vector=v, layer=self.layer, coefficient=self.coefficient,
            hidden_size=self.hidden_size,
        )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _vector_to_list(vector: Any) -> list[float]:
    """Accept a torch tensor, numpy array, or plain sequence; return a float
    list. No hard torch/numpy dependency - uses ``tolist`` when present."""
    if hasattr(vector, "tolist"):
        return [float(x) for x in vector.tolist()]
    return [float(x) for x in vector]


class SteeringRegistry:
    """JSON-backed registry of versioned steering vectors keyed by attack family."""

    def __init__(self, path: str):
        # ``path`` is the registry directory; the index is path/registry.json.
        self.dir = path
        self.index_path = os.path.join(path, "registry.json")
        self._entries: list[RegistryEntry] = []
        if os.path.exists(self.index_path):
            self._load()

    def _load(self) -> None:
        with open(self.index_path, encoding="utf-8") as fh:
            raw = json.load(fh)
        self._entries = [RegistryEntry(**e) for e in raw.get("entries", [])]

    def _save(self) -> None:
        os.makedirs(self.dir, exist_ok=True)
        payload = {
            "schema": "modulewarden.steering_registry.v1",
            "generator_version": GENERATOR_VERSION,
            "entries": [asdict(e) for e in self._entries],
        }
        tmp = self.index_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
        os.replace(tmp, self.index_path)  # atomic on POSIX + Windows

    def _next_version(self, key: str) -> int:
        versions = [e.version for e in self._entries if e.key == key]
        return (max(versions) + 1) if versions else 1

    def register(
        self,
        key: str,
        sv: SteeringVector,
        *,
        status: str = STATUS_ACTIVE,
        pos_prompts: Sequence[str] | None = None,
        neg_prompts: Sequence[str] | None = None,
        asr_before: float | None = None,
        asr_after: float | None = None,
        clean_accuracy_before: float | None = None,
        clean_accuracy_after: float | None = None,
        description: str = "",
        generated_at: str | None = None,
    ) -> RegistryEntry:
        """Register a new versioned vector for ``key``. If it is ACTIVE, any
        prior ACTIVE vector for the same key is auto-deprecated (one active
        vector per key at a time). Returns the stored entry."""
        if status not in _VALID_STATUS:
            raise ValueError(f"status must be one of {_VALID_STATUS}, got {status!r}")
        if status == STATUS_ACTIVE:
            for e in self._entries:
                if e.key == key and e.status == STATUS_ACTIVE:
                    e.status = STATUS_DEPRECATED
        entry = RegistryEntry(
            key=key,
            version=self._next_version(key),
            layer=sv.layer,
            coefficient=sv.coefficient,
            hidden_size=int(sv.hidden_size or len(_vector_to_list(sv.vector))),
            vector=_vector_to_list(sv.vector),
            status=status,
            generated_at=generated_at or _now_iso(),
            pos_hash=examples_hash(pos_prompts) if pos_prompts else "",
            neg_hash=examples_hash(neg_prompts) if neg_prompts else "",
            asr_before=asr_before,
            asr_after=asr_after,
            clean_accuracy_before=clean_accuracy_before,
            clean_accuracy_after=clean_accuracy_after,
            description=description,
        )
        self._entries.append(entry)
        self._save()
        return entry

    def get(self, key: str, *, status: str = STATUS_ACTIVE) -> RegistryEntry | None:
        """Latest entry for ``key`` with the given status (highest version)."""
        cands = [e for e in self._entries if e.key == key and e.status == status]
        return max(cands, key=lambda e: e.version) if cands else None

    def active_entries(self) -> list[RegistryEntry]:
        """All currently-active vectors (one per key) - the set an ensemble or
        a router would apply at inference."""
        latest: dict[str, RegistryEntry] = {}
        for e in self._entries:
            if e.status == STATUS_ACTIVE:
                latest[e.key] = e
        return list(latest.values())

    def deprecate(self, key: str, version: int) -> bool:
        """Mark a specific (key, version) deprecated. Returns True if found."""
        for e in self._entries:
            if e.key == key and e.version == version:
                e.status = STATUS_DEPRECATED
                self._save()
                return True
        return False

    def list_entries(self) -> list[RegistryEntry]:
        return list(self._entries)


__all__ = [
    "SteeringRegistry",
    "RegistryEntry",
    "examples_hash",
    "GENERATOR_VERSION",
    "STATUS_ACTIVE",
    "STATUS_REJECTED",
    "STATUS_DEPRECATED",
]
