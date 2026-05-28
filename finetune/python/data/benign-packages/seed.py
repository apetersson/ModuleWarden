#!/usr/bin/env python3
"""Cross-platform benign-package seeder.

Equivalent to seed.sh but uses urllib + tarfile from the standard
library instead of curl + tar. Works on Windows git-bash where curl's
path translation has been observed to drop the output file silently.

Usage:
    python finetune/python/data/benign-packages/seed.py
    python finetune/python/data/benign-packages/seed.py --upload-to-nextcloud
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

# Top npm packages used as injector baselines. Mirrors seed.sh.
PACKAGES: list[tuple[str, str]] = [
    ("lodash", "4.17.21"),
    ("chalk", "5.3.0"),
    ("axios", "1.7.7"),
    ("express", "4.21.1"),
    ("react", "18.3.1"),
    ("react-dom", "18.3.1"),
    ("dotenv", "16.4.5"),
    ("commander", "12.1.0"),
    ("yargs", "17.7.2"),
    ("minimist", "1.2.8"),
    ("debug", "4.3.7"),
    ("ms", "2.1.3"),
    ("uuid", "10.0.0"),
    ("nanoid", "5.0.7"),
    ("semver", "7.6.3"),
    ("glob", "11.0.0"),
    ("rimraf", "6.0.1"),
    ("json5", "2.2.3"),
    ("winston", "3.15.0"),
    ("pino", "9.5.0"),
]

SCRIPT_DIR = Path(__file__).resolve().parent
OUT_DIR = SCRIPT_DIR / "extracted"


def _safe_name(pkg: str) -> str:
    """Filesystem-safe package name (replaces npm scope slash)."""
    return pkg.replace("/", "_")


def fetch_tarball_url(spec: str) -> str | None:
    """Resolve the tarball URL for an exact npm package version.

    Uses the npm registry packument endpoint over HTTPS rather than the
    `npm view` CLI, so this script does not depend on Node being on PATH.
    """
    pkg, ver = spec.rsplit("@", 1)
    url = f"https://registry.npmjs.org/{pkg}/{ver}"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        print(f"  warn: registry returned HTTP {err.code} for {spec}")
        return None
    except urllib.error.URLError as err:
        print(f"  warn: registry unreachable for {spec}: {err}")
        return None
    tarball = data.get("dist", {}).get("tarball")
    if not tarball:
        print(f"  warn: no tarball in packument for {spec}")
        return None
    return tarball


def download_to(url: str, dest: Path) -> bool:
    """Stream a tarball to disk. Returns True if at least one byte was
    written and the resulting file is a valid gzip tarball."""
    try:
        with urllib.request.urlopen(url, timeout=120) as resp:
            with dest.open("wb") as out:
                shutil.copyfileobj(resp, out, length=64 * 1024)
    except urllib.error.URLError as err:
        print(f"  warn: download failed: {err}")
        return False

    if dest.stat().st_size == 0:
        print("  warn: download produced empty file")
        return False

    # Quick gzip-magic sanity check before tar extraction.
    with dest.open("rb") as fh:
        magic = fh.read(2)
    if magic != b"\x1f\x8b":
        print(f"  warn: not a gzip stream (magic={magic!r})")
        return False

    return True


def extract_tarball(tarball: Path, target: Path) -> bool:
    """Extract an npm tarball stripping the top-level `package/` dir.

    The npm convention is that tarballs contain everything under a single
    `package/` directory; we want the package's contents at the root of
    the target directory.
    """
    try:
        with tarfile.open(tarball, "r:gz") as tar:
            target.mkdir(parents=True, exist_ok=True)
            for member in tar.getmembers():
                # Strip leading "package/" component.
                parts = member.name.split("/", 1)
                if len(parts) < 2 or parts[0] != "package":
                    continue
                member.name = parts[1]
                if not member.name:
                    continue
                # Refuse path traversal.
                full = (target / member.name).resolve()
                if not str(full).startswith(str(target.resolve())):
                    print(f"  warn: refusing path traversal: {member.name}")
                    continue
                tar.extract(member, target)  # noqa: S202 path already validated
    except (tarfile.TarError, OSError) as err:
        print(f"  warn: extraction failed: {err}")
        return False
    return True


def seed_one(spec: str) -> bool:
    """Fetch + extract a single package. Returns True on success."""
    pkg, ver = spec.rsplit("@", 1)
    safe = _safe_name(pkg)
    target = OUT_DIR / f"{safe}-{ver}"

    if target.is_dir() and any(target.iterdir()):
        print(f"skip  {spec} (already extracted)")
        return True

    print(f"fetch {spec}")
    tarball_url = fetch_tarball_url(spec)
    if not tarball_url:
        return False

    with tempfile.NamedTemporaryFile(
        suffix=".tgz", dir=OUT_DIR, delete=False
    ) as tmp:
        tmp_path = Path(tmp.name)
    try:
        if not download_to(tarball_url, tmp_path):
            return False
        if target.exists():
            shutil.rmtree(target)
        if not extract_tarball(tmp_path, target):
            if target.exists():
                shutil.rmtree(target)
            return False
        print(f"  done: {target}")
        return True
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Seed benign npm packages.")
    parser.add_argument(
        "--upload-to-nextcloud",
        action="store_true",
        help="After seeding, tar the extracted dir and push it to Nextcloud",
    )
    args = parser.parse_args(argv)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    seeded: list[str] = []
    skipped: list[str] = []
    for pkg, ver in PACKAGES:
        spec = f"{pkg}@{ver}"
        if seed_one(spec):
            seeded.append(spec)
        else:
            skipped.append(spec)

    print()
    print(f"Seeded: {len(seeded)} / {len(PACKAGES)}")
    if skipped:
        print(f"Skipped: {len(skipped)}")
        for spec in skipped:
            print(f"  - {spec}")

    total_bytes = 0
    for root, _, files in os.walk(OUT_DIR):
        for name in files:
            total_bytes += os.path.getsize(os.path.join(root, name))
    print(f"Total bytes on disk: {total_bytes} ({total_bytes / 1024 / 1024:.1f} MB)")

    if args.upload_to_nextcloud:
        repo_root = SCRIPT_DIR.parents[3]
        bundle = repo_root / "finetune" / "corpus" / "benign-packages-seed.tar.gz"
        print()
        print(f"Bundling -> {bundle}")
        with tarfile.open(bundle, "w:gz") as tar:
            tar.add(OUT_DIR, arcname=".")
        print(f"  {bundle.stat().st_size} bytes")
        subprocess.run(
            [
                "bash",
                str(repo_root / "finetune" / "scripts" / "nextcloud-sync.sh"),
                "push",
                str(bundle),
                "benign-packages-seed.tar.gz",
            ],
            check=False,
        )

    return 0 if seeded else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
