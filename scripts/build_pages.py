"""Export the fictional demo without credentials or a running Flask service."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from flask import render_template
from app import app
from finder import search


ASSET_SUFFIXES = {".css", ".js", ".json", ".svg", ".webmanifest", ".png", ".jpg", ".webp", ".woff2"}


def build(destination):
    destination = Path(destination).resolve()
    if destination == ROOT or ROOT.is_relative_to(destination):
        raise ValueError("Choose an output directory below or outside the source directory.")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Output directory must be empty; use a new directory to avoid publishing stale files.")
    destination.mkdir(parents=True, exist_ok=True)
    stations = search(40.758, -73.9855, radius=10, limit=100, demo=True)
    config = {"mode": "static", "live_search": False, "routing": False}
    initial_data = {"stations": stations, "demo": True, "config": config, "error": None}
    values = {"latitude": "40.758", "longitude": "-73.9855", "radius": "10", "limit": "100", "zip_code": "10036", "location_mode": "zip"}
    with app.test_request_context("/"):
        html = render_template("index.html", initial_data=initial_data, stations=stations,
                               demo=True, config=config, error=None, values=values,
                               operational=False, location="Midtown Manhattan · fictional demo")
    html = html.replace('"/static/', '"./static/').replace("'/static/", "'./static/")
    (destination / "index.html").write_text(html, encoding="utf-8")
    assets = []
    for source in sorted((ROOT / "static").rglob("*")):
        relative = source.relative_to(ROOT)
        if not source.is_file() or source.is_symlink() or source.suffix not in ASSET_SUFFIXES:
            continue
        if any(part.startswith(".") for part in relative.parts):
            continue
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        if relative.name != "sw.js":
            assets.append("./" + relative.as_posix())
    digest = hashlib.sha256(html.encode())
    for asset in assets:
        digest.update((destination / asset).read_bytes())
    worker = (ROOT / "static/sw.js").read_text(encoding="utf-8")
    worker = worker.replace("current-shell-v1", "current-shell-" + digest.hexdigest()[:16])
    worker = worker.replace("/* BUILD_ASSETS */", "SHELL_ASSETS = " + json.dumps(["./", *assets]) + ";")
    (destination / "sw.js").write_text(worker, encoding="utf-8")
    (destination / ".nojekyll").write_text("", encoding="utf-8")
    (destination / "build-info.json").write_text(json.dumps({
        "mode": "static", "demo": True, "built_at": datetime.now(timezone.utc).isoformat(),
        "shell_version": "current-shell-" + digest.hexdigest()[:16],
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Exported fictional demo to {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="site", help="Empty output directory (default: site)")
    build(parser.parse_args().output)
