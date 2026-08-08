import json
import threading
import tempfile
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from app import DedupeHandler


class ServerSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.token_patch = patch("app.TOKEN_PATH", Path(cls.temp_dir.name) / "spotify_token.bin")
        cls.token_patch.start()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), DedupeHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.token_patch.stop()
        cls.temp_dir.cleanup()

    def test_home_page_is_served(self):
        with urllib.request.urlopen(self.base + "/", timeout=3) as response:
            html = response.read().decode("utf-8")
        self.assertIn("<title>Spotify Dedupe Guard</title>", html)

    def test_status_exposes_redirect_uri(self):
        with urllib.request.urlopen(self.base + "/api/status", timeout=3) as response:
            payload = json.load(response)
        self.assertEqual(payload["redirect_uri"], "http://127.0.0.1:8765/callback")
        self.assertFalse(payload["authenticated"])

    def test_status_does_not_wait_for_spotify(self):
        token_path = Path(self.temp_dir.name) / "spotify_token.bin"
        token_path.write_bytes(b"local-token-marker")
        try:
            with (
                patch("app.PROFILE_CACHE.get", return_value=None),
                patch("app.PROFILE_PATH", Path(self.temp_dir.name) / "missing-profile.json"),
                patch("app.PROFILE_CACHE.refresh_async") as refresh_profile,
            ):
                with urllib.request.urlopen(self.base + "/api/status", timeout=3) as response:
                    payload = json.load(response)
            self.assertTrue(payload["authenticated"])
            self.assertIsNone(payload["profile"])
            refresh_profile.assert_called_once_with()
        finally:
            token_path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
