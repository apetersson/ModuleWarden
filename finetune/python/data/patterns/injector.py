"""Inject attack patterns from the YAML catalog into benign npm packages.

The PatternInjector class loads `attack-catalog.yaml` (written by a sibling
agent) and applies templated malicious payloads to benign package directories
to produce labeled training examples.

A pattern entry in the catalog is expected to have at minimum:

    id: <string>                       # unique pattern id, e.g. "install-exfil-01"
    severity: <int 1..10>              # used by the sampler as a weight
    description: <string>              # human-readable
    inject:
      files:                           # files to add to the package
        - path: "src/util.js"
          content: "...template..."
      modify:                          # existing files to mutate
        - path: "package.json"
          op: "merge_json"
          patch: {"scripts": {"postinstall": "node src/util.js"}}
    template_variables:                # optional template vars to randomize
      - name: "C2_HOST"
        choices: ["evil.example.com", "exfil.test", "host-{rand}.io"]
    diversity_strategies:              # optional list of strategy keys
      - "rename_identifiers"
      - "swap_http_libs"
      - "relocate_payload"

The class is intentionally tolerant: missing optional fields fall back to
sensible defaults so a minimal catalog still works.
"""

from __future__ import annotations

import json
import logging
import random
import re
import string
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_TEMPLATE_VAR = re.compile(r"\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}")
_RAND_TOKEN = re.compile(r"\{rand(?::(\d+))?\}")

# Common JS identifier patterns we want to leave alone when renaming.
_JS_RESERVED = frozenset(
    [
        "var", "let", "const", "function", "return", "if", "else", "for",
        "while", "do", "switch", "case", "break", "continue", "new", "this",
        "typeof", "instanceof", "in", "of", "true", "false", "null", "undefined",
        "try", "catch", "finally", "throw", "class", "extends", "super",
        "import", "export", "from", "default", "async", "await", "yield",
        "require", "module", "exports", "process", "console", "Buffer",
        "global", "setTimeout", "setInterval", "JSON", "Math", "Date",
        "Array", "Object", "String", "Number", "Boolean", "Promise", "Error",
        "RegExp", "Map", "Set", "Symbol",
    ]
)

# Names we are willing to rename. Catalog templates should prefix locally-scoped
# identifiers with `_p_` so we have a safe rename surface without touching API
# names or stdlib calls. Catalog authors that ignore this hint just get fewer
# diversity mutations.
_RENAME_PREFIX = "_p_"

# String severity tags carried over from earlier catalog revisions. The
# numeric severity is what the sampler weights by, so we coerce on load
# rather than make every catalog author re-tag every entry.
_SEVERITY_LABEL_TO_INT: dict[str, int] = {
    "info": 1,
    "low": 3,
    "medium": 5,
    "moderate": 5,
    "high": 7,
    "severe": 8,
    "critical": 9,
    "catastrophic": 10,
}


def _coerce_severity(value: Any) -> int:
    """Accept either int severity or one of the string labels above."""
    if isinstance(value, bool):
        return 5
    if isinstance(value, int):
        return max(1, min(10, value))
    if isinstance(value, float):
        return max(1, min(10, int(round(value))))
    if isinstance(value, str):
        lookup = _SEVERITY_LABEL_TO_INT.get(value.strip().lower())
        if lookup is not None:
            return lookup
        # Fall through: try numeric string ("7", "9").
        try:
            return max(1, min(10, int(value)))
        except ValueError:
            return 5
    return 5


