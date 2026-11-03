"""tools/recovery.py keeps the records a computer wrote before the rename.

A computer that only has the old state folder gets it moved to ~/.polaris-tv, so a record written
before the rename is still the one a restore reads; one that already has ~/.polaris-tv keeps it as is.

Run from the repository root: python3 -m unittest discover -s tests -v
"""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import recovery  # noqa: E402  (needs tools/ on the path first)

class RecordsDirTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        patcher = mock.patch.object(recovery.Path, "home", return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._tmp.cleanup)

    def test_the_old_folder_is_moved_with_its_records(self):
        old = self.home / recovery.OLD_RECORDS_DIR
        old.mkdir()
        (old / "recovery-tv-1234abcd.json").write_text("{}", encoding="utf-8")
        folder = recovery.records_dir()
        self.assertEqual(folder, self.home / ".polaris-tv")
        self.assertTrue((folder / "recovery-tv-1234abcd.json").is_file())
        self.assertFalse(old.exists())

    def test_an_existing_folder_is_kept_and_the_old_one_left_alone(self):
        (self.home / ".polaris-tv").mkdir()
        (self.home / recovery.OLD_RECORDS_DIR).mkdir()
        self.assertEqual(recovery.records_dir(), self.home / ".polaris-tv")
        self.assertTrue((self.home / recovery.OLD_RECORDS_DIR).is_dir())

if __name__ == "__main__":
    unittest.main()
