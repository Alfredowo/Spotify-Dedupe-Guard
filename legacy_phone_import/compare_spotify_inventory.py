import json
import re
import unicodedata
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path


ROOT = Path(__file__).resolve().parent
INVENTORY = ROOT / "spotify_phone_inventory.json"
LIKED = ROOT / "spotify_liked_snapshot.json"
OUTPUT = ROOT / "spotify_comparison.json"


def norm(value: str) -> str:
    value = unicodedata.normalize("NFD", str(value or ""))
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Mn")
    value = value.lower().replace("&", " and ")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", value)).strip()


def strip_noise(value: str) -> str:
    value = norm(value)
    patterns = (
        r"\b(?:official\s+)?(?:music\s+)?video\b",
        r"\b(?:official\s+)?audio\b",
        r"\b(?:lyrics?|letra|subtitulad[oa]s?|traducid[oa]s?)\b",
        r"\b(?:en|al)\s+espanol\b",
        r"\b(?:hd|hq|high\s+quality|getthemlyrics|listenvid)\b",
        r"\bfull\s+album\s+stream\b",
    )
    for pattern in patterns:
        value = re.sub(pattern, " ", value)
    return re.sub(r"\s+", " ", value).strip()


VERSION_RE = re.compile(
    r"\b(?:live|remaster(?:ed)?|remix|acoustic|edit|radio|extended|demo|"
    r"instrumental|mono|stereo|version|mix|deluxe|anniversary|re recorded|"
    r"sped up|slowed|cover)\b"
)


def family(value: str) -> str:
    value = strip_noise(value)
    value = re.sub(r"\b(?:feat|featuring|ft)\b.*$", " ", value)
    value = re.sub(r"\b(?:from|para)\s+(?:the|la|el)\b.*$", " ", value)
    value = re.sub(r"\b(?:19|20)\d{2}\b", " ", value)
    value = VERSION_RE.sub(" ", value)
    return re.sub(r"\s+", " ", value).strip()


def ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def artist_matches(expected: str, artists: list[str]) -> bool:
    if not expected:
        return False
    return any(
        actual == expected
        or actual in expected
        or expected in actual
        or ratio(expected, actual) >= 0.88
        for actual in artists
    )


def main() -> None:
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    liked_snapshot = json.loads(LIKED.read_text(encoding="utf-8"))

    library = []
    by_title = defaultdict(list)
    fuzzy_buckets = defaultdict(list)
    for raw in liked_snapshot["tracks"]:
        item = {
            "id": raw["id"],
            "title": raw.get("title", ""),
            "title_family": family(raw.get("title", "")),
            "artists": raw.get("artists", []),
            "artist_norms": [norm(a) for a in raw.get("artists", [])],
            "album": raw.get("album", ""),
        }
        library.append(item)
        by_title[item["title_family"]].append(item)
        key = (item["title_family"][:1], len(item["title_family"]) // 5)
        fuzzy_buckets[key].append(item)

    matched, unmatched, ambiguous = [], [], []
    for phone in inventory["tracks"]:
        title_family = family(phone.get("titleHint") or phone.get("cleanName"))
        artist = norm(phone.get("artistHint", ""))
        combined = strip_noise(phone.get("cleanName", ""))
        candidates = []

        exact = by_title.get(title_family, [])
        if artist:
            candidates = [c for c in exact if artist_matches(artist, c["artist_norms"])]
        elif exact:
            with_artist = [
                c for c in exact if any(a and a in combined for a in c["artist_norms"])
            ]
            candidates = with_artist or (exact if len(exact) == 1 else [])

        if not candidates and artist and title_family:
            length_band = len(title_family) // 5
            nearby = []
            for band in range(max(0, length_band - 1), length_band + 2):
                nearby.extend(fuzzy_buckets.get((title_family[:1], band), []))
            candidates = [
                c
                for c in nearby
                if artist_matches(artist, c["artist_norms"])
                and ratio(title_family, c["title_family"]) >= 0.90
            ]

        if not candidates and not artist and len(title_family) >= 5:
            candidates = [
                c
                for c in library
                if (title_family == c["title_family"] or c["title_family"] in combined)
                and any(a and a in combined for a in c["artist_norms"])
            ]

        candidates = list({c["id"]: c for c in candidates}.values())
        result = {"phone": phone, "title_family": title_family}
        if not candidates:
            unmatched.append(result)
        elif len(candidates) == 1:
            result["spotify"] = candidates[0]
            matched.append(result)
        else:
            artist_families = {tuple(c["artist_norms"]) for c in candidates}
            if len(artist_families) == 1:
                result["spotify"] = candidates[0]
                result["alternate_candidates"] = len(candidates)
                matched.append(result)
            else:
                result["candidates"] = candidates[:10]
                ambiguous.append(result)

    exact_groups = defaultdict(list)
    version_groups = defaultdict(list)
    for phone in inventory["tracks"]:
        exact_groups[norm(phone.get("cleanName", ""))].append(phone["fileName"])
        version_key = (
            norm(phone.get("artistHint", "")),
            family(phone.get("titleHint") or phone.get("cleanName")),
        )
        version_groups[version_key].append(phone["fileName"])

    exact_duplicates = [files for files in exact_groups.values() if len(files) > 1]
    version_duplicates = [
        {"artist": key[0], "title_family": key[1], "files": files}
        for key, files in version_groups.items()
        if key[1] and len(files) > 1 and files not in exact_duplicates
    ]

    output = {
        "phone_count": inventory["count"],
        "spotify_displayed_count": liked_snapshot["displayedCount"],
        "spotify_identified_count": liked_snapshot["uniqueTrackIds"],
        "matched_count": len(matched),
        "unmatched_count": len(unmatched),
        "ambiguous_count": len(ambiguous),
        "exact_duplicates": exact_duplicates,
        "version_family_duplicates": version_duplicates,
        "matched": matched,
        "unmatched": unmatched,
        "ambiguous": ambiguous,
    }
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: output[k] for k in (
        "phone_count", "spotify_displayed_count", "spotify_identified_count",
        "matched_count", "unmatched_count", "ambiguous_count",
    )}, ensure_ascii=False))
    print("exact_duplicate_groups", len(exact_duplicates))
    print("version_family_duplicate_groups", len(version_duplicates))


if __name__ == "__main__":
    main()
