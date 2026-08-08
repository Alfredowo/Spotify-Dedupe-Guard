import unittest
from unittest.mock import patch

from app import DedupeHandler


class FakeSpotifyClient:
    def __init__(self):
        self.backups = []
        self.removed = []

    def create_backup_playlist(self, name, uris):
        self.backups.append((name, uris))
        return {"id": "backup", "external_urls": {"spotify": "https://example.test/backup"}}

    def remove_library_items(self, uris):
        self.removed.extend(uris)


class RemoveFlowTests(unittest.TestCase):
    def test_user_can_change_keeper_and_skip_backup(self):
        scan = {
            "groups": [
                {
                    "id": "group-1",
                    "kind": "safe",
                    "keeper": {"id": "suggested", "uri": "spotify:track:suggested"},
                    "remove": [{"id": "chosen", "uri": "spotify:track:chosen"}],
                }
            ]
        }
        payload = {
            "scan_id": 7,
            "track_ids": ["suggested"],
            "keepers": {"group-1": "chosen"},
            "create_backup": False,
        }
        client = FakeSpotifyClient()
        handler = object.__new__(DedupeHandler)
        handler.body_json = lambda: payload
        response = {}
        handler.send_json = lambda value, status=200: response.update(value)

        with (
            patch("app.get_scan", return_value=scan),
            patch("app.spotify_client", return_value=client),
            patch("app.store_action", return_value=12),
        ):
            handler.api_remove()

        self.assertEqual(client.backups, [])
        self.assertEqual(client.removed, ["spotify:track:suggested"])
        self.assertFalse(response["created_backup"])
        self.assertEqual(response["removed"], 1)


if __name__ == "__main__":
    unittest.main()
