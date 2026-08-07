import json
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from app import DedupeHandler


class ServerSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), DedupeHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_home_page_is_served(self):
        with urllib.request.urlopen(self.base + "/", timeout=3) as response:
            html = response.read().decode("utf-8")
        self.assertIn("<title>Spotify Dedupe Guard</title>", html)

    def test_status_exposes_redirect_uri(self):
        with urllib.request.urlopen(self.base + "/api/status", timeout=3) as response:
            payload = json.load(response)
        self.assertEqual(payload["redirect_uri"], "http://127.0.0.1:8765/callback")
        self.assertFalse(payload["authenticated"])


if __name__ == "__main__":
    unittest.main()
