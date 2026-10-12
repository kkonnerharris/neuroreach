"""Build the static web edition into dist/ (deployable to GitHub Pages or any static host).

    python tools/export_web_decoder.py   # decoders + EEG epochs for the browser
    python sim/record_web.py             # record every level in PyBullet
    python tools/build_web.py            # -> dist/
"""
import json
import re
import shutil
from pathlib import Path

import pybullet_data

ROOT = Path(__file__).resolve().parent.parent
GAME, WEB, DIST = ROOT / "game", ROOT / "web", ROOT / "dist"
PB = Path(pybullet_data.getDataPath())


def main():
    DIST.mkdir(exist_ok=True)
    for old in DIST.iterdir():  # clear the last build but keep dist/.git (the Pages repo)
        if old.name != ".git":
            shutil.rmtree(old) if old.is_dir() else old.unlink()
    for f in ["app.js", "viewer.js", "sound.js", "styles.css", "eeg-deck.js", "eegdecoder.js", "replay.js", "headcontrol.js"]:
        shutil.copy2(GAME / f, DIST / f)
    (DIST / "assets" / "levels").mkdir(parents=True)
    for jpg in (GAME / "assets").glob("*.jpg"):
        shutil.copy2(jpg, DIST / "assets" / jpg.name)
    for jpg in (GAME / "assets" / "levels").glob("*.jpg"):
        shutil.copy2(jpg, DIST / "assets" / "levels" / jpg.name)
    shutil.copytree(WEB / "eeg", DIST / "eeg")
    shutil.copytree(WEB / "levels", DIST / "levels")
    shutil.copy2(WEB / "levels.json", DIST / "levels.json")
    # robot / tray meshes referenced by the recorded scenes
    meshes = set()
    for f in (WEB / "levels").glob("*.json"):
        meshes.update(re.findall(r'"mesh":\s*"(pb/[^"]+)"', f.read_text(encoding="utf-8")))
    for m in meshes:
        src = PB / m[3:]
        dst = DIST / m
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    # page: load the replay layer first, hide the researcher console (it needs the live server)
    html = (GAME / "index.html").read_text(encoding="utf-8")
    html = html.replace('<script src="eeg-deck.js"></script>', '<script src="replay.js"></script>\n  <script src="eeg-deck.js"></script>', 1)
    html = html.replace("</head>", '  <style>.web-edition #view-toggle, .web-edition .set-row:has(#view-toggle) { display: none !important; }</style>\n</head>', 1)
    (DIST / "index.html").write_text(html, encoding="utf-8")
    (DIST / ".nojekyll").write_text("")
    size = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file()) / 1e6
    print(f"dist/ built: {len(list(DIST.rglob('*')))} files, {size:.1f} MB, {len(meshes)} meshes")


if __name__ == "__main__":
    main()
