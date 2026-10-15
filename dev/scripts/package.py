"""Produce a runtime-only ZIP accepted by LNbits' WASM installer."""

import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[2]
config = json.loads((root / "config.json").read_text())
output = root / "dist" / (config["id"] + "-" + config["version"] + ".zip")
output.parent.mkdir(exist_ok=True)
files = [root / name for name in ["config.json", "LICENSE", "README.md"]]
for directory in ["wasm", "storage", "static", "ui"]:
    files.extend(p for p in (root / directory).rglob("*") if p.is_file())
assert (root / config["wasm"]["module"]).is_file(), "Build the component first."
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for path in sorted(files):
        assert path.suffix not in {".py", ".pyc", ".pyo", ".so", ".pyd"}
        archive.write(path, str(Path(config["id"]) / path.relative_to(root)))
digest = hashlib.sha256(output.read_bytes()).hexdigest()
repository = "https://github.com/lnbits/wallet_sweep"
manifest = {
    "extensions": [
        {
            "id": config["id"],
            "name": config["name"],
            "version": config["version"],
            "archive": repository
            + "/releases/download/v"
            + config["version"]
            + "/"
            + output.name,
            "hash": digest,
            "repo": repository,
            "icon": "https://raw.githubusercontent.com/lnbits/wallet_sweep/v"
            + config["version"]
            + "/static/assets/icon.png",
            "short_description": config["short_description"],
            "min_lnbits_version": config["min_lnbits_version"],
            "html_url": repository + "/releases/tag/v" + config["version"],
            "extension_type": "wasm",
        }
    ]
}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(output)
print("SHA256 " + hashlib.sha256(output.read_bytes()).hexdigest())
