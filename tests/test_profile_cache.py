import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from app import ProfileCache


class ProfileCacheTests(unittest.TestCase):
    def test_refresh_runs_in_background_and_caches_profile(self):
        refreshed = threading.Event()

        class FakeClient:
            def profile(self):
                refreshed.set()
                return {"display_name": "Alfred SC", "id": "alfred", "images": []}

        with tempfile.TemporaryDirectory() as temp_dir:
            cache = ProfileCache(Path(temp_dir) / "profile.json")
            with patch("app.spotify_client", return_value=FakeClient()):
                cache.refresh_async()
                self.assertTrue(refreshed.wait(timeout=1))
                for _ in range(100):
                    if cache.get():
                        break
                    threading.Event().wait(0.01)

            self.assertEqual(cache.get()["display_name"], "Alfred SC")
            self.assertEqual(json.loads(cache.path.read_text(encoding="utf-8"))["id"], "alfred")


if __name__ == "__main__":
    unittest.main()
