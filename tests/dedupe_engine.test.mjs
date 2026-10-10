import assert from "node:assert/strict";
import test from "node:test";

import {detectDuplicates} from "../static/dedupe-engine.mjs";

function savedTrack({id, name = "Song", isrc = "", addedAt = "2020-01-01T00:00:00Z", artist = "Artist", duration = 180_000}) {
  return {
    added_at: addedAt,
    track: {
      id,
      uri: `spotify:track:${id}`,
      name,
      artists: [{name: artist}],
      album: {name: "Album", album_type: "album", release_date: "2020"},
      duration_ms: duration,
      explicit: false,
      external_ids: isrc ? {isrc} : {},
      is_playable: true,
    },
  };
}

test("detects duplicate ISRCs and keeps the older like when edition quality ties", async () => {
  const result = await detectDuplicates([
    savedTrack({id: "newer", isrc: "USABC1234567", addedAt: "2022-01-01T00:00:00Z"}),
    savedTrack({id: "older", isrc: "USABC1234567", addedAt: "2019-01-01T00:00:00Z"}),
  ]);

  assert.equal(result.total_tracks, 2);
  assert.equal(result.summary.safe, 1);
  assert.equal(result.groups[0].kind, "safe");
  assert.equal(result.groups[0].keeper.id, "older");
  assert.deepEqual(result.groups[0].remove.map(track => track.id), ["newer"]);
});

test("classifies a live edition as a version and leaves different artists separate", async () => {
  const result = await detectDuplicates([
    savedTrack({id: "studio", name: "Song", artist: "Artist"}),
    savedTrack({id: "live", name: "Song - Live", artist: "Artist"}),
    savedTrack({id: "other-artist", name: "Song", artist: "Another Artist"}),
  ]);

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].kind, "version");
  assert.equal(result.summary.version, 1);
  assert.equal(result.total_tracks, 3);
});
