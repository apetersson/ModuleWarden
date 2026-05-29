"""BM25 retrieval over the auditor wiki nodes.

Given a package name plus a list of capability signals, returns the top-3
matching prior auditor nodes. The caller injects those node bodies into the
audit system prompt as a `<wiki_context>` block so the model sees confirmed
precedents with overlapping capability signals before judging a new dossier.

CRITICAL repo convention: rank_bm25 is imported at MODULE level, not inside
a function. A lazy import inside a function deadlocks anyio's event loop in
the MCP server context (documented in the repo's scoring.py history).

Read-only over markdown. No execution, no network.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rank_bm25 import BM25Okapi

try:
    from finetune.wiki.nodes import iter_node_files, read_node
except ImportError:  # pragma: no cover - direct-script fallback
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from finetune.wiki.nodes import iter_node_files, read_node

AUDITOR_DIR = Path(__file__).resolve().parent / "auditor"
PACKAGES_DIR = AUDITOR_DIR / "packages"

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


@dataclass
class WikiHit:
    name: str
    version: str
    verdict: str
    capability_signals: list[str]
    score: float
    body: str
    path: str


def _node_document(frontmatter: dict[str, Any], body: str) -> str:
    """Flatten a node into one searchable document string for BM25."""
    parts = [
        str(frontmatter.get("name", "")),
        str(frontmatter.get("verdict", "")),
        str(frontmatter.get("threat_actor_class", "")),
    ]
    parts.extend(frontmatter.get("capability_signals") or [])
    parts.extend(frontmatter.get("advisory_ids") or [])
    parts.append(body)
    return " ".join(parts)


def _load_corpus(wiki_dir: Path) -> list[dict[str, Any]]:
    docs: list[dict[str, Any]] = []
    for node_path in iter_node_files(wiki_dir):
        node = read_node(node_path)
        fm = node["frontmatter"]
        if fm.get("node_type") != "package":
            continue
        docs.append(
            {
                "frontmatter": fm,
                "body": node["body"],
                "document": _node_document(fm, node["body"]),
                "path": node_path,
            }
        )
    return docs


def query_wiki(
    package_name: str,
    capability_signals: list[str] | None = None,
    *,
    top_k: int = 3,
    wiki_dir: Path | None = None,
) -> list[WikiHit]:
    """Return the top-k auditor wiki nodes matching the query.

    The query string is the package name plus its capability signals. BM25
    ranks the node documents; results are returned highest-score-first.
    Nodes with a zero score are dropped so an unrelated query returns fewer
    than top_k rather than padding with noise.
    """
    wiki_dir = wiki_dir or PACKAGES_DIR
    capability_signals = capability_signals or []
    docs = _load_corpus(wiki_dir if wiki_dir.name == "packages" else wiki_dir)
    if not docs:
        return []

    tokenized_corpus = [_tokenize(d["document"]) for d in docs]
    bm25 = BM25Okapi(tokenized_corpus)
    query_terms = _tokenize(package_name + " " + " ".join(capability_signals))
    if not query_terms:
        return []
    scores = bm25.get_scores(query_terms)

    ranked = sorted(
        zip(docs, scores), key=lambda pair: pair[1], reverse=True
    )
    hits: list[WikiHit] = []
    for doc, score in ranked:
        if score <= 0:
            continue
        fm = doc["frontmatter"]
        hits.append(
            WikiHit(
                name=str(fm.get("name", "")),
                version=str(fm.get("version", "")),
                verdict=str(fm.get("verdict", "")),
                capability_signals=list(fm.get("capability_signals") or []),
                score=float(score),
                body=doc["body"],
                path=str(doc["path"]),
            )
        )
        if len(hits) >= top_k:
            break
    return hits


def render_wiki_context(hits: list[WikiHit]) -> str:
    """Render top hits into a `<wiki_context>` block for the system prompt."""
    if not hits:
        return ""
    lines = ["<wiki_context>", "Prior confirmed cases with matching capability signals:", ""]
    for h in hits:
        signals = ", ".join(h.capability_signals) or "none"
        lines.append(
            f"- {h.name}@{h.version} verdict={h.verdict} "
            f"signals=({signals})"
        )
    lines.append("</wiki_context>")
    return "\n".join(lines)


if __name__ == "__main__":
    import sys

    pkg = sys.argv[1] if len(sys.argv) > 1 else "postmark-mcp"
    caps = sys.argv[2:] or ["lifecycle_script", "credential_or_env_access", "network_access"]
    results = query_wiki(pkg, caps)
    print(f"Query: {pkg} {caps}")
    print(f"Top {len(results)} hit(s):")
    for r in results:
        print(f"  {r.name}@{r.version} verdict={r.verdict} score={r.score:.3f}")
