"""文献章节目录：聚合各页题名标注，按阅读顺序输出。

题名由标点、校对阶段的大模型识别并写入页数据（`outlineItems`），这里只做跨页聚合与
层级压缩：不解析正文、不猜哪个段落是标题。因此已有文献刷新即可用，重新处理某页后
目录也随之更新。
"""
from __future__ import annotations

import hashlib
from typing import Any

OUTLINE_VERSION = 1


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def page_text(page: dict[str, Any]) -> str:
    """与前端 `getPagePrimaryText` 保持一致：整理文本优先，其次 OCR 文本。"""
    return str(page.get("punctuatedText") or page.get("ocrText") or "")


# 处理任务结束后，缺文字的页不会再补，不能一直当作"目录仍在生成"。
PROCESSING_FINISHED_STATUSES = {"已完成", "处理失败", "已取消"}


def processing_active(document: dict[str, Any]) -> bool:
    task = document.get("processingTask") or {}
    return bool(task.get("backendManaged")) and task.get("status") not in PROCESSING_FINISHED_STATUSES


def page_outline_items(page: dict[str, Any]) -> list[dict[str, Any]]:
    """该页的题名标注。校对跳过时整理文本仍是标点稿，用标点阶段的标注。"""
    items = page.get("outlineItems")
    if not items and str(page.get("punctuatedText") or "") == str(page.get("punctuationDraftText") or ""):
        items = page.get("punctuationDraftOutline")
    return [item for item in items or [] if isinstance(item, dict)]


def build_outline(document: dict[str, Any]) -> dict[str, Any]:
    pages = sorted(document.get("pages") or [], key=lambda page: page.get("pageNumber", 0))
    items: list[dict[str, Any]] = []
    text_pages = 0
    for page in pages:
        text = page_text(page)
        if not text.strip():
            continue
        text_pages += 1
        page_id = str(page.get("id") or "")
        page_number = int(page.get("pageNumber") or 0)
        revision = int(page.get("processingRevision") or 0)
        for entry in page_outline_items(page):
            title = " ".join(str(entry.get("title") or "").split())
            level = int(entry.get("level") or 0)
            start, end = int(entry.get("start") or 0), int(entry.get("end") or 0)
            if not title or level <= 0 or end <= start:
                continue
            items.append({
                "title": title,
                "level": level,
                "pageId": page_id,
                "pageNumber": page_number,
                "sourceRevision": revision,
                "start": start,
                "end": end,
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
        "complete": bool(pages) and (text_pages == len(pages) or not processing_active(document)),
    }
