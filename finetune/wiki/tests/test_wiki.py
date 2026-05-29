"""Tests for the ModuleWarden LLM-wiki (auditor + decepticon).

Covers: seeds produce valid nodes, the node parser round-trips the writer,
BM25 query returns relevant results, and the decepticon chain line wires
into the underwriter memo. Read-only over the demo JSON; no execution.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from finetune.wiki import nodes, query, seed_decepticon_wiki, seed_wiki

AUDITOR_DIR = REPO_ROOT / "finetune" / "wiki" / "auditor"
DECEPTICON_DIR = REPO_ROOT / "finetune" / "wiki" / "decepticon"


@pytest.fixture(scope="module", autouse=True)
def _seeded():
    """Ensure the nodes exist on disk before the assertions run."""
    seed_wiki.seed()
    seed_decepticon_wiki.seed()


# ---------------------------------------------------------------------------
# Node read/write round-trip
# ---------------------------------------------------------------------------


def test_frontmatter_round_trip():
    fields = {
        "node_type": "package",
        "name": "demo-pkg",
        "verdict": "block",
        "capability_signals": ["lifecycle_script", "network_access"],
        "attack_chain_depth": 3,
        "advisory_ids": [],
    }
    text = nodes.render_frontmatter(fields) + "\n\nbody text"
    parsed = nodes.parse_node(text)
    fm = parsed["frontmatter"]
    assert fm["name"] == "demo-pkg"
    assert fm["verdict"] == "block"
    assert fm["capability_signals"] == ["lifecycle_script", "network_access"]
    assert fm["attack_chain_depth"] == 3
    assert fm["advisory_ids"] == []
    assert "body text" in parsed["body"]


# ---------------------------------------------------------------------------
# Auditor seed
# ---------------------------------------------------------------------------


def test_auditor_seed_produces_three_package_nodes():
    pkg_dir = AUDITOR_DIR / "packages"
    files = sorted(p.name for p in pkg_dir.glob("*.md"))
    assert "postmark-mcp-1.0.16.md" in files
    assert "postmark-mcp-1.0.12.md" in files
    assert "lodash-4.17.21.md" in files
    assert len(files) >= 3


def test_auditor_block_node_is_valid():
    node = nodes.read_node(AUDITOR_DIR / "packages" / "postmark-mcp-1.0.16.md")
    fm = node["frontmatter"]
    assert fm["node_type"] == "package"
    assert fm["verdict"] == "block"
    assert "lifecycle_script" in fm["capability_signals"]
    assert "network_access" in fm["capability_signals"]
    assert fm["attack_chain_depth"] >= 3
    assert "Summary" in node["body"]
    assert "Key Evidence" in node["body"]


def test_auditor_index_rebuilt():
    index = (AUDITOR_DIR / "_index.md").read_text(encoding="utf-8")
    assert "postmark-mcp@1.0.16" in index
    assert "verdict=block" in index


# ---------------------------------------------------------------------------
# Decepticon seed
# ---------------------------------------------------------------------------


def test_decepticon_eight_technique_nodes():
    tech_dir = DECEPTICON_DIR / "techniques"
    files = sorted(p.stem for p in tech_dir.glob("*.md"))
    expected = {"T1005", "T1027", "T1041", "T1059", "T1059.007", "T1106", "T1195.002", "T1552.001"}
    assert set(files) == expected
    assert len(files) == 8


def test_decepticon_four_chain_nodes_with_rider_and_blast():
    chain_dir = DECEPTICON_DIR / "chains"
    files = sorted(p.stem for p in chain_dir.glob("*.md"))
    assert files == ["credential-thief", "crypto-miner", "supply-chain-pivot", "typosquat-operator"]
    node = nodes.read_node(chain_dir / "supply-chain-pivot.md")
    fm = node["frontmatter"]
    assert fm["insurance_rider"] == "cyber_extortion_and_data_breach"
    assert fm["estimated_blast_radius_usd"] == 15000000
    # chains carry preconditions, not detection_gaps (that is a technique field)
    assert "detection_gaps" not in fm
    assert isinstance(fm["preconditions"], list) and fm["preconditions"]


def test_technique_nodes_carry_detection_gaps():
    node = nodes.read_node(DECEPTICON_DIR / "techniques" / "T1041.md")
    fm = node["frontmatter"]
    assert fm["node_type"] == "technique"
    assert fm["technique_id"] == "T1041"
    gaps = fm["detection_gaps"]
    assert isinstance(gaps, list) and gaps
    joined = " ".join(gaps).lower()
    assert "websocket" in joined or "env" in joined


# ---------------------------------------------------------------------------
# BM25 query
# ---------------------------------------------------------------------------


def test_bm25_query_returns_block_node_for_postmark():
    hits = query.query_wiki(
        "postmark-mcp",
        ["lifecycle_script", "credential_or_env_access", "network_access"],
    )
    assert hits, "expected at least one hit"
    top = hits[0]
    assert top.name == "postmark-mcp"
    assert top.version == "1.0.16"
    assert top.verdict == "block"
    assert top.score > 0


def test_bm25_query_top_k_bounded():
    hits = query.query_wiki("postmark-mcp", ["lifecycle_script"], top_k=2)
    assert len(hits) <= 2


def test_bm25_query_unrelated_returns_no_noise():
    hits = query.query_wiki("totally-unrelated-zzz", ["nonexistent_signal_xyz"])
    assert hits == []


def test_render_wiki_context_block():
    hits = query.query_wiki("postmark-mcp", ["network_access"])
    ctx = query.render_wiki_context(hits)
    assert "<wiki_context>" in ctx
    assert "</wiki_context>" in ctx
    assert "postmark-mcp" in ctx


# ---------------------------------------------------------------------------
# Decepticon chain line wired into the underwriter memo
# ---------------------------------------------------------------------------


def test_decepticon_chain_line_for_curated_package():
    from chat import agent

    # event-stream@3.3.6 is in curated-threat-chains.json as supply_chain_pivot.
    dossier = {"package": {"name": "event-stream", "candidate_version": "3.3.6"}}
    line = agent._decepticon_chain_line("event-stream-3.3.6", dossier)
    assert line is not None
    assert "Chain pattern" in line
    assert "$15,000,000" in line
    assert "cyber_extortion_and_data_breach" in line


def test_decepticon_chain_line_none_for_benign_curated():
    from chat import agent

    # lodash is in curated but threat_actor=none -> no chain line.
    dossier = {"package": {"name": "lodash", "candidate_version": "4.17.21"}}
    line = agent._decepticon_chain_line("lodash-4.17.21", dossier)
    assert line is None


def test_decepticon_chain_line_fail_soft_for_unknown():
    from chat import agent

    dossier = {"package": {"name": "no-such-pkg", "candidate_version": "0.0.1"}}
    line = agent._decepticon_chain_line("no-such-pkg-0.0.1", dossier)
    assert line is None


def test_wiki_derived_is_valid_sft_source():
    from finetune.python.pipeline import sft_pair_builder

    assert "wiki_derived" in sft_pair_builder._VALID_SOURCES
