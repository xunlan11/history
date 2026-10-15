"""页面阅读索引：只保存派生布局，不把坐标放入文献快照。"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Any

from service.variant import to_simplified

logger = logging.getLogger(__name__)
NON_BODY_TYPES = {"header", "footer", "page_number", "figure", "chart", "seal", "image"}
SENTENCE_END = re.compile(r'[。！？!?]+[”’」』）】]*|\.(?=\s|$)')


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_for_alignment(text: str) -> str:
    return "".join(char for char in text if char.isalnum())


def _dimension(value: Any) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else 0
    except (TypeError, ValueError):
        return 0


def _geometry(item, width, height):
    try:
        polygon = [[float(x), float(y)] for x, y in item.get("polygon", [])]
        if len(polygon) < 3:
            polygon = []
        box = item.get("bbox")
        if box is None and polygon:
            box = [min(p[0] for p in polygon), min(p[1] for p in polygon),
                   max(p[0] for p in polygon), max(p[1] for p in polygon)]
        box = [float(n) for n in box] if box is not None else []
        if len(box) != 4 or not all(math.isfinite(n) for n in box):
            return None, []
        x1, y1, x2, y2 = box
        if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
            return None, []
        if any(not (math.isfinite(x) and math.isfinite(y) and 0 <= x <= width and 0 <= y <= height)
               for x, y in polygon):
            return None, []
        return box, polygon
    except (TypeError, ValueError, OverflowError):
        return None, []


def normalize_ocr_layout(result: dict[str, Any]) -> dict[str, Any]:
    width, height = _dimension(result.get("width")), _dimension(result.get("height"))
    blocks = result.get("blocks") or []
    candidates = []
    if blocks:
        # 块顺序由 OCR 服务给出，不能再按横坐标排序（竖排、多栏会错位）。
        ordered = sorted(enumerate(blocks), key=lambda pair: pair[1].get("order", pair[0]) or 0)
        for block_number, block in ordered:
            if block.get("type") in NON_BODY_TYPES:
                continue
            block_lines = block.get("lines") or []
            if not block_lines and block.get("text"):
                # 缺少行坐标的块只参与字符对齐，不猜测块内位置。
                block_lines = [{"text": block["text"]}]
            for line in block_lines:
                candidates.append((line, block_number))
    else:
        candidates = [(line, None) for line in result.get("lines") or []]
    lines = []
    for item, block_number in candidates:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        box, polygon = _geometry(item, width, height)
        order = len(lines) + 1
        lines.append({"id": f"line-{order:03d}", "order": order, "blockOrder": block_number,
                      "text": text, "normalizedText": to_simplified(text), "bbox": box, "polygon": polygon})
    return {"imageWidth": width, "imageHeight": height, "lines": lines}


def split_sentences(text: str) -> list[dict[str, Any]]:
    boundaries = [match.end() for match in SENTENCE_END.finditer(text)]
    if not boundaries or boundaries[-1] != len(text):
        boundaries.append(len(text))
    sentences = []
    start, offset = 0, 0
    for end in boundaries:
        if end == start:
            continue
        content = text[start:end]
        length = len(content.encode("utf-16-le")) // 2
        sentences.append({"id": f"sentence-{len(sentences) + 1:03d}", "text": content,
                          "start": offset, "end": offset + length})
        start, offset = end, offset + length
    return sentences


def _line_region(line, start, end):
    box, polygon = line.get("bbox"), line.get("polygon") or []
    if not box:
        return None, False
    normalized = normalize_for_alignment(line["normalizedText"])
    if start == 0 and end == len(normalized):
        return {"lineId": line["id"], "bbox": box, "polygon": polygon}, True
    raw = line["text"]
    positions = [i for i, c in enumerate(raw) if c.isalnum()]
    x1, y1, x2, y2 = box
    axis_aligned = not polygon or (len(polygon) == 4 and
        set(map(tuple, polygon)) == {(x1, y1), (x2, y1), (x2, y2), (x1, y2)})
    # 仅对等宽汉字作按字符比例切分，其余保留整行且降低置信度。
    safe = (axis_aligned and len(positions) == len(normalized) and
            all(unicodedata.east_asian_width(c) in {"W", "F"} for c in raw))
    if not safe:
        return {"lineId": line["id"], "bbox": box, "polygon": polygon}, False
    low = positions[start] / len(raw)
    high = (positions[end - 1] + 1) / len(raw)
    if y2 - y1 > (x2 - x1) * 2:
        cropped = [x1, y1 + (y2 - y1) * low, x2, y1 + (y2 - y1) * high]
    elif x2 - x1 > (y2 - y1) * 2:
        cropped = [x1 + (x2 - x1) * low, y1, x1 + (x2 - x1) * high, y2]
    else:
        return {"lineId": line["id"], "bbox": box, "polygon": polygon}, False
    return {"lineId": line["id"], "bbox": cropped, "polygon": []}, True


def build_reader_index(*, layout: dict[str, Any], source_text: str,
                       displayed_text: str, source_revision: int) -> dict[str, Any]:
    lines = layout.get("lines") or []
    source_parts = [normalize_for_alignment(line["normalizedText"]) for line in lines]
    source = "".join(source_parts)
    target = normalize_for_alignment(to_simplified(displayed_text))
    source_consistent = source == normalize_for_alignment(to_simplified(source_text))
    # 全页对齐，避免逐句搜索在重复行上反复命中第一个区域。
    mapping = {}
    for match in SequenceMatcher(None, source, target, autojunk=False).get_matching_blocks():
        for delta in range(match.size):
            mapping[match.b + delta] = match.a + delta
    sentences, cursor = split_sentences(displayed_text), 0
    for sentence in sentences:
        chars = normalize_for_alignment(to_simplified(sentence["text"]))
        hits = [mapping[i] for i in range(cursor, cursor + len(chars)) if i in mapping]
        sentence.update(lineIds=[], boxes=[], confidence="unmatched")
        cursor += len(chars)
        if not chars or not hits:
            continue
        span = hits[-1] - hits[0] + 1
        exact = len(hits) == len(chars) and span == len(chars)
        fuzzy = (len(chars) >= 8 and len(hits) / len(chars) >= 0.9 and
                 len(chars) - len(hits) <= 2 and span <= len(chars) + 2)
        ambiguous = source != target and source.count(chars) > 1
        if not source_consistent or ambiguous or not (exact or fuzzy):
            continue
        offset, safe = 0, True
        for line, part in zip(lines, source_parts):
            # 跨越缺字的行仍保留其空间范围，但不会越过相邻句子。
            low, high = max(hits[0], offset), min(hits[-1] + 1, offset + len(part))
            if low < high:
                region, precise = _line_region(line, low - offset, high - offset)
                sentence["lineIds"].append(line["id"])
                if region and layout.get("imageWidth") and layout.get("imageHeight"):
                    sentence["boxes"].append(region)
                safe = safe and precise
            offset += len(part)
        if sentence["boxes"]:
            sentence["confidence"] = "exact" if exact and safe else "fuzzy"
    return {**layout, **reader_index_status_payload("ready", source_revision, text_hash(displayed_text)),
            "displayedText": displayed_text, "sentences": sentences}


def reader_index_status_payload(status: str, source_revision: int, text_hash: str = "", error: str = "") -> dict[str, Any]:
    return {"status": status, "sourceRevision": source_revision, "textHash": text_hash, "error": error}


def ensure_schema(connection):
    connection.execute("""CREATE TABLE page_reader_indexes (
        page_id TEXT PRIMARY KEY REFERENCES document_pages(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        status TEXT NOT NULL, source_revision INTEGER NOT NULL, text_hash TEXT NOT NULL,
        layout TEXT NOT NULL, payload TEXT NOT NULL, error TEXT NOT NULL, updated_at TEXT NOT NULL
    )""")
    connection.execute("CREATE INDEX idx_page_reader_indexes_document ON page_reader_indexes(document_id)")


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _image_identity(page):
    image = page.get("imageFile") or {}
    return {"hash": image.get("sha256") or page.get("imageHash") or "",
            "path": image.get("path") or page.get("imageUrl") or page.get("imageDataUrl") or "",
            "width": (page.get("ocr") or {}).get("width"), "height": (page.get("ocr") or {}).get("height")}


def _set_metadata(page, status, revision, digest, stamp):
    page.update(readerIndexStatus=status, readerIndexRevision=revision,
                readerIndexTextHash=digest, readerIndexUpdatedAt=stamp)


def save_ocr_layout(connection, document_id, page, result, timestamp):
    try:
        layout = normalize_ocr_layout(result)
        layout["sourceTextHash"] = text_hash(page.get("ocrText") or "")
        layout["imageIdentity"] = _image_identity(page)
        status, error = "waiting_text", ""
    except Exception as exc:
        logger.exception("Cannot normalize OCR layout for %s", page["id"])
        layout, status, error = {}, "failed", str(exc)
    revision = int(page.get("processingRevision") or 0)
    connection.execute("""INSERT INTO page_reader_indexes
        (page_id,document_id,status,source_revision,text_hash,layout,payload,error,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET
        status=excluded.status,source_revision=excluded.source_revision,text_hash='',
        layout=excluded.layout,payload='{}',error=excluded.error,updated_at=excluded.updated_at
        WHERE page_reader_indexes.document_id=excluded.document_id""",
        (page["id"], document_id, status, revision, "", _json(layout), "{}", error, timestamp))
    _set_metadata(page, status, revision, "", timestamp)


def reconcile_reader_index(connection, document_id, page, timestamp):
    row = connection.execute("SELECT * FROM page_reader_indexes WHERE page_id=? AND document_id=?",
                             (page["id"], document_id)).fetchone()
    if not row:
        for key in ("readerIndexStatus", "readerIndexRevision", "readerIndexTextHash", "readerIndexUpdatedAt"):
            page.pop(key, None)
        return
    revision = int(page.get("processingRevision") or 0)
    displayed = page.get("punctuatedText") or page.get("cleanText") or page.get("ocrText") or ""
    digest = text_hash(displayed)
    layout = json.loads(row["layout"])
    status, error, payload = row["status"], row["error"], row["payload"]
    changed = row["source_revision"] != revision or row["text_hash"] != digest
    if not layout and status == "failed":
        pass
    elif (layout.get("sourceTextHash") != text_hash(page.get("ocrText") or "") or
            layout.get("imageIdentity") != _image_identity(page)):
        status, payload, error = "stale", "{}", "OCR 或原图已变化，等待新的 OCR 布局"
    elif not page.get("proofreadingDone") or (page.get("stageStatus") or {}).get("proofreading") in {"failed", "skipped"}:
        if status != "failed":
            status, payload = "waiting_text", "{}"
    elif changed or status == "waiting_text":
        try:
            if not layout.get("imageWidth") or not layout.get("imageHeight") or not any(line.get("bbox") for line in layout.get("lines", [])):
                raise ValueError("OCR 未提供有效的图片尺寸或文字行坐标")
            index = build_reader_index(layout=layout, source_text=page.get("ocrText") or "",
                                       displayed_text=displayed, source_revision=revision)
            # 布局内的校验信息仅供服务端使用。
            index.pop("imageIdentity", None)
            index.pop("sourceTextHash", None)
            status, error, payload = "ready", "", _json(index)
        except Exception as exc:
            logger.exception("Cannot build reader index for %s", page["id"])
            status, error, payload = "failed", str(exc), "{}"
    updated = changed or status != row["status"]
    stamp = timestamp if updated else row["updated_at"]
    if updated:
        connection.execute("""UPDATE page_reader_indexes SET status=?,source_revision=?,text_hash=?,
            payload=?,error=?,updated_at=? WHERE page_id=? AND document_id=?""",
            (status, revision, digest, payload, error, stamp, page["id"], document_id))
    _set_metadata(page, status, revision, digest, stamp)


def load_reader_index(connection, document_id, page_id):
    row = connection.execute("""SELECT i.*,p.payload AS page_payload FROM page_reader_indexes i
        JOIN document_pages p ON p.id=i.page_id WHERE i.document_id=? AND i.page_id=?""",
        (document_id, page_id)).fetchone()
    if not row:
        return reader_index_status_payload("unavailable", 0)
    page = json.loads(row["page_payload"])
    displayed = page.get("punctuatedText") or page.get("cleanText") or page.get("ocrText") or ""
    status = row["status"]
    layout = json.loads(row["layout"])
    asset = connection.execute("""SELECT sha256,storage_path FROM document_files
        WHERE document_id=? AND page_id=? AND role='page-image' AND deleted_at IS NULL""",
        (document_id, page_id)).fetchone()
    identity = layout.get("imageIdentity") or {}
    image_changed = bool(identity) and asset and (asset["sha256"] != identity.get("hash") or asset["storage_path"] != identity.get("path"))
    if (row["source_revision"] != int(page.get("processingRevision") or 0) or
            row["text_hash"] != text_hash(displayed) or image_changed or
            (layout and layout.get("imageIdentity") != _image_identity(page))):
        status = "stale"
    result = json.loads(row["payload"]) if status == "ready" else {}
    result.update(reader_index_status_payload(status, row["source_revision"], row["text_hash"], row["error"]))
    result["updatedAt"] = row["updated_at"]
    return result
