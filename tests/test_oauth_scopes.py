import io
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

from spotify_api import SpotifyClient, SpotifyError


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

        with (
            patch("spotify_api.urllib.request.urlopen", side_effect=error) as urlopen,
            patch("spotify_api.time.sleep") as sleep,
            self.assertRaises(SpotifyError),
        ):
            SpotifyClient._read_json(request, max_attempts=1)

        urlopen.assert_called_once()
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
