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
# 索引载荷版本：算法变化时递增，旧索引会被重建（reconcile 落库 / load 即时重建）。
INDEX_VERSION = 3


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_for_alignment(text: str) -> str:
    return "".join(char for char in text if char.isalnum())


def reorder_lines_for_source(lines: list[dict[str, Any]], source_text: str) -> list[dict[str, Any]]:
    """按 sourceText（OCR 阅读顺序）重排文字行。

    检测器给出的行序在竖排、多栏页面上常与阅读顺序相反（同一版块内逐行颠倒），
    直接拼接会与 page.ocrText 不一致，导致整页无法对齐、所有句子都拿不到坐标。
    """
    if len(lines) < 2:
        return lines
    key = normalize_for_alignment(to_simplified(source_text or ""))
    if len(key) < 2:
        return lines
    positions, cursor = [], 0
    for index, line in enumerate(lines):
        part = normalize_for_alignment(line.get("normalizedText") or "")
        position = key.find(part, cursor) if part else -1
        if position < 0 and part:
            position = key.find(part)
        if position < 0:
            position = cursor
        else:
            cursor = max(cursor, position + len(part))
        positions.append((position, index, line))
    positions.sort(key=lambda item: (item[0], item[1]))
    return [line for _, _, line in positions]


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


def _ordered_quad(polygon):
    """4 点多边形规范成 tl, tr, br, bl（先按 y 分上下两组，组内按 x 排序）。"""
    ordered = sorted(polygon, key=lambda point: (point[1], point[0]))
    top = sorted(ordered[:2], key=lambda point: point[0])
    bottom = sorted(ordered[2:], key=lambda point: point[0])
    return top[0], top[1], bottom[1], bottom[0]


def _char_span_quad(line, low, high):
    """按行内字符比例切出字级四边形：竖排按 y 切、横排按 x 切。

    真实扫描件的文字行几乎都是带透视的 4 点四边形，直接拿 bbox 按轴切会露出相邻字；
    这里沿四边形自己的两条长边线性插值，切出的区域跟着行一起斜。
    无法判定方向（太方正/无形）时返回 None，调用方退回整列。
    """
    x1, y1, x2, y2 = line["bbox"]
    vertical = (y2 - y1) > (x2 - x1) * 2
    horizontal = (x2 - x1) > (y2 - y1) * 2
    if not vertical and not horizontal:
        return None
    polygon = [point for point in (line.get("polygon") or []) if len(point) == 2]
    if len(polygon) == 4:
        tl, tr, br, bl = _ordered_quad(polygon)
        if vertical:
            if bl[1] <= tl[1] or br[1] <= tr[1]:
                return None
            left = lambda y: tl[0] + (bl[0] - tl[0]) * (y - tl[1]) / (bl[1] - tl[1])
            right = lambda y: tr[0] + (br[0] - tr[0]) * (y - tr[1]) / (br[1] - tr[1])
            head, tail = y1 + (y2 - y1) * low, y1 + (y2 - y1) * high
            quad = [[left(head), head], [right(head), head], [right(tail), tail], [left(tail), tail]]
        else:
            if tr[0] <= tl[0] or br[0] <= bl[0]:
                return None
            top = lambda x: tl[1] + (tr[1] - tl[1]) * (x - tl[0]) / (tr[0] - tl[0])
            bottom = lambda x: bl[1] + (br[1] - bl[1]) * (x - bl[0]) / (br[0] - bl[0])
            head, tail = x1 + (x2 - x1) * low, x1 + (x2 - x1) * high
            quad = [[head, top(head)], [head, bottom(head)], [tail, bottom(tail)], [tail, top(tail)]]
    elif not polygon:
        if vertical:
            head, tail = y1 + (y2 - y1) * low, y1 + (y2 - y1) * high
            quad = [[x1, head], [x2, head], [x2, tail], [x1, tail]]
        else:
            head, tail = x1 + (x2 - x1) * low, x1 + (x2 - x1) * high
            quad = [[head, y1], [head, y2], [tail, y2], [tail, y1]]
    else:
        return None
    box = [min(point[0] for point in quad), min(point[1] for point in quad),
           max(point[0] for point in quad), max(point[1] for point in quad)]
    if box[2] <= box[0] or box[3] <= box[1]:
        return None
    return box, [[round(point[0], 2), round(point[1], 2)] for point in quad]


