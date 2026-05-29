"""Shared node read/write helpers for the ModuleWarden LLM-wiki.

Nodes are markdown files: a YAML front-matter block delimited by `---`,
followed by a prose body. We emit a deliberately small YAML subset
(scalars + flat string lists) so the writer never needs PyYAML and the
output stays stable across runs. The reader is tolerant of the same
subset and ignores anything it does not recognise.

Read-only over JSON/markdown. No package execution, no network.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def _emit_scalar(value: Any) -> str:
    """Render a scalar front-matter value. Quote strings that need it."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if text == "" or any(ch in text for ch in ':#"') or text.strip() != text:
        escaped = text.replace('"', '\\"')
        return f'"{escaped}"'
    return text


def render_frontmatter(fields: dict[str, Any]) -> str:
    """Render an ordered dict of fields into a YAML front-matter block.

    Supports scalars and flat lists of scalars. Empty lists render as `[]`.
    """
    lines: list[str] = ["---"]
    for key, value in fields.items():
        if isinstance(value, list):
            if not value:
                lines.append(f"{key}: []")
                continue
            lines.append(f"{key}:")
            for item in value:
                lines.append(f"  - {_emit_scalar(item)}")
        else:
            lines.append(f"{key}: {_emit_scalar(value)}")
    lines.append("---")
    return "\n".join(lines)


def write_node(path: Path, fields: dict[str, Any], body: str) -> None:
    """Write a node file: front-matter block + a prose body."""
    path.parent.mkdir(parents=True, exist_ok=True)
    content = render_frontmatter(fields) + "\n\n" + body.strip() + "\n"
    path.write_text(content, encoding="utf-8")


def _parse_scalar(raw: str) -> Any:
    raw = raw.strip()
    if raw == "[]":
        return []
    if raw in ("true", "false"):
        return raw == "true"
    if (raw.startswith('"') and raw.endswith('"')) or (
        raw.startswith("'") and raw.endswith("'")
    ):
        return raw[1:-1].replace('\\"', '"')
    if raw.lstrip("-").isdigit():
        return int(raw)
    return raw


def parse_node(text: str) -> dict[str, Any]:
    """Parse a node file into ``{"frontmatter": {...}, "body": "..."}``.

    Tolerant of the small YAML subset the writer emits. Unknown shapes are
    kept as raw strings rather than raising.
    """
    frontmatter: dict[str, Any] = {}
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            block = parts[1]
            body = parts[2].lstrip("\n")
            current_key: str | None = None
            for line in block.splitlines():
                if not line.strip():
                    continue
                if line.lstrip().startswith("- ") and current_key is not None:
                    val = _parse_scalar(line.lstrip()[2:])
                    existing = frontmatter.get(current_key)
                    if isinstance(existing, list):
                        existing.append(val)
                    else:
                        frontmatter[current_key] = [val]
                    continue
                if ":" in line and not line.startswith(" "):
                    key, _, rest = line.partition(":")
                    key = key.strip()
                    rest = rest.strip()
                    current_key = key
                    if rest == "":
                        frontmatter[key] = []
                    else:
                        frontmatter[key] = _parse_scalar(rest)
    return {"frontmatter": frontmatter, "body": body}


def read_node(path: Path) -> dict[str, Any]:
    """Read and parse a node file from disk."""
    return parse_node(path.read_text(encoding="utf-8"))


def iter_node_files(directory: Path) -> list[Path]:
    """Return node markdown files in a wiki tree, skipping `_` meta files."""
    if not directory.exists():
        return []
    return sorted(
        p
        for p in directory.rglob("*.md")
        if not p.name.startswith("_")
    )


__all__ = [
    "render_frontmatter",
    "write_node",
    "parse_node",
    "read_node",
    "iter_node_files",
]
