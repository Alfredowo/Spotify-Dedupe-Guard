import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import get_scan, invalidate_scan, store_scan


class ScanInvalidationTests(unittest.TestCase):
    def test_invalidated_scan_is_no_longer_returned_or_accepted(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch(
            "app.DB_PATH", Path(temp_dir) / "test.sqlite3"
        ):
            old_scan_id = store_scan({"total_tracks": 2, "groups": []})
            invalidate_scan(old_scan_id)

            self.assertIsNone(get_scan(old_scan_id))
            self.assertIsNone(get_scan())

            new_scan_id = store_scan({"total_tracks": 1, "groups": []})
            self.assertEqual(get_scan()["scan_id"], new_scan_id)


if __name__ == "__main__":
    unittest.main()
