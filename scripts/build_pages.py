"""Export a credential-free shell that searches the live backend."""
import argparse
import hashlib
import json
from pathlib import Path
import os
from urllib.parse import urlsplit, urlunsplit
import shutil
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from flask import render_template
from ev_charging_finder.app import app


ASSET_SUFFIXES = {".css", ".js", ".json", ".svg", ".webmanifest", ".png", ".jpg", ".webp", ".woff2"}
DEFAULT_API_BASE = "https://ev-charging-finder-nine.vercel.app/"
SHELL_VERSION = "current-shell-v3"


def api_base_url(value):
    """Accept public HTTPS backends and loopback HTTP for local integration."""
    parsed = urlsplit(value)
    try:
        parsed.port
    except ValueError as error:
        raise ValueError("API_BASE_URL must use a valid port.") from error
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (
        not parsed.hostname
        or (parsed.scheme != "https" and not (parsed.scheme == "http" and local))
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or any(character.isspace() for character in value)
    ):
        raise ValueError("API_BASE_URL must be public HTTPS or loopback HTTP, without credentials, query or fragment.")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/") + "/", "", ""))


def build(destination):
    api_base = api_base_url(os.environ.get("API_BASE_URL", DEFAULT_API_BASE))
    destination = Path(destination).resolve()
    if destination == ROOT or ROOT.is_relative_to(destination):
        raise ValueError("Choose an output directory below or outside the source directory.")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Output directory must be empty; use a new directory to avoid publishing stale files.")
    destination.mkdir(parents=True, exist_ok=True)
    config = {"mode": "static", "api_base": api_base, "live_search": True, "routing": False}
    initial_data = {"stations": [], "config": config, "error": None}
    values = {"zip_code": "", "radius": "10", "limit": "100"}
    with app.test_request_context("/"):
        html = render_template("index.html", initial_data=initial_data, stations=[],
                               config=config, error=None, values=values,
                               operational=False, location="Choose a search area")
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
    worker = worker.replace(SHELL_VERSION, "current-shell-" + digest.hexdigest()[:16])
    assets = [asset + "?v=5" if asset in ("./static/app.js", "./static/app.css") else asset for asset in assets]
    worker = worker.replace("/* BUILD_ASSETS */", "SHELL_ASSETS = " + json.dumps(["./", *assets]) + ";")
    (destination / "sw.js").write_text(worker, encoding="utf-8")
    (destination / ".nojekyll").write_text("", encoding="utf-8")
    (destination / "build-info.json").write_text(json.dumps({
        "mode": "static", "api_base": api_base, "built_at": datetime.now(timezone.utc).isoformat(),
        "shell_version": "current-shell-" + digest.hexdigest()[:16],
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Exported live API frontend to {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="site", help="Empty output directory (default: site)")
    build(parser.parse_args().output)
