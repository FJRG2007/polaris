"""tools/catalog.py: the Themes & add-ons catalog every tv-v* release carries.

Run from the repository root: python3 -m unittest discover -s tests -v
"""
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import catalog  # noqa: E402
import manage  # noqa: E402

JPEG = b"\xff\xd8\xff\xd9"

def fake_apks(folder, root=ROOT):
    for item in manage.addons(root):
        (Path(folder) / f"{item['id']}.apk").write_bytes(b"apk:" + item["id"].encode())

def fixture(base, theme_rows, addon_rows=()):
    """A minimal tv/ tree: themes/README.md, addons/README.md and the launcher's build.gradle."""
    root = Path(base)
    (root / "launcher" / "app").mkdir(parents=True)
    (root / "launcher" / "app" / "build.gradle").write_text("android { defaultConfig { minSdk 26 } }\n")
    (root / "themes").mkdir()
    (root / "addons").mkdir()
    lines = ["| Theme | What it does | Screenshot |", "|---|---|---|"]
    for folder, shot in theme_rows:
        lines.append(f"| `{folder}/` | A look | <img src=\"{shot}\" width=\"320\" alt=\"x\"> |")
    (root / "themes" / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    lines = ["| Add-on | What it does | Author | Tested on | Permissions | Screenshot |", "|---|---|---|---|---|---|"]
    for folder in addon_rows:
        lines.append(f"| [Clock]({folder}/) | Tells the time | me | a TV | None | "
                     f"<img src=\"{folder}/screenshot.jpg\" width=\"240\" alt=\"x\"> |")
    (root / "addons" / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return root

def theme(root, name, files):
    folder = root / "themes" / name
    for rel, data in files.items():
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_bytes(data)
    return folder

class RepositoryCatalog(unittest.TestCase):
    def test_every_theme_and_addon_is_listed_and_output_is_deterministic(self):
        with tempfile.TemporaryDirectory() as apks, tempfile.TemporaryDirectory() as a, \
                tempfile.TemporaryDirectory() as b:
            fake_apks(apks)
            first = catalog.build(apks, a)
            catalog.build(apks, b)
            names = sorted(os.listdir(a))
            self.assertEqual(names, sorted(os.listdir(b)))
            for name in names:
                self.assertEqual((Path(a) / name).read_bytes(), (Path(b) / name).read_bytes(), name)
            kinds = [entry["kind"] for entry in first["items"]]
            self.assertEqual(kinds.count("theme"), len(manage.themes()))
            self.assertEqual(kinds.count("addon"), len(manage.addons()))
            written = json.loads((Path(a) / "catalog.json").read_text(encoding="utf-8"))
            for entry in written["items"]:
                for key in ("id", "kind", "name", "description", "screenshot", "file", "size", "sha256",
                            "minSdk", "permissions", "network"):
                    self.assertIn(key, entry, entry["id"])
                self.assertTrue((Path(a) / entry["screenshot"]).is_file())
                self.assertEqual(entry["size"], (Path(a) / entry["file"]).stat().st_size)
                self.assertEqual(entry["sha256"], catalog.sha256(Path(a) / entry["file"]))

    def test_theme_zip_holds_only_what_the_launcher_reads(self):
        with tempfile.TemporaryDirectory() as apks, tempfile.TemporaryDirectory() as out:
            fake_apks(apks)
            catalog.build(apks, out)
            for zipped in Path(out).glob("theme-*.zip"):
                with zipfile.ZipFile(zipped) as archive:
                    for name in archive.namelist():
                        ok = name in ("config.json", "wallpaper.jpg") or (
                            name.startswith("wallpapers/") and name.count("/") == 1)
                        self.assertTrue(ok, f"{zipped.name}: {name}")
                    self.assertIn("config.json", archive.namelist())

    def test_network_follows_the_internet_permission(self):
        with tempfile.TemporaryDirectory() as apks, tempfile.TemporaryDirectory() as out:
            fake_apks(apks)
            items = {e["id"]: e for e in catalog.build(apks, out)["items"] if e["kind"] == "addon"}
            self.assertTrue(items["weather"]["network"])
            self.assertEqual(items["weather"]["minSdk"], 26)
            for entry in items.values():
                self.assertEqual(entry["network"], "android.permission.INTERNET" in entry["permissions"])

class Refusals(unittest.TestCase):
    def build(self, root, apks=None):
        with tempfile.TemporaryDirectory() as empty, tempfile.TemporaryDirectory() as out:
            try:
                return catalog.build(apks or empty, out, root=root)
            finally:
                self.written = os.listdir(out)

    def test_theme_without_screenshot_is_refused_and_nothing_is_written(self):
        with tempfile.TemporaryDirectory() as base:
            root = fixture(base, [("good", "good/screenshot.jpg"), ("bare", "bare/screenshot.jpg")])
            theme(root, "good", {"config.json": b"{}", "screenshot.jpg": JPEG})
            theme(root, "bare", {"config.json": b"{}"})
            with self.assertRaises(catalog.Refused) as caught:
                self.build(root)
            self.assertIn("bare", str(caught.exception))
            self.assertEqual(self.written, [])

    def test_screenshot_outside_the_theme_is_refused(self):
        with tempfile.TemporaryDirectory() as base:
            root = fixture(base, [("sly", "other/screenshot.jpg"), ("dots", "dots/../other/screenshot.jpg")])
            theme(root, "sly", {"config.json": b"{}"})
            theme(root, "dots", {"config.json": b"{}"})
            theme(root, "other", {"config.json": b"{}", "screenshot.jpg": JPEG})
            with self.assertRaises(catalog.Refused) as caught:
                self.build(root)
            self.assertIn("sly", str(caught.exception))
            self.assertIn("dots", str(caught.exception))

    def test_folder_name_with_traversal_is_refused(self):
        with tempfile.TemporaryDirectory() as base:
            root = fixture(base, [("..", "../screenshot.jpg")])
            with self.assertRaises(catalog.Refused):
                self.build(root)

    def test_linked_wallpaper_is_refused(self):
        with tempfile.TemporaryDirectory() as base:
            root = fixture(base, [("linky", "linky/screenshot.jpg")])
            folder = theme(root, "linky", {"config.json": b"{}", "screenshot.jpg": JPEG, "wallpapers/a.jpg": JPEG})
            secret = Path(base) / "secret.jpg"
            secret.write_bytes(JPEG)
            try:
                os.symlink(secret, folder / "wallpapers" / "b.jpg")
            except (OSError, NotImplementedError):
                self.skipTest("this system cannot create symlinks")
            with self.assertRaises(catalog.Refused) as caught:
                self.build(root)
            self.assertIn("link", str(caught.exception))

    def test_theme_over_the_size_cap_is_refused(self):
        with tempfile.TemporaryDirectory() as base:
            root = fixture(base, [("big", "big/screenshot.jpg")])
            theme(root, "big", {"config.json": b"{}", "screenshot.jpg": JPEG, "wallpaper.jpg": b"x" * 2048})
            with mock.patch.object(catalog, "THEME_MAX_BYTES", 1024), self.assertRaises(catalog.Refused) as caught:
                self.build(root)
            self.assertIn("unpacks", str(caught.exception))

    def test_screenshot_over_its_cap_is_refused(self):
        with tempfile.TemporaryDirectory() as base:
            root = fixture(base, [("heavy", "heavy/screenshot.jpg")])
            theme(root, "heavy", {"config.json": b"{}", "screenshot.jpg": b"x" * (catalog.SCREENSHOT_MAX_BYTES + 1)})
            with self.assertRaises(catalog.Refused):
                self.build(root)

    def test_addon_without_built_apk_is_refused(self):
        with tempfile.TemporaryDirectory() as base:
            root = fixture(base, [], ["clock"])
            (root / "addons" / "clock").mkdir()
            (root / "addons" / "clock" / "screenshot.jpg").write_bytes(JPEG)
            with self.assertRaises(catalog.Refused) as caught:
                self.build(root)
            self.assertIn("APK", str(caught.exception))

    def test_addon_apk_over_the_cap_is_refused(self):
        with tempfile.TemporaryDirectory() as base, tempfile.TemporaryDirectory() as apks:
            root = fixture(base, [], ["clock"])
            (root / "addons" / "clock").mkdir()
            (root / "addons" / "clock" / "screenshot.jpg").write_bytes(JPEG)
            (Path(apks) / "clock.apk").write_bytes(b"x" * 2048)
            with mock.patch.object(catalog, "APK_MAX_BYTES", 1024), self.assertRaises(catalog.Refused):
                self.build(root, apks)

    def test_only_launcher_files_are_packed(self):
        with tempfile.TemporaryDirectory() as base, tempfile.TemporaryDirectory() as out:
            root = fixture(base, [("tidy", "tidy/screenshot.jpg")])
            theme(root, "tidy", {"config.json": b"{}", "screenshot.jpg": JPEG, "CREDITS.md": b"c",
                                 "make.py": b"p", "wallpapers/a.jpg": JPEG, "wallpapers/captions.txt": b"A",
                                 "wallpapers/notes.md": b"n"})
            catalog.build(out, out, root=root)
            with zipfile.ZipFile(Path(out) / "theme-tidy.zip") as archive:
                self.assertEqual(archive.namelist(), ["config.json", "wallpapers/a.jpg", "wallpapers/captions.txt"])

if __name__ == "__main__":
    unittest.main()
