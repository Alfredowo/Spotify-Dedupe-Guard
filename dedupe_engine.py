from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable


VERSION_PATTERNS: tuple[tuple[str, str], ...] = (
    ("live", r"\b(live|en vivo|concert|unplugged|session)\b"),
    ("remaster", r"\b(remaster(?:ed|izado)?|anniversary)\b"),
    ("remix", r"\b(remix|mix)\b"),
    ("acoustic", r"\b(acoustic|acustic[ao])\b"),
    ("radio edit", r"\b(radio edit|radio version)\b"),
    ("edit", r"\bedit\b"),
    ("demo", r"\bdemo\b"),
    ("instrumental", r"\binstrumental\b"),
    ("mono", r"\bmono\b"),
    ("stereo", r"\bstereo\b"),
    ("re-recorded", r"\b(re-recorded|rerecorded|new recording)\b"),
    ("sped up", r"\bsped up\b"),
    ("slowed", r"\bslowed\b"),
    ("karaoke", r"\bkaraoke\b"),
    ("cover", r"\bcover\b"),
)

COMPILATION_WORDS = re.compile(
    r"\b(greatest hits|best of|the best|collection|anthology|essentials|"
    r"compilation|hits|gold|retrospective)\b",
    re.IGNORECASE,
)


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.casefold().replace("&", " and ")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def version_tags(title: str) -> tuple[str, ...]:
    normalized = normalize(title)
    return tuple(label for label, pattern in VERSION_PATTERNS if re.search(pattern, normalized))


