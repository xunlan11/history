"""文献章节目录：从整理文本识别各级标题，并按阅读顺序输出。

只读派生数据，不写库、不重跑 OCR：`build_outline` 每次按当前页面文本现算，
因此旧文献刷新即可用，手工改文本后也会立刻反映出来。
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

OUTLINE_VERSION = 1
# 标题一般很短；超过这个长度基本是正文（含以「第三章」开头的叙述句）。
HEADING_MAX_CHARS = 40
# 纯序号型（一、/（一）/1./①）最容易和正文里的有序列表混淆，额外限长。
AMBIGUOUS_MAX_CHARS = 24
TOC_TITLE = re.compile(r"^(?:目\s*录|contents|table\s+of\s+contents)$", re.I)
# 目录页常见「标题……/123」的行尾页码，识别标题时要排除。
TOC_PAGE_REF = re.compile(r"[／/]\s*\d{1,4}\s*$")
SENTENCE_BREAK = re.compile(r"[。！？!?；;，,]")

# 明确的层级标记：卷/编/篇/部分 > 章 > 节。
STRONG_RULES = (
    ("volume", re.compile(r"^第[〇零一二三四五六七八九十百千0-9]+(?:部分|编|篇|卷)"), 0),
    ("chapter", re.compile(r"^第[〇零一二三四五六七八九十百千0-9]+章"), 1),
    ("section", re.compile(r"^第[〇零一二三四五六七八九十百千0-9]+节"), 2),
)
# 序号型标记：层级靠后，且必须再满足「不是连续列表项」的条件。
AMBIGUOUS_RULES = (
    ("cn_dunhao", re.compile(r"^[一二三四五六七八九十百]+、"), 3),
    ("cn_paren", re.compile(r"^[（(][一二三四五六七八九十百]+[）)]"), 4),
    # 多级编号（1.1 / 2.3.4）几乎不会出现在正文列表里，允许紧跟标题文字。
    ("multi_level", re.compile(r"^[0-9]+(?:\.[0-9]+)+[.、]?"), 4),
    ("cn_bracket", re.compile(r"^[（(][0-9]+[）)]"), 5),
    ("number_dot", re.compile(r"^[0-9]+[.、](?:\s|$)"), 5),
    ("circled", re.compile(r"^[①-⑳]"), 6),
)
# 没有编号、但惯例上独立成行的篇章名。
KEYWORD_HEADINGS = re.compile(
    r"^(?:序|自序|代序|原序|序言|弁言|引言|前言|绪言|绪论|导言|导论|结语|结论|后记|跋|题记|"
    r"附录|参考文献|致谢|凡例|出版说明|内容提要|内容简介|编者的话|目\s*录)$"
)
# 「张序」「吴跋」这类署名序跋，以及「《…》（代序）」这类带括号的序名。
SIGNED_PREFACE = re.compile(r"^(?:[一-龥]{1,2}(?:序|跋)|.{1,34}[（(](?:代序|序言|序|跋)[）)])$")
# 「记贾宣之」「论人才」「…碑」这类短篇小标题：限长且不含句读，避免吞掉正文句子。
SHORT_TITLE = re.compile(r"^(?:记|论|谈|说)[一-龥A-Za-z0-9·《》〔〕（）()—\-]{1,12}$")
SHORT_TITLE_ENDING = re.compile(r"^[一-龥A-Za-z0-9·《》〔〕（）()—\-]{2,20}(?:记|碑|铭|表|志)$")
SHORT_TITLE_STOP = {"得", "着", "住", "载", "录", "者", "述"}
BARE_UNIT_HEADING = re.compile(r"^第[〇零一二三四五六七八九十百千0-9]+(?:部分|编|篇|卷|章|节)$")


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def page_text(page: dict[str, Any]) -> str:
    """与前端 `getPagePrimaryText` 保持一致：整理文本优先，其次 OCR 文本。"""
    return str(page.get("punctuatedText") or page.get("ocrText") or "")


def utf16_prefix(text: str) -> list[int]:
    """每个字符下标对应的 UTF-16 偏移，前端文本区间用的就是这个坐标系。"""
    offsets = [0] * (len(text) + 1)
    total = 0
    for index, char in enumerate(text):
        total += 2 if ord(char) > 0xFFFF else 1
        offsets[index + 1] = total
    return offsets


def _line_entries(text: str) -> list[dict[str, Any]]:
    """按换行切出非空行，带上 UTF-16 区间。"""
    offsets = utf16_prefix(text)
    entries, position = [], 0
    for raw in text.split("\n"):
        start = position + (len(raw) - len(raw.lstrip()))
        title = raw.strip()
        if title:
            entries.append({"title": title, "start": offsets[start],
                            "end": offsets[start + len(title)], "line": len(entries)})
        position += len(raw) + 1
    return entries


def classify(title: str) -> tuple[int, str, bool] | None:
    """返回 (层级, 规则名, 是否属于易混淆的序号型)，不是标题返回 None。"""
    text = " ".join(title.split())
    if not text or len(text) > HEADING_MAX_CHARS:
        return None
    if text[-1] in "。！？!?；;，,、：:":
        return None
    if SENTENCE_BREAK.search(text) or TOC_PAGE_REF.search(text):
        return None
    if KEYWORD_HEADINGS.fullmatch(text):
        return 0, "keyword", False
    for family, pattern, level in STRONG_RULES:
        if pattern.match(text):
            return level, family, False
    if SIGNED_PREFACE.fullmatch(text):
        return 0, "signed_preface", False
    if SHORT_TITLE.fullmatch(text) and text[1] not in SHORT_TITLE_STOP:
        return 2, "short_title", False
    if SHORT_TITLE_ENDING.fullmatch(text):
        return 2, "short_title", False
    for family, pattern, level in AMBIGUOUS_RULES:
        if pattern.match(text):
            if len(text) > AMBIGUOUS_MAX_CHARS:
                return None
            return level, family, True
    return None


def _is_list_run(candidates: list[dict[str, Any]], index: int) -> bool:
    """连续出现的同族序号行更像正文里的有序列表，而不是标题。"""
    current = candidates[index]
    if not current["ambiguous"]:
        return False
    for neighbour in (candidates[index - 1] if index else None,
                      candidates[index + 1] if index + 1 < len(candidates) else None):
        if (neighbour and neighbour["ambiguous"] and neighbour["family"] == current["family"]
                and abs(neighbour["line"] - current["line"]) == 1):
            return True
    return False


def _merge_subtitle(entry: dict[str, Any], entries: list[dict[str, Any]]) -> dict[str, Any]:
    """「第一卷」独占一行时，把下一行短的副题（如年代范围）并进标题。"""
    if not BARE_UNIT_HEADING.fullmatch(entry["title"]):
        return entry
    following = next((item for item in entries if item["line"] == entry["line"] + 1), None)
    if not following:
        return entry
    subtitle = following["title"]
    if len(subtitle) > 32 or SENTENCE_BREAK.search(subtitle) or subtitle[-1] in "。！？!?；;，,、：:":
        return entry
    if classify(subtitle) is not None:
        return entry
    return {**entry, "title": f"{entry['title']} {subtitle}", "end": following["end"]}


def _looks_like_toc_page(entries: list[dict[str, Any]], candidates: list[dict[str, Any]]) -> bool:
    if entries and TOC_TITLE.fullmatch(" ".join(entries[0]["title"].split())):
        return True
    # 整页大部分行都是序号行（目录/索引页），整页略过，避免把目录当成正文标题。
    return len(candidates) >= 5 and len(candidates) * 2 >= len(entries)


def build_outline(document: dict[str, Any]) -> dict[str, Any]:
    pages = sorted(document.get("pages") or [], key=lambda page: page.get("pageNumber", 0))
    items: list[dict[str, Any]] = []
    text_pages = 0
    for page in pages:
        text = page_text(page)
        if not text.strip():
            continue
        text_pages += 1
        entries = _line_entries(text)
        candidates = []
        for entry in entries:
            result = classify(entry["title"])
            if result is None:
                continue
            level, family, ambiguous = result
            candidates.append({**entry, "level": level, "family": family, "ambiguous": ambiguous})
        if not candidates or _looks_like_toc_page(entries, candidates):
            continue
        candidates = [_merge_subtitle(candidate, entries) for candidate in candidates]
        page_id = str(page.get("id") or "")
        page_number = int(page.get("pageNumber") or 0)
        revision = int(page.get("processingRevision") or 0)
        for index, candidate in enumerate(candidates):
            if _is_list_run(candidates, index):
                continue
            title = " ".join(candidate["title"].split())
            # 页眉会把章节名带在续页顶端，相邻页同名条目只保留第一条。
            if items and items[-1]["title"] == title and page_number - items[-1]["pageNumber"] <= 1:
                continue
            items.append({
                "title": title,
                "level": candidate["level"],
                "pageId": page_id,
                "pageNumber": page_number,
                "sourceRevision": revision,
                "start": candidate["start"],
                "end": candidate["end"],
            })
    # 只保留实际出现的层级，并按出现顺序压缩成 1..n，避免跳级缩进。
    present = sorted({item["level"] for item in items})
    levels = {level: rank + 1 for rank, level in enumerate(present)}
    for index, item in enumerate(items):
        item["id"] = f"outline-{index + 1:03d}"
        item["level"] = levels[item["level"]]
    identity = digest("\n".join(
        f"{item['pageId']}|{item['start']}|{item['level']}|{item['title']}|{item['sourceRevision']}"
        for item in items) or f"empty:{document.get('id')}")
    total_pages = max(len(pages), int((document.get("processingTask") or {}).get("totalPages") or 0))
    return {
        "version": OUTLINE_VERSION,
        "documentId": str(document.get("id") or ""),
        "outlineRevision": identity,
        "items": items,
        "total": len(items),
        "textPages": text_pages,
        "totalPages": total_pages,
        "complete": bool(pages) and text_pages == len(pages),
    }
