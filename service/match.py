"""Shared literal matching and sentence ranges; offsets are Unicode code points."""
from __future__ import annotations

import re
from bisect import bisect_left, bisect_right
import unicodedata


def occurrences(text: str, query: str) -> list[tuple[int, int]]:
    ranges = []
    position = text.find(query) if query else -1
    while position != -1:
        ranges.append((position, position + len(query)))
        position = text.find(query, position + 1)
    return ranges


def normalize_literal(text: str) -> tuple[str, list[int], list[int]]:
    value, starts, ends = [], [], []
    for offset, point in enumerate(text):
        if not point.isspace() and not unicodedata.category(point).startswith("P"):
            folded = point.lower()
            value.append(folded)
            starts.extend([offset] * len(folded))
            ends.extend([offset + 1] * len(folded))
    return "".join(value), starts, ends


def _han(point: str) -> bool:
    return "CJK UNIFIED IDEOGRAPH" in unicodedata.name(point, "") or "CJK COMPATIBILITY IDEOGRAPH" in unicodedata.name(point, "") or point == "\u3007"


def _latin_or_number(point: str) -> bool:
    return bool(point) and (unicodedata.category(point).startswith("N") or "LATIN" in unicodedata.name(point, ""))


def literal_match_ranges(text: str, query: str) -> list[dict]:
    exact = occurrences(text, query)
    value, starts, ends = normalize_literal(text)
    needle = normalize_literal(query)[0]
    terms = {needle} if needle else set()
    run = ""
    for point in needle + " ":
        if _han(point):
            run += point
        else:
            terms.update(run[i:i + 2] for i in range(len(run) - 1))
            run = ""
    for word in re.findall(r"[^\W_]+", query.lower()):
        if not any(_han(point) for point in word):
            terms.add(word)
    partial = []
    for term in terms:
        whole_word = all(_latin_or_number(point) for point in term)
        for first, last in occurrences(value, term):
            start, end = starts[first], ends[last - 1]
            if whole_word and (_latin_or_number(text[start - 1] if start else "") or _latin_or_number(text[end:end + 1])):
                continue
            if not any(first < end and last > start for first, last in exact):
                partial.append((start, end))
    merged = []
    for start, end in sorted(partial, key=lambda item: (item[0], -item[1])):
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    matches = [{"start": start, "end": end, "level": level}
               for level, ranges in (("exact", exact), ("partial", merged)) for start, end in ranges]
    return sorted(matches, key=lambda item: (item["start"], item["end"], item["level"]))


# Keep closing quotation marks with their sentence; decimal dots are not endings.
SENTENCE_END = re.compile(r"[。！？!?]+[”’」』）】\"']*|\.[”’」』）】\"']*(?=\s|$)|\r?\n[ \t]*\r?\n")


def sentence_boundaries(text: str) -> list[int]:
    return sorted({0, len(text), *(match.end() for match in SENTENCE_END.finditer(text))})


def sentence_excerpt(text: str, start: int, end: int, boundaries: list[int] | None = None) -> dict:
    boundaries = boundaries if boundaries is not None else sentence_boundaries(text)
    first = boundaries[max(0, bisect_right(boundaries, start) - 1)]
    last = boundaries[min(len(boundaries) - 1, bisect_left(boundaries, end))]
    while first < start and text[first].isspace():
        first += 1
    while last > end and text[last - 1].isspace():
        last -= 1
    return {"sentenceStart": first, "sentenceEnd": last, "sentenceText": text[first:last]}


def match_text(text: str, query: str) -> list[dict]:
    """Return every literal location, bounded model context and complete sentences."""
    boundaries = sentence_boundaries(text)
    matches = []
    for match in literal_match_ranges(text, query):
        start, end = max(0, match["start"] - 160), min(len(text), match["end"] + 240)
        matches.append({
            "level": match["level"], "matchStart": match["start"], "matchEnd": match["end"],
            "start": start, "end": end, "text": text[start:end], "matchedBy": ["literal"],
            "score": (match["end"] - match["start"]) / max(1, len(query)),
        } | sentence_excerpt(text, match["start"], match["end"], boundaries))
    return matches
