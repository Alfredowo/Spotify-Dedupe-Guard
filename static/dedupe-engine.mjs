const VERSION_PATTERNS = [
  ["live", /\b(live|en vivo|concert|unplugged|session)\b/g],
  ["remaster", /\b(remaster(?:ed|izado)?|anniversary)\b/g],
  ["remix", /\b(remix|mix)\b/g],
  ["acoustic", /\b(acoustic|acustic[ao])\b/g],
  ["radio edit", /\b(radio edit|radio version)\b/g],
  ["edit", /\bedit\b/g],
  ["demo", /\bdemo\b/g],
  ["instrumental", /\binstrumental\b/g],
  ["mono", /\bmono\b/g],
  ["stereo", /\bstereo\b/g],
  ["re-recorded", /\b(re-recorded|rerecorded|new recording)\b/g],
  ["sped up", /\bsped up\b/g],
  ["slowed", /\bslowed\b/g],
  ["karaoke", /\bkaraoke\b/g],
  ["cover", /\bcover\b/g],
];

const REMIX_CREDIT_SUFFIX = /\s*(?:[-–—:]\s*|\(\s*)[^()\-–—:]+\s+(?:remix|mix)\s*\)?\s*$/i;
const COMPILATION_WORDS = /\b(greatest hits|best of|the best|collection|anthology|essentials|compilation|hits|gold|retrospective)\b/i;
const GROUP_ORDER = {safe: 0, probable: 1, version: 2};

