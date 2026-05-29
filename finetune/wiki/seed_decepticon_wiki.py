"""Seed Decepticon's offensive wiki from curated-threat-chains.json + mapper.py.

Produces:
  - 8 technique nodes (one per distinct ATT&CK technique in mapper.py's
    _CAPABILITY_TO_ATTACK), each carrying a detection_gaps field.
  - 4 named chain nodes (supply-chain-pivot, credential-thief, crypto-miner,
    typosquat-operator) built from the curated attack_chain phases, each
    carrying insurance_rider + estimated_blast_radius_usd.
  - 1 threat-actor node per non-`none` threat_actor class.
  - Rebuilt decepticon/_index.md.

Reads mapper.py as a module (read-only import; never edited). Reads the
curated JSON read-only. No package execution, no network. Idempotent.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from finetune.wiki.nodes import write_node, iter_node_files, read_node
    from finetune.python.decepticon.mapper import _CAPABILITY_TO_ATTACK
except ImportError:  # pragma: no cover - direct-script fallback
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from finetune.wiki.nodes import write_node, iter_node_files, read_node
    from finetune.python.decepticon.mapper import _CAPABILITY_TO_ATTACK

REPO_ROOT = Path(__file__).resolve().parents[2]
CURATED = REPO_ROOT / "demo" / "curated-threat-chains.json"
DECEPTICON_DIR = Path(__file__).resolve().parent / "decepticon"
TECHNIQUES_DIR = DECEPTICON_DIR / "techniques"
CHAINS_DIR = DECEPTICON_DIR / "chains"
ACTORS_DIR = DECEPTICON_DIR / "threat-actors"

# Where mapper.py is currently blind. Authored offensive knowledge that
# feeds future _CAPABILITY_TO_ATTACK extension PRs (gap_reporter narrate-only).
_DETECTION_GAPS: dict[str, list[str]] = {
    "T1195.002": [
        "Lifecycle hooks added via npm config (.npmrc scripts-prepend) rather than package.json",
    ],
    "T1059.007": [
        "Payloads assembled from import.meta or dynamic import() are not matched as eval/Function",
    ],
    "T1059": [
        "Child processes spawned through a native addon rather than child_process",
    ],
    "T1106": [
        "WASM modules instantiated from a fetched ArrayBuffer with no .node/.wasm file on disk",
    ],
    "T1027": [
        "String entropy below the obfuscation threshold but split across many small modules",
    ],
    "T1552.001": [
        "Credentials read from a mounted secret file path rather than process.env",
        "Env-conditional credential reads that only fire under a specific CI variable",
    ],
    "T1005": [
        "Sensitive file reads proxied through a symlink that resolves outside the package dir",
    ],
    "T1041": [
        "Packages using WebSocket for exfil (no HTTP request pattern to match)",
        "Exfil only under specific env var conditions, invisible to a static scan",
    ],
}

# threat_actor class -> the four named chain slugs the task fixes.
_ACTOR_TO_CHAIN = {
    "supply_chain_pivot": "supply-chain-pivot",
    "credential_thief": "credential-thief",
    "crypto_miner": "crypto-miner",
    "typosquat_operator": "typosquat-operator",
}

# Capability signature each chain class typically exhibits, mapped to the
# mapper technique sequence. Deterministic, derived from the curated phases.
_CHAIN_TECHNIQUE_SEQUENCE: dict[str, list[str]] = {
    "supply-chain-pivot": ["T1195.002", "T1059.007", "T1552.001", "T1041"],
    "credential-thief": ["T1027", "T1059", "T1552.001", "T1041"],
    "crypto-miner": ["T1195.002", "T1059", "T1041"],
    "typosquat-operator": ["T1195.002", "T1059.007", "T1041"],
}


_TYPOGRAPHIC = {
    "—": " - ",  # em-dash
    "–": "-",     # en-dash
    "→": " to ",  # right arrow
    "←": " from ",  # left arrow
    "…": "...",   # ellipsis
    "‘": "'",
    "’": "'",
    "“": '"',
    "”": '"',
}


def _sanitize(text: str) -> str:
    """Strip typographic AI markers from source prose copied into node text."""
    for bad, good in _TYPOGRAPHIC.items():
        text = text.replace(bad, good)
    return text


def _curated() -> dict[str, dict[str, Any]]:
    if not CURATED.exists():
        return {}
    with CURATED.open(encoding="utf-8") as fh:
        return json.load(fh)


def _distinct_techniques() -> list[dict[str, Any]]:
    """One record per distinct technique_id, collecting the capability keys."""
    by_id: dict[str, dict[str, Any]] = {}
    for cap_key, entry in _CAPABILITY_TO_ATTACK.items():
        tid = entry["technique_id"]
        if tid not in by_id:
            by_id[tid] = {
                "technique_id": tid,
                "technique_name": entry["technique_name"],
                "tactic": entry["tactic"],
                "capability_keys": [cap_key],
                "procedure": entry["procedure"],
            }
        else:
            by_id[tid]["capability_keys"].append(cap_key)
    return [by_id[k] for k in sorted(by_id)]


def _seed_techniques(curated: dict[str, dict[str, Any]]) -> list[Path]:
    written: list[Path] = []
    # Build technique -> observed package@version map from the chains.
    tech_packages: dict[str, list[str]] = {tid: [] for tid in {e["technique_id"] for e in _CAPABILITY_TO_ATTACK.values()}}
    for pkgver, entry in curated.items():
        actor = entry.get("threat_actor") or "none"
        chain_slug = _ACTOR_TO_CHAIN.get(actor)
        if not chain_slug:
            continue
        for tid in _CHAIN_TECHNIQUE_SEQUENCE.get(chain_slug, []):
            if pkgver not in tech_packages.get(tid, []):
                tech_packages.setdefault(tid, []).append(pkgver)

    for rec in _distinct_techniques():
        tid = rec["technique_id"]
        gaps = _DETECTION_GAPS.get(tid, ["No documented gap for this technique yet."])
        observed_pkgs = tech_packages.get(tid, [])
        observed_chains = sorted(
            {
                f"[[../chains/{slug}]]"
                for slug, seq in _CHAIN_TECHNIQUE_SEQUENCE.items()
                if tid in seq
            }
        )
        fields = {
            "node_type": "technique",
            "technique_id": tid,
            "technique_name": rec["technique_name"],
            "tactic": rec["tactic"],
            "mapper_capability_key": rec["capability_keys"][0],
            "mapper_capability_keys": rec["capability_keys"],
            "observed_packages": [f"[[../../auditor/packages/{p.replace('@', '-')}]]" for p in observed_pkgs],
            "observed_chains": observed_chains,
            "detection_gaps": gaps,
            "variant_count": len(gaps),
            "last_updated": "2026-05-29",
        }
        body = (
            "## Technique Description\n\n"
            f"{rec['tactic']} via {rec['technique_name']} ({tid}). "
            f"{rec['procedure']}\n\n"
            "## Observed Package Instances\n\n"
            + (
                "\n".join(f"- {p}" for p in observed_pkgs)
                if observed_pkgs
                else "- None in the curated set."
            )
            + "\n\n## Detection Gaps\n\n"
            + "\n".join(f"- {g}" for g in gaps)
            + "\n\nWhere the current mapper.py lookup misses this technique. "
            "Feeds future _CAPABILITY_TO_ATTACK extension PRs; the mapper "
            "stays deterministic.\n\n"
            "## Procedure Variants\n\n"
            "Variants not yet covered by the procedure template in mapper.py."
        )
        node_path = TECHNIQUES_DIR / f"{tid}.md"
        write_node(node_path, fields, body)
        written.append(node_path)
    return written


def _seed_chains(curated: dict[str, dict[str, Any]]) -> list[Path]:
    written: list[Path] = []
    # Group curated entries by chain slug.
    by_chain: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for pkgver, entry in curated.items():
        actor = entry.get("threat_actor") or "none"
        slug = _ACTOR_TO_CHAIN.get(actor)
        if slug:
            by_chain.setdefault(slug, []).append((pkgver, entry))

    for slug in ("supply-chain-pivot", "credential-thief", "crypto-miner", "typosquat-operator"):
        members = by_chain.get(slug, [])
        # Representative entry carries the rider + blast radius for the memo.
        rep = members[0][1] if members else {}
        observed_packages = [pkgver for pkgver, _ in members]
        seq = _CHAIN_TECHNIQUE_SEQUENCE[slug]
        blast = max((e.get("estimated_blast_radius_usd", 0) for _, e in members), default=0)
        rider = rep.get("insurance_rider") or "cyber_extortion_and_data_breach"

        # Build the narrative from the curated attack_chain phases.
        narrative_lines: list[str] = []
        preconditions: list[str] = []
        for pkgver, entry in members:
            narrative_lines.append(f"### {pkgver}")
            for phase in entry.get("attack_chain") or []:
                narrative_lines.append(
                    _sanitize(
                        f"- [{phase.get('phase', '?')}] {phase.get('tool', '?')}: "
                        f"{phase.get('finding', '')}"
                    )
                )
        # Preconditions per chain class (offensive knowledge for the auditor).
        preconditions = _CHAIN_PRECONDITIONS.get(slug, [])

        fields = {
            "node_type": "chain",
            "chain_name": slug,
            "threat_actor_class": next(
                (a for a, s in _ACTOR_TO_CHAIN.items() if s == slug), slug
            ),
            "technique_sequence": seq,
            "depth": len(seq),
            "observed_packages": observed_packages,
            "estimated_blast_radius_usd": blast,
            "insurance_rider": rider,
            "preconditions": preconditions,
        }
        body = (
            "## Chain Narrative\n\n"
            + (
                "\n".join(narrative_lines)
                if narrative_lines
                else "No curated package mapped to this chain in the demo set."
            )
            + "\n\n## Preconditions for Auditor\n\n"
            "Fields the auditor model should look for to elevate suspicion "
            "when this chain is partially matched.\n\n"
            + (
                "\n".join(f"- {p}" for p in preconditions)
                if preconditions
                else "- None recorded."
            )
        )
        node_path = CHAINS_DIR / f"{slug}.md"
        write_node(node_path, fields, body)
        written.append(node_path)
    return written


_CHAIN_PRECONDITIONS: dict[str, list[str]] = {
    "supply-chain-pivot": [
        "Maintainer account accessible to attacker (ownership transfer or token reuse)",
        "Package has high weekly install count (supply-chain leverage)",
        "Downstream consumer matches a specific env or wallet pattern",
    ],
    "credential-thief": [
        "Compromised npm publish token bypassing 2FA",
        "Obfuscated loader hooks module._compile to intercept require()",
        "Reads ~/.npmrc or credential files at install or runtime",
    ],
    "crypto-miner": [
        "postinstall script fetches and executes a remote binary",
        "Download domain registered recently with no DNS history",
        "Mining runs only during the install window (low persistence)",
    ],
    "typosquat-operator": [
        "Sudden major version bump with no changelog or matching commits",
        "Author email shared with other malicious packages in the same campaign",
        "High-entropy minified blob that deobfuscates to a fetch+eval loop",
    ],
}


def _seed_actors(curated: dict[str, dict[str, Any]]) -> list[Path]:
    written: list[Path] = []
    seen: set[str] = set()
    for pkgver, entry in curated.items():
        actor = entry.get("threat_actor") or "none"
        if actor == "none" or actor in seen:
            continue
        seen.add(actor)
        chain_slug = _ACTOR_TO_CHAIN.get(actor, actor.replace("_", "-"))
        members = [pv for pv, e in curated.items() if (e.get("threat_actor") or "none") == actor]
        fields = {
            "node_type": "threat_actor",
            "actor_class": actor,
            "linked_chain": f"[[../chains/{chain_slug}]]",
            "observed_packages": members,
            "last_updated": "2026-05-29",
        }
        body = (
            "## Actor Class\n\n"
            f"`{actor}`. Offensive class abstracted from the curated campaign "
            "data; not a named individual.\n\n"
            "## Observed Packages\n\n"
            + "\n".join(f"- {m}" for m in members)
        )
        node_path = ACTORS_DIR / f"{actor.replace('_', '-')}.md"
        write_node(node_path, fields, body)
        written.append(node_path)
    return written


def _rebuild_index() -> None:
    rows = []
    for node_path in iter_node_files(DECEPTICON_DIR):
        node = read_node(node_path)
        fm = node["frontmatter"]
        rel = node_path.relative_to(DECEPTICON_DIR).as_posix()
        label = fm.get("technique_id") or fm.get("chain_name") or fm.get("actor_class") or "?"
        rows.append(f"- [[{rel}]] {fm.get('node_type', '?')}: {label}")
    content = (
        "---\nnode_type: index\nname: decepticon-wiki-index\n---\n\n"
        "# Decepticon Wiki Index\n\n"
        "Offensive knowledge graph. The defensive auditor consumes only what "
        "is derived from it, never this graph directly.\n\n"
        + "\n".join(rows)
        + "\n"
    )
    (DECEPTICON_DIR / "_index.md").write_text(content, encoding="utf-8")


def seed() -> dict[str, list[Path]]:
    """Seed all decepticon nodes. Returns a dict of category -> paths written."""
    curated = _curated()
    result = {
        "techniques": _seed_techniques(curated),
        "chains": _seed_chains(curated),
        "threat_actors": _seed_actors(curated),
    }
    _rebuild_index()
    return result


if __name__ == "__main__":
    res = seed()
    total = sum(len(v) for v in res.values())
    print(f"Seeded {total} decepticon wiki node(s):")
    for cat, paths in res.items():
        print(f"  {cat}: {len(paths)}")
        for p in paths:
            print(f"    {p.relative_to(REPO_ROOT)}")
