"""Builds the Themes & add-ons catalog published with every tv-v* release.

    python3 -I tools/catalog.py --apks <dir with <add-on id>.apk> --out <release dir>

For every theme in themes/README.md it packs the files the launcher reads (config.json, wallpaper.jpg and the
wallpapers/ collection, the same set ThemeFiles.java accepts) into theme-<id>.zip and copies its screenshot to
theme-<id>.jpg. For every add-on in addons/README.md it copies the built APK to addon-<id>.apk and its screenshot to
addon-<id>.jpg. catalog.json lists each one with what the TV and the gallery need: id, kind, name, description,
screenshot, file, size, sha256, minSdk, permissions and whether it uses the network.

The output is deterministic: the same checkout and APKs give byte-identical files. A theme or add-on without a
screenshot, with a path that leaves its own folder (a symlink, a ".." in the README), or larger than the caps below is
refused, and nothing is written for a catalog that has a refusal in it.
"""
import argparse
import hashlib
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manage  # noqa: E402

ROOT = manage.ROOT
CATALOG_VERSION = 1
CATALOG_NAME = "catalog.json"
# The launcher refuses a theme that unpacks larger than this (ThemeUnpack.MAX_BYTES); keep the two equal.
THEME_MAX_BYTES = 32 * 1024 * 1024
APK_MAX_BYTES = 64 * 1024 * 1024
SCREENSHOT_MAX_BYTES = 300 * 1024
ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
IMAGE = re.compile(r"[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp)", re.IGNORECASE)
CAPTIONS = "captions.txt"
ANDROID = "{http://schemas.android.com/apk/res/android}"
ZIP_TIME = (1980, 1, 1, 0, 0, 0)

class Refused(Exception):
    """A theme or add-on that cannot be published, with the sentence that says why."""

def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def inside(folder, path):
    """The file at path when it is a regular file inside folder (no symlink on the way), else None."""
    folder = folder.resolve()
    candidate = folder / path
    rel = Path(path)
    if rel.is_absolute() or ".." in rel.parts:
        return None
    probe = folder
    for part in rel.parts:
        probe = probe / part
        if probe.is_symlink():
            return None
    try:
        candidate.resolve().relative_to(folder)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None

def screenshot(item, folder):
    """The screenshot file, refusing one that is missing, outside the folder or too large."""
    if not item.get("screenshot"):
        raise Refused(f"{item['kind']} {item['id']} has no screenshot in its README row")
    rel = Path(item["screenshot"]).relative_to(folder.parent) if Path(item["screenshot"]).is_absolute() \
        else Path(item["screenshot"])
    # README cells name the file relative to themes/ or addons/, so the first part is the folder itself.
    parts = rel.parts
    if not parts or parts[0] != folder.name:
        raise Refused(f"{item['kind']} {item['id']}: the screenshot is not in its own folder")
    found = inside(folder, Path(*parts[1:]) if len(parts) > 1 else Path(""))
    if found is None:
        raise Refused(f"{item['kind']} {item['id']}: the screenshot is missing or leaves its folder")
    if found.stat().st_size > SCREENSHOT_MAX_BYTES:
        raise Refused(f"{item['kind']} {item['id']}: the screenshot is larger than {SCREENSHOT_MAX_BYTES} bytes")
    return found

def theme_members(folder):
    """(name in the zip, file) for every file the launcher reads, sorted, refusing symlinks."""
    members = []
    for name in ("config.json", "wallpaper.jpg"):
        path = folder / name
        if path.is_symlink():
            raise Refused(f"theme {folder.name}: {name} is a link")
        if path.is_file():
            members.append((name, path))
    collection = folder / "wallpapers"
    if collection.is_symlink():
        raise Refused(f"theme {folder.name}: wallpapers is a link")
    if collection.is_dir():
        for path in sorted(collection.iterdir(), key=lambda p: p.name):
            if path.is_symlink():
                raise Refused(f"theme {folder.name}: wallpapers/{path.name} is a link")
            if path.is_file() and not path.name.startswith(".") and (IMAGE.fullmatch(path.name) or path.name == CAPTIONS):
                members.append((f"wallpapers/{path.name}", path))
    if not any(name == "config.json" for name, _ in members):
        raise Refused(f"theme {folder.name} has no config.json")
    return members

def write_zip(target, members):
    with zipfile.ZipFile(target, "w") as archive:
        for name, path in members:
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