def _normalize_inject_block(entry: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Bridge the compact catalog schema to the classic inject block.

    The bundled catalog stores patterns in a compact form:
      injection_template_js: <single template string>
      injection_target_files: [path1, path2, ...]

    The classic form (and the form `apply_pattern` expects) is:
      inject.files: [{path, content}, ...]
      inject.modify: [{path, op, patch}, ...]

    This function accepts either shape and returns the (files, modify)
    pair in the classic form.
    """
    classic = entry.get("inject")
    if isinstance(classic, dict) and (classic.get("files") or classic.get("modify")):
        return (
            list(classic.get("files") or []),
            list(classic.get("modify") or []),
        )

    # The bundled catalog has per-language template keys: js / py / php.
    # Treat them all the same way - the language only affects what the
    # benign-corpus traversal pairs the pattern with.
    template = (
        entry.get("injection_template_js")
        or entry.get("injection_template_py")
        or entry.get("injection_template_php")
        or entry.get("injection_template")
    )
    targets = entry.get("injection_target_files") or []
    if isinstance(template, str) and targets:
        files = [
            {"path": str(t), "content": template}
            for t in targets
            if isinstance(t, str)
        ]
        modify = []
        # A postinstall-shaped pattern typically also needs a package.json
        # hook; if the pattern declares one explicitly carry it through.
        pj_hook = entry.get("package_json_hook")
        if isinstance(pj_hook, dict):
            modify.append({"path": "package.json", "op": "merge_json", "patch": pj_hook})
        return (files, modify)

    return ([], [])


@dataclass
class Pattern:
    """A single attack pattern parsed from the YAML catalog."""

    id: str
    severity: int = 5
    description: str = ""
    inject_files: list[dict[str, Any]] = field(default_factory=list)
    modify_files: list[dict[str, Any]] = field(default_factory=list)
    template_variables: list[dict[str, Any]] = field(default_factory=list)
    diversity_strategies: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


class CatalogError(ValueError):
    """Raised when the attack catalog is structurally invalid."""


class PatternInjector:
    """Loads the attack catalog and injects patterns into benign packages."""

    def __init__(self, catalog_path: str | Path) -> None:
        self.catalog_path = Path(catalog_path)
        if not self.catalog_path.exists():
            raise FileNotFoundError(
                f"Attack catalog not found at {self.catalog_path}. "
                "The catalog file is produced by the catalog-author agent; "
                "make sure that step has run before invoking the injector."
            )
        self.patterns: dict[str, Pattern] = self._load_catalog(self.catalog_path)
        logger.info(
            "Loaded %d patterns from %s", len(self.patterns), self.catalog_path
        )

    # ------------------------------------------------------------------
    # Catalog loading
    # ------------------------------------------------------------------

    @staticmethod
    def _load_catalog(path: Path) -> dict[str, Pattern]:
        with path.open("r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)
        if not isinstance(raw, dict):
            raise CatalogError(f"Catalog root must be a mapping, got {type(raw)}")
        entries = raw.get("patterns") or raw.get("attacks") or []
        if not isinstance(entries, list):
            raise CatalogError("Catalog 'patterns' key must be a list")
        out: dict[str, Pattern] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            pid = entry.get("id")
            if not pid:
                logger.warning("Skipping catalog entry with no id: %r", entry)
                continue
            inject_files, modify_files = _normalize_inject_block(entry)
            pat = Pattern(
                id=str(pid),
                severity=_coerce_severity(entry.get("severity", 5)),
                description=str(entry.get("description", "")),
                inject_files=inject_files,
                modify_files=modify_files,
                template_variables=list(entry.get("template_variables", []) or []),
                diversity_strategies=list(entry.get("diversity_strategies", []) or []),
                raw=entry,
            )
            out[pat.id] = pat
        if not out:
            raise CatalogError(f"Catalog at {path} produced zero usable patterns")
        return out

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def list_patterns(self) -> list[Pattern]:
        """Return all patterns sorted by id for stable iteration."""
        return [self.patterns[k] for k in sorted(self.patterns.keys())]

    def inject(
        self,
        benign_package_dir: str | Path,
        pattern_id: str,
        seed: int | None = None,
    ) -> dict[str, Any]:
        """Inject a pattern into the benign package directory in-place.

        Returns a dict describing what was injected/modified so the caller can
        snapshot the resulting tarball or persist provenance.
        """
        pkg_dir = Path(benign_package_dir)
        if not pkg_dir.is_dir():
            raise NotADirectoryError(f"Benign package dir does not exist: {pkg_dir}")
        if pattern_id not in self.patterns:
            raise KeyError(f"Unknown pattern id: {pattern_id!r}")
        pattern = self.patterns[pattern_id]
        rng = random.Random(seed)

        # Step 1: resolve template variables to a concrete substitution map.
        substitutions = self._resolve_template_vars(pattern.template_variables, rng)

        # Step 2: produce the file payloads after substitution.
        files_to_write: dict[str, str] = {}
        for entry in pattern.inject_files:
            fpath = entry.get("path")
            content = entry.get("content", "")
            if not fpath or not isinstance(content, str):
                continue
            rendered = self._apply_substitutions(content, substitutions, rng)
            files_to_write[fpath] = rendered

        # Step 3: apply diversity strategies (each mutates files_to_write).
        for strat in pattern.diversity_strategies:
            files_to_write = self._apply_strategy(strat, files_to_write, rng)

        # Step 4: write the new files.
        injected: list[str] = []
        for rel_path, content in files_to_write.items():
            target = pkg_dir / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            injected.append(str(target.relative_to(pkg_dir)))

        # Step 5: modify existing files according to the catalog.
        modified: list[str] = []
        for entry in pattern.modify_files:
            mpath = entry.get("path")
            op = entry.get("op", "append")
            if not mpath:
                continue
            target = pkg_dir / mpath
            if op == "merge_json":
                patch = entry.get("patch", {})
                patch = self._apply_substitutions_obj(patch, substitutions, rng)
                self._merge_json(target, patch)
            elif op == "append":
                payload = self._apply_substitutions(
                    entry.get("content", ""), substitutions, rng
                )
                self._append_text(target, payload)
            elif op == "replace":
                find = entry.get("find", "")
                replace = self._apply_substitutions(
                    entry.get("replace", ""), substitutions, rng
                )
                self._replace_in_file(target, find, replace)
            else:
                logger.warning("Unknown modify op %r on %s", op, mpath)
                continue
            modified.append(str(target.relative_to(pkg_dir)) if target.exists() else mpath)

        return {
            "injected_files": injected,
            "modified_files": modified,
            "metadata": {
                "pattern_id": pattern.id,
                "severity": pattern.severity,
                "seed": seed,
                "substitutions": substitutions,
                "strategies_applied": list(pattern.diversity_strategies),
            },
        }

    # ------------------------------------------------------------------
    # Template variable handling
    # ------------------------------------------------------------------

    def _resolve_template_vars(
        self, variables: list[dict[str, Any]], rng: random.Random
    ) -> dict[str, str]:
        """Pick concrete values for each template variable using rng."""
        resolved: dict[str, str] = {}
        for var in variables:
            name = var.get("name")
            if not name:
                continue
            if "choices" in var and var["choices"]:
                value = rng.choice(list(var["choices"]))
            elif "value" in var:
                value = var["value"]
            else:
                value = self._random_token(rng, length=8)
            resolved[name] = self._expand_rand_tokens(str(value), rng)
        return resolved

    @staticmethod
    def _expand_rand_tokens(value: str, rng: random.Random) -> str:
        """Replace {rand} / {rand:N} tokens with random alphanumeric strings."""

        def _sub(match: re.Match[str]) -> str:
            length = int(match.group(1) or 6)
            return "".join(rng.choices(string.ascii_lowercase + string.digits, k=length))

        return _RAND_TOKEN.sub(_sub, value)

    def _apply_substitutions(
        self, text: str, subs: dict[str, str], rng: random.Random
    ) -> str:
        """Replace {{VAR}} markers in text with their substitution values."""

        def _sub(match: re.Match[str]) -> str:
            name = match.group(1)
            if name in subs:
                return subs[name]
            return match.group(0)

        out = _TEMPLATE_VAR.sub(_sub, text)
        return self._expand_rand_tokens(out, rng)

    def _apply_substitutions_obj(
        self, obj: Any, subs: dict[str, str], rng: random.Random
    ) -> Any:
        """Recursively apply substitutions to strings inside a JSON-ish object."""
        if isinstance(obj, str):
            return self._apply_substitutions(obj, subs, rng)
        if isinstance(obj, list):
            return [self._apply_substitutions_obj(x, subs, rng) for x in obj]
        if isinstance(obj, dict):
            return {k: self._apply_substitutions_obj(v, subs, rng) for k, v in obj.items()}
        return obj

    # ------------------------------------------------------------------
    # Diversity strategies
    # ------------------------------------------------------------------

    def _apply_strategy(
        self,
        strategy_name: str,
        files: dict[str, str],
        rng: random.Random,
    ) -> dict[str, str]:
        """Dispatch to one of the named diversity strategies."""
        if strategy_name in ("rename_identifiers", "identifier_renaming"):
            return {p: self._rename_identifiers(c, rng.randint(0, 2**31 - 1))
                    for p, c in files.items()}
        if strategy_name in ("swap_http_libs", "http_https_swap"):
            return {p: self._swap_http_libs(c, rng) for p, c in files.items()}
        if strategy_name in ("relocate_payload", "payload_relocation"):
            return self._relocate_payload(files, rng)
        logger.debug("Unknown diversity strategy %r, skipping", strategy_name)
        return files

    @staticmethod
    def _rename_identifiers(code: str, seed: int) -> str:
        """Rename `_p_`-prefixed identifiers (_p_foo) to random tokens.

        We only touch identifiers that begin with the convention prefix so we
        do not accidentally rename API calls, module names, or stdlib symbols.
        For each unique source name we generate one random target name and
        apply it consistently across the file.
        """
        rng = random.Random(seed)
        token_pattern = re.compile(r"\b" + re.escape(_RENAME_PREFIX) + r"[A-Za-z0-9_]+\b")
        seen = sorted(set(token_pattern.findall(code)))
        if not seen:
            return code
        mapping: dict[str, str] = {}
        for name in seen:
            if name in _JS_RESERVED:
                continue
            tail = "".join(rng.choices(string.ascii_lowercase, k=6))
            mapping[name] = f"_v_{tail}"
        if not mapping:
            return code

        def _sub(match: re.Match[str]) -> str:
            return mapping.get(match.group(0), match.group(0))

        return token_pattern.sub(_sub, code)

    @staticmethod
    def _swap_http_libs(code: str, rng: random.Random) -> str:
        """Swap require('https') for an alternate http client and adjust call sites."""
        choice = rng.choice(["axios", "node-fetch"])
        if "require('https')" not in code and 'require("https")' not in code:
            return code
        if choice == "axios":
            new_require_single = "require('axios')"
            new_require_double = 'require("axios")'
            # https.request(opts, cb) becomes axios(opts) returning a promise.
            # Naive but sufficient for synthetic diversity.
            code = re.sub(r"\.request\s*\(", "(", code)
        else:
            new_require_single = "require('node-fetch')"
            new_require_double = 'require("node-fetch")'
            code = re.sub(r"\.request\s*\(", "(", code)
        code = code.replace("require('https')", new_require_single)
        code = code.replace('require("https")', new_require_double)
        # Comment marker so downstream analysis can see we mutated.
        return code + f"\n// http-swap:{choice}\n"

    @staticmethod
    def _relocate_payload(
        files: dict[str, str], rng: random.Random
    ) -> dict[str, str]:
        """Move the largest injected file into a helper and require it elsewhere."""
        if len(files) < 1:
            return files
        # Pick the largest file as the "payload" to relocate.
        primary_path, primary_content = max(files.items(), key=lambda kv: len(kv[1]))
        # If there is already a helper, just return.
        if "/helper" in primary_path or "/util" in primary_path:
            return files
        helper_name = "_h_" + "".join(rng.choices(string.ascii_lowercase, k=5)) + ".js"
        helper_dir = str(Path(primary_path).parent / "lib")
        helper_rel = str(Path(helper_dir) / helper_name).replace("\\", "/")
        # Build a thin stub that requires the helper and re-exports it.
        depth = helper_rel.count("/")
        stub = (
            f"// relocated payload stub\n"
            f"module.exports = require('./{Path(helper_rel).relative_to(Path(primary_path).parent).as_posix()}');\n"
        )
        # Fall back to a safer require path if depth math went sideways.
        try:
            rel_for_require = Path(helper_rel).relative_to(Path(primary_path).parent).as_posix()
        except ValueError:
            rel_for_require = "./" + helper_name
            stub = f"// relocated payload stub\nmodule.exports = require('./{rel_for_require}');\n"
        new_files = dict(files)
        new_files[primary_path] = stub
        new_files[helper_rel] = primary_content
        _ = depth  # silence linter
        return new_files

    # ------------------------------------------------------------------
    # File mutation helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _merge_json(path: Path, patch: dict[str, Any]) -> None:
        """Deep-merge a patch dict into a JSON file, creating it if missing."""
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                logger.warning("Cannot parse %s as JSON, overwriting", path)
                data = {}
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            data = {}
        if not isinstance(data, dict):
            data = {}
        PatternInjector._deep_merge(data, patch)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    @staticmethod
    def _deep_merge(dst: dict[str, Any], src: dict[str, Any]) -> None:
        for k, v in src.items():
            if isinstance(v, dict) and isinstance(dst.get(k), dict):
                PatternInjector._deep_merge(dst[k], v)
            else:
                dst[k] = v

    @staticmethod
    def _append_text(path: Path, payload: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        path.write_text(existing + ("\n" if existing and not existing.endswith("\n") else "")
                        + payload, encoding="utf-8")

    @staticmethod
    def _replace_in_file(path: Path, find: str, replace: str) -> None:
        if not path.exists() or not find:
            return
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace(find, replace), encoding="utf-8")

    @staticmethod
    def _random_token(rng: random.Random, length: int = 8) -> str:
        return "".join(rng.choices(string.ascii_lowercase + string.digits, k=length))
