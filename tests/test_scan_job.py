import threading
import unittest
from unittest.mock import patch

from app import ScanJob


class ScanJobTests(unittest.TestCase):
    def test_scan_finishes_after_the_start_request_returns(self):
        release_scan = threading.Event()
        scan_started = threading.Event()

        class FakeClient:
            def saved_tracks(self, cancel_event=None):
                scan_started.set()
                release_scan.wait(timeout=2)
                return [{"track": {"id": "one"}}]

        job = ScanJob()
        with (
            patch("app.spotify_client", return_value=FakeClient()),
            patch("app.detect_duplicates", return_value={"total_tracks": 1, "groups": []}),
            patch("app.store_scan", return_value=42),
        ):
            started = job.start()
            self.assertEqual(started["status"], "running")
            self.assertTrue(scan_started.wait(timeout=1))
            self.assertEqual(job.status()["status"], "running")
            release_scan.set()
            for _ in range(100):
                if job.status()["status"] != "running":
                    break
                threading.Event().wait(0.01)

        self.assertEqual(job.status()["status"], "completed")
        self.assertEqual(job.status()["scan_id"], 42)

    def test_second_start_reuses_the_running_scan(self):
        release_scan = threading.Event()

        class FakeClient:
            def saved_tracks(self, cancel_event=None):
                release_scan.wait(timeout=2)
                return []

        job = ScanJob()
        with (
            patch("app.spotify_client", return_value=FakeClient()),
            patch("app.detect_duplicates", return_value={"total_tracks": 0}),
            patch("app.store_scan", return_value=1),
        ):
            first = job.start()
            second = job.start()
            self.assertEqual(second["started_at"], first["started_at"])
            release_scan.set()
            for _ in range(100):
                if job.status()["status"] != "running":
                    break
                threading.Event().wait(0.01)

        self.assertEqual(job.status()["status"], "completed")

    def test_cancel_stops_scan_without_persisting_results(self):
        scan_started = threading.Event()

        class FakeClient:
            def saved_tracks(self, cancel_event=None):
                scan_started.set()
                while cancel_event is None or not cancel_event.is_set():
                    threading.Event().wait(0.01)
                return [{"track": {"id": "one"}}]

        job = ScanJob()
        with (
            patch("app.spotify_client", return_value=FakeClient()),
            patch("app.detect_duplicates") as detect_duplicates,
            patch("app.store_scan") as store_scan,
        ):
            job.start()
            self.assertTrue(scan_started.wait(timeout=1))
            self.assertEqual(job.cancel()["status"], "cancelling")
            for _ in range(100):
                if job.status()["status"] not in ScanJob.ACTIVE_STATUSES:
                    break
                threading.Event().wait(0.01)

        self.assertEqual(job.status()["status"], "cancelled")
        detect_duplicates.assert_not_called()
        store_scan.assert_not_called()

    def test_scan_failure_is_available_to_a_reloaded_page(self):
        class FakeClient:
            def saved_tracks(self, cancel_event=None):
                raise RuntimeError("Spotify no respondió")

        job = ScanJob()
        with patch("app.spotify_client", return_value=FakeClient()):
            job.start()
            for _ in range(100):
                if job.status()["status"] != "running":
                    break
                threading.Event().wait(0.01)

        self.assertEqual(job.status()["status"], "failed")
        self.assertEqual(job.status()["error"], "Spotify no respondió")


if __name__ == "__main__":
    unittest.main()