def min_sdk(gradle_dir):
    for name in ("build.gradle", "build.gradle.kts"):
        f = gradle_dir / name
        if f.is_file():
            m = re.search(r"minSdk(?:Version)?\s*=?\s*\(?\s*(\d+)", f.read_text(encoding="utf-8"))
            if m:
                return int(m.group(1))
    return None

def permissions(folder):
    manifest = folder / "app" / "src" / "main" / "AndroidManifest.xml"
    if not manifest.is_file():
        return []
    root = ElementTree.parse(manifest).getroot()
    names = set()
    for tag in ("uses-permission", "uses-permission-sdk-23"):
        for node in root.iter(tag):
            name = node.get(ANDROID + "name")
            if name:
                names.add(name)
    return sorted(names)

def human(identifier):
    return " ".join(word.capitalize() for word in re.split(r"[-_]", identifier) if word)

def check_id(item):
    if not ID.fullmatch(item["id"]):
        raise Refused(f"{item['kind']} {item['id']!r}: the folder name is not a plain id")

def build(apks, out, root=ROOT):
    """Writes every asset and catalog.json into out, or raises Refused (listing every problem) and writes nothing."""
    entries, copies, zips, problems = [], [], [], []
    launcher_min = min_sdk(root / "launcher" / "app")
    for item in manage.themes(root):
        try:
            check_id(item)
            folder = root / "themes" / item["id"]
            if folder.is_symlink() or not folder.is_dir():
                raise Refused(f"theme {item['id']}: no such folder")
            shot = screenshot(item, folder)
            members = theme_members(folder)
            unpacked = sum(path.stat().st_size for _, path in members)
            if unpacked > THEME_MAX_BYTES:
                raise Refused(f"theme {item['id']} unpacks to {unpacked} bytes, over {THEME_MAX_BYTES}")
            zips.append((f"theme-{item['id']}.zip", members))
            copies.append((shot, f"theme-{item['id']}.jpg"))
            entries.append({"id": item["id"], "kind": "theme", "name": human(item["id"]),
                            "description": item["what"], "screenshot": f"theme-{item['id']}.jpg",
                            "file": f"theme-{item['id']}.zip", "unpackedSize": unpacked,
                            "minSdk": launcher_min, "permissions": [], "network": False, "package": None})
        except Refused as refused:
            problems.append(str(refused))
    for item in manage.addons(root):
        try:
            check_id(item)
            folder = root / "addons" / item["id"]
            if folder.is_symlink() or not folder.is_dir():
                raise Refused(f"add-on {item['id']}: no such folder")
            shot = screenshot(item, folder)
            apk = Path(apks) / f"{item['id']}.apk"
            if not apk.is_file():
                raise Refused(f"add-on {item['id']}: no built APK at {apk}")
            if apk.stat().st_size > APK_MAX_BYTES:
                raise Refused(f"add-on {item['id']}: the APK is larger than {APK_MAX_BYTES} bytes")
            granted = permissions(folder)
            copies.append((apk, f"addon-{item['id']}.apk"))
            copies.append((shot, f"addon-{item['id']}.jpg"))
            entries.append({"id": item["id"], "kind": "addon", "name": item["name"],
                            "description": item["what"], "screenshot": f"addon-{item['id']}.jpg",
                            "file": f"addon-{item['id']}.apk", "minSdk": min_sdk(folder / "app"),
                            "permissions": granted, "network": "android.permission.INTERNET" in granted,
                            "package": item["package"]})
        except Refused as refused:
            problems.append(str(refused))
    if problems:
        raise Refused("\n".join(problems))

    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for name, members in zips:
        write_zip(out / name, members)
    for source, name in copies:
        shutil.copyfile(source, out / name)
    for entry in entries:
        entry["size"] = (out / entry["file"]).stat().st_size
        entry["sha256"] = sha256(out / entry["file"])
    entries.sort(key=lambda e: (e["kind"], e["id"]))
    catalog = {"version": CATALOG_VERSION, "items": entries}
    (out / CATALOG_NAME).write_text(json.dumps(catalog, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
                                    encoding="utf-8", newline="\n")
    return catalog

def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the Themes & add-ons catalog for a TV release.")
    parser.add_argument("--apks", required=True, help="folder holding <add-on id>.apk for every add-on")
    parser.add_argument("--out", required=True, help="folder the release assets and catalog.json go into")
    args = parser.parse_args(argv)
    try:
        catalog = build(args.apks, args.out)
    except Refused as refused:
        print(f"catalog refused:\n{refused}", file=sys.stderr)
        return 1
    print(f"catalog.json: {len(catalog['items'])} items")
    return 0

if __name__ == "__main__":
    sys.exit(main())
