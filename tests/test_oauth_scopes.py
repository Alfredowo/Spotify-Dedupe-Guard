import io
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

from spotify_api import RATE_LIMIT_STATE, SpotifyClient, SpotifyError, rate_limit_remaining, rate_limit_status


class FakeTokenStore:
    pass


class OAuthScopeTests(unittest.TestCase):
    def test_profile_and_library_scopes_are_requested(self):
        client = SpotifyClient("client", "http://localhost/callback", FakeTokenStore())
        query = urllib.parse.parse_qs(urllib.parse.urlparse(client.authorization_url("state", "verifier")).query)
        scopes = set(query["scope"][0].split())

        self.assertIn("user-read-private", scopes)
        self.assertIn("user-library-read", scopes)
        self.assertIn("user-library-modify", scopes)

    def test_profile_rate_limit_is_not_retried_on_page_load(self):
        request = urllib.request.Request("https://api.spotify.com/v1/me")
        error = urllib.error.HTTPError(
            request.full_url,
            429,
            "Too many requests",
            {"Retry-After": "60"},
            io.BytesIO(b'{"error":{"message":"Too many requests"}}'),
        )

        RATE_LIMIT_STATE.clear()
        try:
            with (
                patch("spotify_api.urllib.request.urlopen", side_effect=error) as urlopen,
                self.assertRaises(SpotifyError),
            ):
                SpotifyClient._read_json(request)

            urlopen.assert_called_once()
            self.assertGreaterEqual(rate_limit_remaining(), 59)
        finally:
            RATE_LIMIT_STATE.clear()

    def test_active_rate_limit_stops_requests_before_reaching_spotify(self):
        client = SpotifyClient("client", "http://localhost/callback", FakeTokenStore())
        RATE_LIMIT_STATE.block_for(30)
        try:
            with (
                patch("spotify_api.urllib.request.urlopen") as urlopen,
                self.assertRaises(SpotifyError) as context,
            ):
                client.request("GET", "/me/tracks")

            self.assertEqual(context.exception.status, 429)
            urlopen.assert_not_called()
        finally:
            RATE_LIMIT_STATE.clear()

    def test_quota_reason_is_preserved_for_the_interface(self):
        request = urllib.request.Request("https://api.spotify.com/v1/me")
        error = urllib.error.HTTPError(
            request.full_url,
            429,
            "Too many requests",
            {"Retry-After": "60"},
            io.BytesIO(b'{"error":{"message":"Too many requests","reason":"QUOTA_EXCEEDED"}}'),
        )

        RATE_LIMIT_STATE.clear()
        try:
            with (
                patch("spotify_api.urllib.request.urlopen", side_effect=error),
                self.assertRaises(SpotifyError),
            ):
                SpotifyClient._read_json(request)

            self.assertEqual(rate_limit_status()["reason"], "QUOTA_EXCEEDED")
        finally:
            RATE_LIMIT_STATE.clear()


if __name__ == "__main__":
    unittest.main()
