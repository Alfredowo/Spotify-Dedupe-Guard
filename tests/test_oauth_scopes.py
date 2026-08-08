import unittest
import urllib.parse

from spotify_api import SpotifyClient


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


if __name__ == "__main__":
    unittest.main()
