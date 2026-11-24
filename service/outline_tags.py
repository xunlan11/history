"""页内题名标注：把大模型给出的题名清单校验成正文区间。

标注由标点、校对阶段产出，用自然段号定位（正文里按空行分段，第一段记作 1）。
这里不判断哪个段落是标题，只做三件事：确认段落存在、题名与该段开头一致、该段是短题名段，
然后换算成前端使用的 UTF-16 区间。
"""
from __future__ import annotations

import unicodedata
from typing import Any

# 题名类别 → 层级序。卷/编/篇与序跋、附录都算顶层。
TYPE_LEVELS = {"volume": 1, "front": 1, "back": 1, "chapter": 2,
               "section": 3, "subsection": 4, "entry": 5}
# 模型有时会给中文或英文别名，统一到上面的类别。
TYPE_ALIASES = {
    "volume": "volume", "part": "volume", "卷": "volume", "编": "volume", "篇": "volume",
    "chapter": "chapter", "章": "chapter",
    "section": "section", "节": "section",
    "subsection": "subsection", "subheading": "subsection", "目": "subsection",
    "小标题": "subsection", "标题": "subsection",
    "entry": "entry", "item": "entry", "条目": "entry", "件名": "entry", "题名": "entry",
    "front": "front", "preface": "front", "序": "front", "前言": "front", "凡例": "front",
    "back": "back", "appendix": "back", "附录": "back", "后记": "back", "参考文献": "back",
}
# 题名本身不会太长；超过这个长度的段落已属正文。
TITLE_MAX_CHARS = 80
# 题名不以句末点号收尾；以句号等收尾的段落是正文。
TITLE_STOP_CHARS = "。！？；，、：:"


def paragraph_spans(text: str) -> list[tuple[int, int]]:
    """非空段的字符区间（左闭右开，去掉段首尾空白）；段之间按空行分隔。"""
    spans: list[tuple[int, int]] = []
    start: int | None = None
    end = 0
    position = 0
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped:
            if start is None:
                start = position + (len(line) - len(line.lstrip()))
            end = position + len(line.rstrip())
        elif start is not None:
            spans.append((start, end))
            start = None
        position += len(line) + 1
    if start is not None:
        spans.append((start, end))
    return spans


def utf16_offsets(text: str) -> list[int]:
    """每个字符下标对应的 UTF-16 偏移；前端文本区间用的就是这个坐标系。"""
    offsets = [0] * (len(text) + 1)
    total = 0
    for index, char in enumerate(text):
        total += 2 if ord(char) > 0xFFFF else 1
        offsets[index + 1] = total
    return offsets


def _fold(char: str) -> str:
    return unicodedata.normalize("NFKC", char)


def flatten(value: Any) -> str:
    """去掉空白并做全半角归一，只用于比对。"""
    return "".join(_fold(char) for char in str(value or "") if not char.isspace())


def type_key(value: Any) -> str | None:
    key = str(value or "").strip().lower()
    return TYPE_ALIASES.get(key)


def _title_cut(paragraph: str, flat_title: str) -> int | None:
    """返回题名在段落内的结束下标；该段不是以这个题名开头时返回 None。"""
    if not flat_title:
        return None
    matched = 0
    for index, char in enumerate(paragraph):
        folded = _fold(char)
        if not folded.strip():
            continue
        for piece in folded:
            if piece.isspace():
                continue
            if matched >= len(flat_title) or piece != flat_title[matched]:
                return None
            matched += 1
            if matched == len(flat_title):
                return index + 1
    return None


def _item(text: str, spans: list[tuple[int, int]], offsets: list[int],
          paragraph: int, key: str, title: Any) -> dict[str, Any] | None:
    start, end = spans[paragraph - 1]
    cut = _title_cut(text[start:end], flatten(title))
    if cut is None:
        return None
    value = text[start:start + cut].strip()
    if not value or len(value) > TITLE_MAX_CHARS or value[-1] in TITLE_STOP_CHARS:
        return None
    return {"paragraph": paragraph, "type": key, "level": TYPE_LEVELS[key], "title": value,
            "start": offsets[start], "end": offsets[start + cut]}


def normalize_items(text: str, raw: Any, warnings: list[Any] | None = None) -> list[dict[str, Any]]:
    """校验模型返回的题名清单；段落号越界或题名对不上的条目直接丢弃。"""
    entries = raw if isinstance(raw, list) else []
    if not entries or not text.strip():
        return []
    spans = paragraph_spans(text)
    offsets = utf16_offsets(text)
    items: list[dict[str, Any]] = []
    seen: set[int] = set()
    dropped = 0
    for entry in entries:
        if not isinstance(entry, dict):
            dropped += 1
            continue
        key = type_key(entry.get("type"))
        try:
            paragraph = int(entry.get("paragraph"))
        except (TypeError, ValueError):
            dropped += 1
            continue
        if key is None or not 1 <= paragraph <= len(spans) or paragraph in seen:
            dropped += 1
            continue
        item = _item(text, spans, offsets, paragraph, key, entry.get("title"))
        if item is None:
            dropped += 1
            continue
        seen.add(paragraph)
        items.append(item)
    if dropped and warnings is not None:
        warnings.append(f"有 {dropped} 条题名标注与正文段落不符，已忽略。")
    return items


def remap_items(text: str, entries: Any) -> list[dict[str, Any]]:
    """按题名文本重新定位到给定正文：段落号失效（校对后重排）时使用。"""
    if not isinstance(entries, list) or not entries or not text.strip():
        return []
    spans = paragraph_spans(text)
    offsets = utf16_offsets(text)
    items: list[dict[str, Any]] = []
    used: set[int] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        key = type_key(entry.get("type"))
        if key is None:
            continue
        for paragraph in range(1, len(spans) + 1):
            if paragraph in used:
                continue
            item = _item(text, spans, offsets, paragraph, key, entry.get("title"))
            if item is None:
                continue
            used.add(paragraph)
            items.append(item)
            break
    items.sort(key=lambda item: item["start"])
    return items