def _line_region(line, start, end):
    box, polygon = line.get("bbox"), line.get("polygon") or []
    if not box:
        return None, False
    normalized = normalize_for_alignment(line["normalizedText"])
    if start == 0 and end == len(normalized):
        return {"lineId": line["id"], "bbox": box, "polygon": polygon}, True
    raw = line["text"]
    positions = [i for i, c in enumerate(raw) if c.isalnum()]
    # 只有等宽全角汉字能按字符比例切；其余（混排数字/字母、字数与归一化不符）保留整行。
    if len(positions) != len(normalized) or not all(
            unicodedata.east_asian_width(c) in {"W", "F"} for c in raw):
        return {"lineId": line["id"], "bbox": box, "polygon": polygon}, False
    low = positions[start] / len(raw)
    high = (positions[end - 1] + 1) / len(raw)
    sliced = _char_span_quad(line, low, high)
    if not sliced:
        return {"lineId": line["id"], "bbox": box, "polygon": polygon}, False
    cropped, cropped_polygon = sliced
    return {"lineId": line["id"], "bbox": cropped, "polygon": cropped_polygon}, True


def build_reader_index(*, layout: dict[str, Any], source_text: str,
                       displayed_text: str, source_revision: int) -> dict[str, Any]:
    lines = reorder_lines_for_source(layout.get("lines") or [], source_text)
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
    return {**layout, "indexVersion": INDEX_VERSION,
            **reader_index_status_payload("ready", source_revision, text_hash(displayed_text)),
            "displayedText": displayed_text, "sentences": sentences}


def build_index_payload(*, layout: dict[str, Any], page: dict[str, Any],
                        source_revision: int, displayed_text: str) -> dict[str, Any]:
    """构建可用索引；一条句子都拿不到坐标时直接报错，
    避免出现「状态 ready 但整页没有任何高亮」的静默失败。"""
    index = build_reader_index(layout=layout, source_text=page.get("ocrText") or "",
                               displayed_text=displayed_text, source_revision=source_revision)
    if not any(sentence["boxes"] for sentence in index["sentences"]):
        raise ValueError("OCR 布局与正文无法对齐，没有任何句子匹配到文字行")
    return index


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


def copy_reader_index(connection, source_document_id, source_page_id, document_id, page, timestamp):
    """Copy the OCR layout and index while rebinding the independent page image."""
    row = connection.execute(
        "SELECT * FROM page_reader_indexes WHERE document_id=? AND page_id=?",
        (source_document_id, source_page_id),
    ).fetchone()
    if not row:
        return
    layout = json.loads(row["layout"])
    if layout:
        layout["imageIdentity"] = _image_identity(page)
    connection.execute("""INSERT INTO page_reader_indexes
        (page_id,document_id,status,source_revision,text_hash,layout,payload,error,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)""",
        (page["id"], document_id, row["status"], row["source_revision"], row["text_hash"],
         _json(layout), row["payload"], row["error"], timestamp))
    reconcile_reader_index(connection, document_id, page, timestamp)


def _stored_index_version(payload: str) -> int:
    try:
        return int(json.loads(payload or "{}").get("indexVersion") or 0)
    except (TypeError, ValueError, json.JSONDecodeError):
        return 0


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
    # 算法升级后旧载荷要重算：行序修正前存的索引虽为 ready，却没有任何坐标。
    outdated = status == "ready" and _stored_index_version(payload) != INDEX_VERSION
    if not layout and status == "failed":
        pass
    elif (layout.get("sourceTextHash") != text_hash(page.get("ocrText") or "") or
            layout.get("imageIdentity") != _image_identity(page)):
        status, payload, error = "stale", "{}", "OCR 或原图已变化，等待新的 OCR 布局"
    elif not page.get("proofreadingDone") or (page.get("stageStatus") or {}).get("proofreading") in {"failed", "skipped"}:
        if status != "failed":
            status, payload = "waiting_text", "{}"
    elif changed or outdated or status == "waiting_text":
        try:
            if not layout.get("imageWidth") or not layout.get("imageHeight") or not any(line.get("bbox") for line in layout.get("lines", [])):
                raise ValueError("OCR 未提供有效的图片尺寸或文字行坐标")
            index = build_index_payload(layout=layout, page=page,
                                        source_revision=revision, displayed_text=displayed)
            # 布局内的校验信息仅供服务端使用。
            index.pop("imageIdentity", None)
            index.pop("sourceTextHash", None)
            status, error, payload = "ready", "", _json(index)
        except Exception as exc:
            logger.exception("Cannot build reader index for %s", page["id"])
            status, error, payload = "failed", str(exc), "{}"
    updated = changed or outdated or status != row["status"]
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
    error = row["error"]
    if status == "ready" and _stored_index_version(row["payload"]) != INDEX_VERSION:
        # 旧版索引先按当前布局即时重建（不写库，等下次 reconcile 落库）。
        try:
            result = build_index_payload(layout=layout, page=page,
                                         source_revision=row["source_revision"],
                                         displayed_text=displayed)
        except Exception as exc:
            logger.exception("Cannot rebuild reader index for %s", page_id)
            status, error, result = "failed", str(exc), {}
    result.update(reader_index_status_payload(status, row["source_revision"], row["text_hash"], error))
    result["updatedAt"] = row["updated_at"]
    return result
