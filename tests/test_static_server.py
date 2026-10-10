import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from app import main as app_main
from static_server import StaticAppHandler


class StaticServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), StaticAppHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_root_serves_spa_even_with_oauth_query(self):
        url = self.base + "/?code=oauth-code&state=oauth-state"
        with urllib.request.urlopen(
            url, timeout=3
        ) as response:
            html = response.read().decode("utf-8")
            final_url = response.url

        self.assertEqual(response.status, 200)
        self.assertEqual(final_url, url)
        self.assertIn("<title>Spotify Dedupe Guard</title>", html)

    def test_browser_route_is_not_a_required_entrypoint(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.base + "/browser", timeout=3)

        self.assertEqual(error.exception.code, 404)

    def test_api_routes_are_not_available(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.base + "/api/status", timeout=3)

        self.assertEqual(error.exception.code, 404)

    def test_browser_client_is_served_as_a_static_asset(self):
        with urllib.request.urlopen(self.base + "/browser-client.mjs", timeout=3) as response:
            content = response.read().decode("utf-8")

        self.assertEqual(response.status, 200)
        self.assertIn("openBrowserStore", content)

    def test_app_entrypoint_uses_static_server_without_creating_server_data(self):
        with (
            patch("static_server.main") as serve_static,
            patch("app.DATA") as data_path,
            patch("app.ThreadingHTTPServer") as legacy_server_factory,
        ):
            legacy_server_factory.return_value.serve_forever.return_value = None
            app_main(open_browser=False)

        serve_static.assert_called_once_with(open_browser=False)
        data_path.mkdir.assert_not_called()


if __name__ == "__main__":
    unittest.main()
