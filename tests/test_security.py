import unittest

from spotify_api import protect_bytes, unprotect_bytes


class TokenProtectionTests(unittest.TestCase):
    def test_round_trip_for_current_windows_user(self):
        original = b'{"refresh_token":"not-a-real-token"}'
        encrypted = protect_bytes(original)
        self.assertNotEqual(encrypted, original)
        self.assertEqual(unprotect_bytes(encrypted), original)


if __name__ == "__main__":
    unittest.main()