export function normalize(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function versionTags(title = "") {
  const normalized = normalize(title);
  return VERSION_PATTERNS.filter(([, pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(normalized);
  }).map(([label]) => label);
}

export function titleFamily(title = "") {
  let value = normalize(String(title).replace(REMIX_CREDIT_SUFFIX, ""));
  value = value.replace(/\b(feat|featuring|ft)\b.*$/g, "").trim();
  for (const [, pattern] of VERSION_PATTERNS) value = value.replace(pattern, " ");
  value = value.replace(/\b(19|20)\d{2}\b/g, " ");
  return value.replace(/\s+/g, " ").trim();
}

function timestamp(value) {
  if (!value) return 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toSavedTrack(saved) {
  const track = saved?.track || saved?.item || {};
  const album = track.album || {};
  const name = String(track.name || "");
  const artists = (track.artists || []).map(artist => String(artist?.name || ""));
  return {
    id: String(track.id || ""),
    uri: String(track.uri || ""),
    name,
    artists,
    album: String(album.name || ""),
    album_type: String(album.album_type || ""),
    release_date: String(album.release_date || ""),
    duration_ms: Number(track.duration_ms || 0),
    explicit: Boolean(track.explicit),
    isrc: String(track.external_ids?.isrc || "").toUpperCase(),
    added_at: String(saved?.added_at || ""),
    is_playable: track.is_playable === undefined ? true : Boolean(track.is_playable),
    tags: versionTags(name),
  };
}

function keeperScore(track) {
  let score = 0;
  const albumType = normalize(track.album_type);
  if (track.is_playable) score += 30;
  if (albumType === "album") score += 24;
  if (albumType === "compilation") score -= 20;
  if (COMPILATION_WORDS.test(track.album)) score -= 24;
  if (!track.tags.length) score += 15;
  score -= track.tags.length * 5;
  if (track.release_date) {
    const year = Number.parseInt(track.release_date.slice(0, 4), 10);
    if (Number.isFinite(year)) score += Math.max(0, 12 - (year - 1950) / 20);
  }
  return score;
}

function keeperReason(keeper, others) {
  if (normalize(keeper.album_type) === "album" && others.some(item =>
    normalize(item.album_type) === "compilation" || COMPILATION_WORDS.test(item.album))) {
    return "Se conserva la edición de álbum frente a recopilaciones.";
  }
  if (!keeper.tags.length && others.some(item => item.tags.length)) {
    return "Se conserva la edición sin etiquetas de versión.";
  }
  return "Se conserva la copia con mejor edición; la fecha más antigua resuelve empates.";
}

async function groupId(tracks, cryptoImpl) {
  const source = tracks.map(track => track.id).sort().join("|");
  const bytes = new TextEncoder().encode(source);
  const digest = await cryptoImpl.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

async function buildGroup(tracks, kind, confidence, reason, cryptoImpl) {
  const ordered = [...tracks].sort((left, right) => {
    const scoreDifference = keeperScore(right) - keeperScore(left);
    if (scoreDifference) return scoreDifference;
    return timestamp(left.added_at) - timestamp(right.added_at);
  });
  const keeper = ordered[0];
  const removals = ordered.slice(1);
  return {
    id: await groupId(ordered, cryptoImpl),
    kind,
    confidence,
    reason,
    keeper_reason: keeperReason(keeper, removals),
    keeper,
    remove: removals,
    duration_spread_ms: Math.max(...ordered.map(track => track.duration_ms)) - Math.min(...ordered.map(track => track.duration_ms)),
  };
}

function hasGenericSuffix(left, right) {
  const leftTokens = normalize(left).split(" ").filter(Boolean);
  const rightTokens = normalize(right).split(" ").filter(Boolean);
  if (leftTokens.length === rightTokens.length) return false;
  const [shorter, longer] = leftTokens.length < rightTokens.length
    ? [leftTokens, rightTokens]
    : [rightTokens, leftTokens];
  return shorter.length >= 3 && shorter.every((token, index) => token === longer[index]);
}

function candidateComponents(tracks) {
  const byArtist = new Map();
  for (const track of tracks) {
    const artistKey = normalize(track.artists[0] || "");
    if (!artistKey) continue;
    if (!byArtist.has(artistKey)) byArtist.set(artistKey, []);
    byArtist.get(artistKey).push(track);
  }

  const components = [];
  for (const artistTracks of byArtist.values()) {
    if (artistTracks.length < 2) continue;
    const adjacency = new Map(artistTracks.map(track => [track.id, new Set()]));
    const genericEdges = [];
    for (let index = 0; index < artistTracks.length; index += 1) {
      for (const right of artistTracks.slice(index + 1)) {
        const left = artistTracks[index];
        const genericSuffix = hasGenericSuffix(left.name, right.name);
        if (titleFamily(left.name) !== titleFamily(right.name) && !genericSuffix) continue;
        adjacency.get(left.id).add(right.id);
        adjacency.get(right.id).add(left.id);
        if (genericSuffix) genericEdges.push([left.id, right.id]);
      }
    }

    const trackById = new Map(artistTracks.map(track => [track.id, track]));
    const unseen = new Set(adjacency.keys());
    while (unseen.size) {
      const start = unseen.values().next().value;
      unseen.delete(start);
      const componentIds = new Set([start]);
      const stack = [start];
      while (stack.length) {
        const current = stack.pop();
        for (const neighbor of adjacency.get(current)) {
          if (!unseen.has(neighbor)) continue;
          unseen.delete(neighbor);
          componentIds.add(neighbor);
          stack.push(neighbor);
        }
      }
      if (componentIds.size < 2) continue;
      const componentTracks = [...componentIds].map(id => trackById.get(id));
      const hasSuffix = genericEdges.some(([left, right]) => componentIds.has(left) && componentIds.has(right));
      components.push([componentTracks, hasSuffix]);
    }
  }
  return components;
}

export async function detectDuplicates(savedItems, cryptoImpl = globalThis.crypto) {
  const tracks = savedItems.map(toSavedTrack).filter(track => track.id && track.uri);
  const groups = [];
  const assigned = new Set();

  const byExactMetadata = new Map();
  for (const track of tracks) {
    const key = JSON.stringify([
      track.artists.map(normalize),
      normalize(track.name),
      normalize(track.album),
      normalize(track.album_type),
      track.explicit,
      track.tags,
    ]);
    if (!byExactMetadata.has(key)) byExactMetadata.set(key, []);
    byExactMetadata.get(key).push(track);
  }

  for (const candidates of byExactMetadata.values()) {
    if (candidates.length < 2) continue;
    const durations = candidates.map(track => track.duration_ms);
    const spread = Math.max(...durations) - Math.min(...durations);
    if (spread > 2_000) continue;
    groups.push(await buildGroup(
      candidates,
      "safe",
      0.98,
      "Mismo artista, título, álbum, versión y duración; el ISRC puede variar por reedición.",
      cryptoImpl,
    ));
    candidates.forEach(track => assigned.add(track.id));
  }

  const byIsrc = new Map();
  for (const track of tracks) {
    if (assigned.has(track.id) || !track.isrc) continue;
    const key = JSON.stringify([track.isrc, normalize(track.artists[0] || "")]);
    if (!byIsrc.has(key)) byIsrc.set(key, []);
    byIsrc.get(key).push(track);
  }
  for (const candidates of byIsrc.values()) {
    if (candidates.length < 2) continue;
    const durations = candidates.map(track => track.duration_ms);
    const spread = Math.max(...durations) - Math.min(...durations);
    const signatures = new Set(candidates.map(track => JSON.stringify(track.tags)));
    if (spread > 5_000 || signatures.size !== 1) continue;
    groups.push(await buildGroup(
      candidates,
      "safe",
      1.0,
      "Mismo ISRC, artista principal y duración compatible.",
      cryptoImpl,
    ));
    candidates.forEach(track => assigned.add(track.id));
  }

  for (const [candidates, hasSuffix] of candidateComponents(tracks.filter(track => !assigned.has(track.id)))) {
    const families = new Set(candidates.map(track => titleFamily(track.name)));
    const signatures = new Set(candidates.map(track => JSON.stringify(track.tags)));
    const spread = Math.max(...candidates.map(track => track.duration_ms)) - Math.min(...candidates.map(track => track.duration_ms));
    let kind;
    let confidence;
    let reason;
    if (families.size === 1) {
      if (signatures.size > 1) {
        [kind, confidence, reason] = ["version", 0.62, "Misma familia de título, pero las etiquetas de versión no coinciden."];
      } else if (spread <= 3_000) {
        [kind, confidence, reason] = ["probable", 0.86, "Mismo artista, título normalizado, versión y duración casi idéntica."];
      } else {
        [kind, confidence, reason] = ["version", 0.58, "Mismo artista y título, pero la duración indica una edición diferente."];
      }
    } else if (!hasSuffix) {
      continue;
    } else if (signatures.size > 1) {
      [kind, confidence, reason] = ["version", 0.62, "Mismo artista y título base, pero las etiquetas de versión no coinciden."];
    } else if (spread <= 3_000) {
      [kind, confidence, reason] = ["probable", 0.84, "Mismo artista y título base; una grabación añade un sufijo y la duración es casi idéntica."];
    } else {
      [kind, confidence, reason] = ["version", 0.56, "Mismo artista y título base; el sufijo o la duración indica una edición diferente."];
    }
    groups.push(await buildGroup(candidates, kind, confidence, reason, cryptoImpl));
  }

  groups.sort((left, right) =>
    GROUP_ORDER[left.kind] - GROUP_ORDER[right.kind]
    || right.remove.length - left.remove.length
    || (left.keeper.name < right.keeper.name ? -1 : left.keeper.name > right.keeper.name ? 1 : 0));
  const removable = Object.fromEntries(Object.keys(GROUP_ORDER).map(kind => [
    kind,
    groups.filter(group => group.kind === kind).reduce((count, group) => count + group.remove.length, 0),
  ]));

  return {
    total_tracks: tracks.length,
    groups,
    summary: {
      safe: groups.filter(group => group.kind === "safe").length,
      probable: groups.filter(group => group.kind === "probable").length,
      version: groups.filter(group => group.kind === "version").length,
      removable_safe: removable.safe,
      removable_probable: removable.probable,
      removable_version: removable.version,
      total_groups: groups.length,
    },
  };
}