def title_family(title: str) -> str:
    value = normalize(title)
    value = re.sub(r"\b(feat|featuring|ft)\b.*$", "", value).strip()
    for _, pattern in VERSION_PATTERNS:
        value = re.sub(pattern, " ", value)
    value = re.sub(r"\b(19|20)\d{2}\b", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _titles_have_generic_suffix(left: str, right: str) -> bool:
    """Return whether one title is a meaningful word-prefix of the other.

    This deliberately does not try to name every possible edition suffix. The
    relationship is used only for review candidates, never as proof that two
    tracks are the same recording.
    """
    left_tokens = tuple(normalize(left).split())
    right_tokens = tuple(normalize(right).split())
    if len(left_tokens) == len(right_tokens):
        return False
    shorter, longer = sorted((left_tokens, right_tokens), key=len)
    if len(shorter) < 3:
        return False
    return longer[: len(shorter)] == shorter


def _parse_timestamp(value: str) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


@dataclass(frozen=True)
class SavedTrack:
    id: str
    uri: str
    name: str
    artists: tuple[str, ...]
    album: str
    album_type: str
    release_date: str
    duration_ms: int
    explicit: bool
    isrc: str
    added_at: str
    is_playable: bool = True
    tags: tuple[str, ...] = field(default_factory=tuple)

    @property
    def primary_artist(self) -> str:
        return self.artists[0] if self.artists else ""

    @property
    def artist_key(self) -> str:
        return normalize(self.primary_artist)

    @property
    def family_key(self) -> str:
        return title_family(self.name)

    @classmethod
    def from_api(cls, saved: dict[str, Any]) -> "SavedTrack":
        track = saved.get("track") or saved.get("item") or {}
        album = track.get("album") or {}
        return cls(
            id=str(track.get("id") or ""),
            uri=str(track.get("uri") or ""),
            name=str(track.get("name") or ""),
            artists=tuple(str(a.get("name") or "") for a in track.get("artists") or []),
            album=str(album.get("name") or ""),
            album_type=str(album.get("album_type") or ""),
            release_date=str(album.get("release_date") or ""),
            duration_ms=int(track.get("duration_ms") or 0),
            explicit=bool(track.get("explicit")),
            isrc=str((track.get("external_ids") or {}).get("isrc") or "").upper(),
            added_at=str(saved.get("added_at") or ""),
            is_playable=bool(track.get("is_playable", True)),
            tags=version_tags(str(track.get("name") or "")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "uri": self.uri,
            "name": self.name,
            "artists": list(self.artists),
            "album": self.album,
            "album_type": self.album_type,
            "release_date": self.release_date,
            "duration_ms": self.duration_ms,
            "explicit": self.explicit,
            "isrc": self.isrc,
            "added_at": self.added_at,
            "is_playable": self.is_playable,
            "tags": list(self.tags),
        }


def keeper_score(track: SavedTrack) -> tuple[float, float]:
    score = 0.0
    if track.is_playable:
        score += 30
    if normalize(track.album_type) == "album":
        score += 24
    if normalize(track.album_type) == "compilation":
        score -= 20
    if COMPILATION_WORDS.search(track.album):
        score -= 24
    if not track.tags:
        score += 15
    score -= len(track.tags) * 5
    if track.release_date:
        try:
            score += max(0, 12 - (int(track.release_date[:4]) - 1950) / 20)
        except (ValueError, IndexError):
            pass
    # Older likes win only after catalog quality, preserving the user's history on ties.
    return score, -_parse_timestamp(track.added_at)


def _keeper_reason(keeper: SavedTrack, others: Iterable[SavedTrack]) -> str:
    others = list(others)
    if normalize(keeper.album_type) == "album" and any(
        normalize(item.album_type) == "compilation" or COMPILATION_WORDS.search(item.album)
        for item in others
    ):
        return "Se conserva la edición de álbum frente a recopilaciones."
    if not keeper.tags and any(item.tags for item in others):
        return "Se conserva la edición sin etiquetas de versión."
    return "Se conserva la copia con mejor edición; la fecha más antigua resuelve empates."


def _group_id(tracks: Iterable[SavedTrack]) -> str:
    ids = "|".join(sorted(track.id for track in tracks))
    return hashlib.sha1(ids.encode("utf-8")).hexdigest()[:12]


def _build_group(tracks: list[SavedTrack], kind: str, confidence: float, reason: str) -> dict[str, Any]:
    ordered = sorted(tracks, key=keeper_score, reverse=True)
    keeper = ordered[0]
    removals = ordered[1:]
    return {
        "id": _group_id(ordered),
        "kind": kind,
        "confidence": confidence,
        "reason": reason,
        "keeper_reason": _keeper_reason(keeper, removals),
        "keeper": keeper.to_dict(),
        "remove": [track.to_dict() for track in removals],
        "duration_spread_ms": max(track.duration_ms for track in ordered)
        - min(track.duration_ms for track in ordered),
    }


def _candidate_components(tracks: list[SavedTrack]) -> list[tuple[list[SavedTrack], bool]]:
    """Build same-artist components linked by exact families or generic suffixes."""
    by_artist: dict[str, list[SavedTrack]] = {}
    for track in tracks:
        if track.artist_key:
            by_artist.setdefault(track.artist_key, []).append(track)

    components: list[tuple[list[SavedTrack], bool]] = []
    for artist_tracks in by_artist.values():
        if len(artist_tracks) < 2:
            continue
        track_by_id = {track.id: track for track in artist_tracks}
        adjacency = {track.id: set() for track in artist_tracks}
        suffix_edges: set[frozenset[str]] = set()

        for index, left in enumerate(artist_tracks):
            for right in artist_tracks[index + 1 :]:
                same_family = bool(left.family_key and left.family_key == right.family_key)
                generic_suffix = _titles_have_generic_suffix(left.name, right.name)
                if not same_family and not generic_suffix:
                    continue
                adjacency[left.id].add(right.id)
                adjacency[right.id].add(left.id)
                if generic_suffix:
                    suffix_edges.add(frozenset((left.id, right.id)))

        unseen = set(adjacency)
        while unseen:
            start = unseen.pop()
            component_ids = {start}
            stack = [start]
            while stack:
                current = stack.pop()
                for neighbor in adjacency[current] & unseen:
                    unseen.remove(neighbor)
                    component_ids.add(neighbor)
                    stack.append(neighbor)
            if len(component_ids) < 2:
                continue
            component_tracks = [track_by_id[track_id] for track_id in component_ids]
            has_generic_suffix = any(edge <= component_ids for edge in suffix_edges)
            components.append((component_tracks, has_generic_suffix))
    return components


def detect_duplicates(saved_items: list[dict[str, Any]]) -> dict[str, Any]:
    tracks = [SavedTrack.from_api(item) for item in saved_items]
    tracks = [track for track in tracks if track.id and track.uri]
    groups: list[dict[str, Any]] = []
    assigned: set[str] = set()

    # Catalog reissues sometimes expose the same recording under a different ISRC.
    # Exact visible metadata plus a near-identical duration is safe enough to treat
    # as a duplicate even when that catalog identifier changed.
    by_exact_metadata: dict[tuple[Any, ...], list[SavedTrack]] = {}
    for track in tracks:
        key = (
            tuple(normalize(artist) for artist in track.artists),
            normalize(track.name),
            normalize(track.album),
            normalize(track.album_type),
            track.explicit,
            track.tags,
        )
        by_exact_metadata.setdefault(key, []).append(track)

    for candidates in by_exact_metadata.values():
        if len(candidates) < 2:
            continue
        spread = max(t.duration_ms for t in candidates) - min(t.duration_ms for t in candidates)
        if spread <= 2_000:
            groups.append(
                _build_group(
                    candidates,
                    "safe",
                    0.98,
                    "Mismo artista, título, álbum, versión y duración; el ISRC puede variar por reedición.",
                )
            )
            assigned.update(track.id for track in candidates)

    by_isrc: dict[tuple[str, str], list[SavedTrack]] = {}
    for track in tracks:
        if track.id not in assigned and track.isrc:
            by_isrc.setdefault((track.isrc, track.artist_key), []).append(track)

    for candidates in by_isrc.values():
        if len(candidates) < 2:
            continue
        spread = max(t.duration_ms for t in candidates) - min(t.duration_ms for t in candidates)
        signatures = {track.tags for track in candidates}
        if spread <= 5_000 and len(signatures) == 1:
            groups.append(
                _build_group(
                    candidates,
                    "safe",
                    1.0,
                    "Mismo ISRC, artista principal y duración compatible.",
                )
            )
            assigned.update(track.id for track in candidates)

    unassigned = [track for track in tracks if track.id not in assigned]
    for candidates, has_generic_suffix in _candidate_components(unassigned):
        if len(candidates) < 2:
            continue
        families = {track.family_key for track in candidates}
        signatures = {track.tags for track in candidates}
        spread = max(t.duration_ms for t in candidates) - min(t.duration_ms for t in candidates)
        if len(families) == 1:
            if len(signatures) > 1:
                kind = "version"
                confidence = 0.62
                reason = "Misma familia de título, pero las etiquetas de versión no coinciden."
            elif spread <= 3_000:
                kind = "probable"
                confidence = 0.86
                reason = "Mismo artista, título normalizado, versión y duración casi idéntica."
            else:
                kind = "version"
                confidence = 0.58
                reason = "Mismo artista y título, pero la duración indica una edición diferente."
        elif not has_generic_suffix:
            continue
        elif len(signatures) > 1:
            kind = "version"
            confidence = 0.62
            reason = "Mismo artista y título base, pero las etiquetas de versión no coinciden."
        elif spread <= 3_000:
            kind = "probable"
            confidence = 0.84
            reason = "Mismo artista y título base; una grabación añade un sufijo y la duración es casi idéntica."
        else:
            kind = "version"
            confidence = 0.56
            reason = "Mismo artista y título base; el sufijo o la duración indica una edición diferente."
        groups.append(_build_group(candidates, kind, confidence, reason))

    order = {"safe": 0, "probable": 1, "version": 2}
    groups.sort(key=lambda group: (order[group["kind"]], -len(group["remove"]), group["keeper"]["name"]))
    removable = {
        kind: sum(len(group["remove"]) for group in groups if group["kind"] == kind)
        for kind in order
    }
    return {
        "total_tracks": len(tracks),
        "groups": groups,
        "summary": {
            "safe": sum(group["kind"] == "safe" for group in groups),
            "probable": sum(group["kind"] == "probable" for group in groups),
            "version": sum(group["kind"] == "version" for group in groups),
            "removable_safe": removable["safe"],
            "removable_probable": removable["probable"],
            "removable_version": removable["version"],
            "total_groups": len(groups),
        },
    }
