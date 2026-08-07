import unittest

from dedupe_engine import detect_duplicates, normalize, title_family, version_tags


def saved(
    track_id,
    *,
    title="American Woman",
    artist="Lenny Kravitz",
    album="5",
    album_type="album",
    duration=265_000,
    isrc="USVI29800001",
    added="2026-08-06T00:00:00Z",
):
    return {
        "added_at": added,
        "track": {
            "id": track_id,
            "uri": f"spotify:track:{track_id}",
            "name": title,
            "artists": [{"name": artist}],
            "album": {
                "name": album,
                "album_type": album_type,
                "release_date": "1998-05-12",
            },
            "duration_ms": duration,
            "explicit": False,
            "external_ids": {"isrc": isrc},
            "is_playable": True,
        },
    }


class NormalizationTests(unittest.TestCase):
    def test_normalize_accents_and_punctuation(self):
        self.assertEqual(normalize("Radio/Vídeo & Más"), "radio video and mas")

    def test_title_family_removes_version(self):
        self.assertEqual(title_family("Take It Easy - 2013 Remaster"), "take it easy")

    def test_version_tags(self):
        self.assertEqual(version_tags("Song - Live Acoustic Version"), ("live", "acoustic"))


class DetectorTests(unittest.TestCase):
    def test_same_isrc_is_safe_and_prefers_original_album(self):
        items = [
            saved("original", album="5", album_type="album", added="2026-08-06T00:00:00Z"),
            saved(
                "greatest",
                album="Greatest Hits",
                album_type="compilation",
                duration=262_000,
                added="2025-05-22T00:00:00Z",
            ),
        ]
        result = detect_duplicates(items)
        self.assertEqual(result["summary"]["safe"], 1)
        self.assertEqual(result["groups"][0]["keeper"]["id"], "original")
        self.assertEqual(result["groups"][0]["remove"][0]["id"], "greatest")

    def test_different_isrc_same_metadata_is_probable(self):
        items = [saved("one", isrc="A"), saved("two", isrc="B", duration=266_000)]
        result = detect_duplicates(items)
        self.assertEqual(result["summary"]["probable"], 1)

    def test_live_and_studio_are_never_safe(self):
        items = [
            saved("studio", isrc="A"),
            saved("live", title="American Woman - Live", isrc="B", duration=300_000),
        ]
        result = detect_duplicates(items)
        self.assertEqual(result["summary"]["version"], 1)
        self.assertEqual(result["summary"]["removable_safe"], 0)

    def test_different_artists_are_not_grouped(self):
        items = [saved("one", artist="Lenny Kravitz"), saved("two", artist="Cover Band")]
        result = detect_duplicates(items)
        self.assertEqual(result["summary"]["total_groups"], 0)


if __name__ == "__main__":
    unittest.main()
