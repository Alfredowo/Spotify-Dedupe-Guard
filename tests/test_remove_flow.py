import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import DedupeHandler, get_scan, store_scan


class FakeSpotifyClient:
    def __init__(self):
        self.backups = []
        self.removed = []
        self.restored = []

    def create_backup_playlist(self, name, uris):
        self.backups.append((name, uris))
        return {"id": "backup", "external_urls": {"spotify": "https://example.test/backup"}}

    def remove_library_items(self, uris):
        self.removed.extend(uris)

    def save_library_items(self, uris):
        self.restored.extend(uris)


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
        updated_scan = {"scan_id": 7, "groups": [], "summary": {"total_groups": 0}}

        with (
            patch("app.get_scan", return_value=scan),
            patch("app.spotify_client", return_value=client),
            patch("app.record_remove_and_update_scan", return_value=(12, updated_scan)),
        ):
            handler.api_remove()

        self.assertEqual(client.backups, [])
        self.assertEqual(client.removed, ["spotify:track:suggested"])
        self.assertFalse(response["created_backup"])
        self.assertEqual(response["removed"], 1)
        self.assertEqual(response["scan"], updated_scan)


class PersistentCleanupResultsTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_patch = patch("app.DB_PATH", Path(self.temp_dir.name) / "dedupe.sqlite3")
        self.database_patch.start()
        self.client = FakeSpotifyClient()
        self.scan_id = store_scan(
            {
                "total_tracks": 10,
                "groups": [
                    {
                        "id": "group-1",
                        "kind": "safe",
                        "confidence": 1.0,
                        "reason": "Mismo ISRC",
                        "keeper_reason": "Edición de álbum",
                        "keeper": {"id": "keeper", "uri": "spotify:track:keeper"},
                        "remove": [
                            {"id": "duplicate-1", "uri": "spotify:track:duplicate-1"},
                            {"id": "duplicate-2", "uri": "spotify:track:duplicate-2"},
                            {"id": "duplicate-3", "uri": "spotify:track:duplicate-3"},
                        ],
                    }
                ],
                "summary": {
                    "safe": 1,
                    "probable": 0,
                    "version": 0,
                    "removable_safe": 3,
                    "removable_probable": 0,
                    "removable_version": 0,
                    "total_groups": 1,
                },
            },
        )

    def tearDown(self):
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def handler_for(self, payload):
        handler = object.__new__(DedupeHandler)
        handler.body_json = lambda: payload
        response = {}
        handler.send_json = lambda value, status=200: response.update(value)
        return handler, response

    def remove(self, track_ids):
        handler, response = self.handler_for({
            "scan_id": self.scan_id,
            "track_ids": track_ids,
            "keepers": {"group-1": "keeper"},
            "create_backup": False,
        })
        with patch("app.spotify_client", return_value=self.client):
            handler.api_remove()
        return response

    def undo(self, action_id):
        handler, response = self.handler_for({"action_id": action_id})
        with patch("app.spotify_client", return_value=self.client):
            handler.api_undo()
        return response

    def test_partial_cleanups_and_undo_keep_results_in_sync(self):
        first = self.remove(["duplicate-1", "duplicate-2"])
        self.assertEqual(first["scan"]["summary"]["removable_safe"], 1)
        self.assertEqual(first["scan"]["total_tracks"], 8)
        self.assertEqual(
            [track["id"] for track in first["scan"]["groups"][0]["remove"]],
            ["duplicate-3"],
        )

        second = self.remove(["duplicate-3"])
        self.assertEqual(second["scan"]["groups"], [])
        self.assertEqual(second["scan"]["summary"]["total_groups"], 0)
        self.assertEqual(second["scan"]["total_tracks"], 7)

        restored_first = self.undo(first["action_id"])
        self.assertEqual(restored_first["scan"]["total_tracks"], 9)
        self.assertEqual(
            [track["id"] for track in restored_first["scan"]["groups"][0]["remove"]],
            ["duplicate-1", "duplicate-2"],
        )

        restored_second = self.undo(second["action_id"])
        self.assertEqual(restored_second["scan"]["total_tracks"], 10)
        self.assertEqual(
            [track["id"] for track in restored_second["scan"]["groups"][0]["remove"]],
            ["duplicate-1", "duplicate-2", "duplicate-3"],
        )
        self.assertEqual(get_scan(self.scan_id)["summary"]["removable_safe"], 3)


if __name__ == "__main__":
    unittest.main()
