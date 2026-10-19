"""Copy only owned browser assets to Vercel's public CDN directory."""
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
ASSET_SUFFIXES = {".css", ".js", ".json", ".svg", ".webmanifest", ".png", ".jpg", ".webp", ".woff2"}


def build():
    assets = []
    digest = hashlib.sha256((ROOT / "templates/index.html").read_bytes())
    for source in sorted((ROOT / "static").rglob("*")):
        relative = source.relative_to(ROOT)
        if not source.is_file() or source.is_symlink() or source.suffix not in ASSET_SUFFIXES:
            continue
        if any(part.startswith(".") for part in relative.parts):
            continue
        target = PUBLIC / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        digest.update(source.read_bytes())
        if source.name != "sw.js":
            assets.append("./" + relative.as_posix())
    worker = (ROOT / "static/sw.js").read_text(encoding="utf-8")
    worker = worker.replace("current-shell-v1", "current-shell-" + digest.hexdigest()[:16])
    worker = worker.replace("/* BUILD_ASSETS */", "SHELL_ASSETS = " + json.dumps(["./", *assets]) + ";")
    (PUBLIC / "sw.js").write_text(worker, encoding="utf-8")
    print("Prepared owned browser assets in public/; Flask remains the backend.")


if __name__ == "__main__":
    build()
