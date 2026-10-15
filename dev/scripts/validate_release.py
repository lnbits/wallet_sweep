"""Validate metadata and the exact runtime ZIP before publication or registry use."""

import argparse
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "lnbits/wallet_sweep"
FORBIDDEN_SUFFIXES = {".py", ".pyc", ".pyo", ".so", ".pyd", ".dll", ".dylib", ".exe"}
COMPONENT_HEADER = b"\0asm\x0d\0\x01\0"


def validate_metadata(config: dict, tag: str | None = None) -> None:
    assert config.get("id") == "wallet_sweep", "config id must be wallet_sweep"
    assert config.get("extension_type") == "wasm", "extension_type must be wasm"
    version = config.get("version", "")
    assert re.fullmatch(
        r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version
    ), "Invalid release version"
    if tag is not None:
        assert tag == f"v{version}", "config version must match the release tag"
    assert config.get("min_lnbits_version"), "min_lnbits_version is required"
    module = config.get("wasm", {}).get("module", "")
    assert (
        module and not PurePosixPath(module).is_absolute()
    ), "wasm.module must be a relative path"
    assert ".." not in PurePosixPath(module).parts, "wasm.module escapes the extension"


def validate_package(config: dict, archive_path: Path, manifest_path: Path) -> None:
    (entry,) = json.loads(manifest_path.read_text())["extensions"]
    version = config["version"]
    name = f"wallet_sweep-{version}.zip"
    assert archive_path.name == name, "Archive filename does not match the version"
    assert (
        entry["id"] == config["id"] and entry["version"] == version
    ), "Manifest identity does not match config"
    assert entry["extension_type"] == "wasm", "Manifest extension_type must be wasm"
    assert (
        entry["min_lnbits_version"] == config["min_lnbits_version"]
    ), "Manifest minimum version does not match config"
    assert (
        entry["repo"] == f"https://github.com/{REPOSITORY}"
    ), "Unexpected release repository"
    assert (
        entry["archive"]
        == f"https://github.com/{REPOSITORY}/releases/download/v{version}/{name}"
    ), "Manifest must reference the runtime release asset"
    assert (
        entry["hash"] == hashlib.sha256(archive_path.read_bytes()).hexdigest()
    ), "Archive checksum does not match the manifest"
    with ZipFile(archive_path) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), "Duplicate archive paths"
        for info in archive.infolist():
            path = PurePosixPath(info.filename)
            assert (
                not path.is_absolute() and ".." not in path.parts
            ), "Unsafe archive path"
            assert (
                len(path.parts) >= 2 and path.parts[0] == "wallet_sweep"
            ), "Archive must have one wallet_sweep directory"
            assert (
                path.suffix.lower() not in FORBIDDEN_SUFFIXES
            ), "Native files are forbidden in WASM packages"
            assert not {"dev", ".git", ".github", "__pycache__"}.intersection(
                path.parts
            ), "Development files must not be packaged"
            assert (
                info.external_attr >> 16
            ) & 0o170000 != 0o120000, "Archive symlinks are forbidden"
        assert (
            json.loads(archive.read("wallet_sweep/config.json")) == config
        ), "Packaged config does not match source"
        module = archive.read(f'wallet_sweep/{config["wasm"]["module"]}')
        assert module.startswith(
            COMPONENT_HEADER
        ), "The packaged module must be a WASM component"
        for filename in [
            "LICENSE",
            "README.md",
            "ui/index.html",
            "static/app.js",
            "static/bridge.js",
            "static/app.css",
            "static/assets/icon.png",
            "wasm/lnbits-extension.wit",
            "storage/schema.json",
            "storage/migrations/0001_initial.json",
        ]:
            assert (
                f"wallet_sweep/{filename}" in names
            ), f"Missing runtime file: {filename}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag")
    parser.add_argument("--metadata-only", action="store_true")
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--manifest", type=Path, default=ROOT / "manifest.json")
    args = parser.parse_args()
    config = json.loads((ROOT / "config.json").read_text())
    validate_metadata(config, args.tag)
    if args.tag and os.environ.get("GITHUB_REPOSITORY"):
        assert (
            os.environ["GITHUB_REPOSITORY"] == REPOSITORY
        ), "Release repository must match package metadata"
    if not args.metadata_only:
        archive = (
            args.archive or ROOT / "dist" / f'wallet_sweep-{config["version"]}.zip'
        )
        validate_package(config, archive, args.manifest)
    print(
        "Release metadata validated."
        if args.metadata_only
        else "Release package, runtime files, and manifest checksum validated."
    )


if __name__ == "__main__":
    main()
