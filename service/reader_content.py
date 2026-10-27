"""Ordered visual content, independent from the proofread sentence index."""
from __future__ import annotations

import base64
import bisect
import hashlib
import io
import json
import math
import os
import re
from copy import deepcopy
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from PIL import Image
from service.variant import to_simplified

VISUAL_TYPES = {"figure", "image", "chart", "table"}
CAPTION_TYPES = {"figure_title", "table_title", "chart_title", "figure_caption", "table_caption", "caption"}
NON_BODY_TYPES = VISUAL_TYPES | CAPTION_TYPES | {"header", "footer", "page_number", "seal"}
# 题注与图表之间允许夹着这些块（同组题注/注释、公式），不算距离。
CAPTION_GAP_TYPES = CAPTION_TYPES | {"formula", "formula_number"}
MAX_IMAGE_BYTES = 20 * 1024 * 1024
TABLE_CAPTION_HINT = re.compile(r"^(?:表|tab(?:le)?\.?)\s*[0-9０-９一二三四五六七八九十百零〇]*", re.I)
FIGURE_CAPTION_HINT = re.compile(r"^(?:图|fig(?:ure)?\.?|chart|illustration|map|plate)\s*[0-9０-９一二三四五六七八九十百零〇]*", re.I)
# 图表旁的“注：/Note:”说明：OCR 常把它识别成正文，需要在内容层归到图表上。
NOTE_HINT = re.compile(r"^\s*(?:注|说明|备注|note)\s*[:：]", re.I)
NOTE_MAX_CHARS = 1500


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def ordered_blocks(result):
    blocks = [b for b in result.get("blocks", []) if isinstance(b, dict)]
    return [b for _, b in sorted(enumerate(blocks), key=lambda pair: (pair[1].get("order") if isinstance(pair[1].get("order"), (int, float)) else pair[0], pair[0]))]


def body_text(result):
    return "\n".join(str(b.get("text") or "").strip() for b in ordered_blocks(result)
                     if b.get("type") not in NON_BODY_TYPES and str(b.get("text") or "").strip()).strip()


def region_for(block, width, height):
    box = block.get("bbox")
    try:
        box = [float(n) for n in box]
        if len(box) != 4 or not all(math.isfinite(n) for n in box):
            return []
        x1, y1, x2, y2 = box
        if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
            return []
        return [{"bbox": box}]
    except (TypeError, ValueError):
        return []


def block_box(block):
    try:
        x1, y1, x2, y2 = (float(n) for n in block.get("bbox"))
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(n) for n in (x1, y1, x2, y2)) or x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def visual_anchor(block, blocks):
    """图表块的插入点：OCR 常把图表块排在正文块之后，按坐标找回它在同栏正文里的位置。

    返回 contentSourceText 里的偏移。优先落在同一栏中位于图表下方的第一段正文之前；
    没有下方正文就落在上方正文之后。找不到同栏正文（无坐标、跨栏整页图）时返回块自带边界。
    """
    box = block_box(block)
    if not box:
        return block.get("sourceBoundary") or 0
    below = above = None
    for other in blocks:
        if not isinstance(other, dict) or other.get("kind") in NON_BODY_TYPES:
            continue
        if "start" not in other or "end" not in other:
            continue
        other_box = block_box(other)
        if not other_box:
            continue
        overlap = min(box[2], other_box[2]) - max(box[0], other_box[0])
        narrower = min(box[2] - box[0], other_box[2] - other_box[0])
        if narrower <= 0 or overlap < narrower * 0.5:
            continue
        if other_box[1] >= box[3] - 2:
            # 跨栏图表下方会同时有左右两栏正文，取阅读顺序最早的那段当插入点。
            if below is None or other["start"] < below:
                below = other["start"]
        elif other_box[3] <= box[1] + 2:
            if above is None or other["end"] > above:
                above = other["end"]
    if below is not None:
        return below
    if above is not None:
        return above
    return block.get("sourceBoundary") or 0


def caption_family(block):
    """图/表家族：先看“图/Fig./表/Table”文字前缀，再看上游块类型。"""
    text = re.sub(r"\s+", "", str(block.get("text") or ""))[:16]
    if TABLE_CAPTION_HINT.match(text):
        return "table"
    if FIGURE_CAPTION_HINT.match(text):
        return "figure"
    kind = str(block.get("kind") or "")
    if kind.startswith("table"):
        return "table"
    if kind.startswith(("figure", "chart")):
        return "figure"
    return ""


def family_accepts(family, visual):
    return not family or (visual.get("kind") == "table") == (family == "table")


def _gap_allowance(caption_box, visual_box, above, blocks, page_width):
    """题注与图表之间只隔着同组题注/注释或公式时返回可放宽的像素数，夹着正文返回 None。"""
    low, high = (visual_box[3], caption_box[1]) if above else (caption_box[3], visual_box[1])
    center = (caption_box[0] + caption_box[2]) / 2
    tolerance = max(1.0, 0.02 * page_width)
    allowance = 0.0
    for other in blocks:
        box = block_box(other)
        if not box or box in (caption_box, visual_box):
            continue
        if box[3] <= low or box[1] >= high or not (box[0] - tolerance <= center <= box[2] + tolerance):
            continue
        if other["kind"] not in CAPTION_GAP_TYPES:
            return None
        allowance += min(box[3] - box[1], high - low)
    return allowance


def caption_target_by_geometry(block, blocks, visuals, boxes, family, page_width, page_height):
    """按坐标找同栏、同一侧、最近的图表；图题优先配上方图表，表题优先配下方表格。"""
    caption_box = block_box(block)
    if not caption_box:
        return None
    center = (caption_box[0] + caption_box[2]) / 2
    tolerance = max(1.0, 0.02 * page_width)
    line = max(caption_box[3] - caption_box[1], 4.0)
    base_gap = max(3 * line, 0.02 * page_height)
    candidates = []
    for visual in visuals:
        visual_box = boxes.get(visual["id"])
        if not visual_box or not family_accepts(family, visual):
            continue
        if not (visual_box[0] - tolerance <= center <= visual_box[2] + tolerance):
            continue
        if visual_box[1] <= caption_box[1] and caption_box[3] <= visual_box[3]:
            candidates.append(("inside", 0.0, visual))
            continue
        above = visual_box[3] <= caption_box[1] + tolerance
        below = caption_box[3] <= visual_box[1] + tolerance
        if not above and not below:
            continue
        gap = max(0.0, caption_box[1] - visual_box[3] if above else visual_box[1] - caption_box[3])
        allowance = _gap_allowance(caption_box, visual_box, above, blocks, page_width)
        if allowance is None or gap > base_gap + min(allowance, 0.3 * page_height):
            continue
        candidates.append(("above" if above else "below", gap, visual))
    if not candidates:
        return None
    preferred = {"table": "below", "figure": "above"}.get(family)
    if preferred:
        pool = [c for c in candidates if c[0] == preferred] or [c for c in candidates if c[0] == "inside"]
        candidates = pool or candidates
    candidates.sort(key=lambda c: c[1])
    if len(candidates) > 1 and candidates[1][1] <= candidates[0][1] + 2.0:
        return None
    return candidates[0][2]


def caption_target_by_neighbor(index, blocks, by_block, family):
    """无坐标时按阅读顺序兜底：跳过紧邻的其它题注，左右各找一次，唯一才认。"""
    candidates = {}
    for step in (-1, 1):
        cursor = index + step
        while 0 <= cursor < len(blocks) and blocks[cursor]["kind"] in CAPTION_TYPES:
            cursor += step
        if not 0 <= cursor < len(blocks):
            continue
        visual = by_block.get(blocks[cursor]["id"])
        if visual and family_accepts(family, visual):
            candidates[visual["id"]] = visual
    return next(iter(candidates.values())) if len(candidates) == 1 else None


def normalize_content_blocks(result):
    """Keep source block identities and boundaries in code-point coordinates internally."""
    source, blocks = "", []
    for index, block in enumerate(ordered_blocks(result)):
        kind, text = block.get("type", "text"), str(block.get("text") or "").strip()
        entry = {"id": str(block.get("id") or f"block-{index + 1:04d}"), "kind": kind,
                 "order": index, "bbox": block.get("bbox"), "text": text,
                 "sourceBoundary": len(source)}
        if kind not in NON_BODY_TYPES and text:
            if source:
                source += "\n"
            entry["start"] = len(source)
            source += text
            entry["end"] = len(source)
        blocks.append(entry)
    return blocks


def extract_visuals(result):
    """Extract objects and attach captions by explicit id, then geometry, then reading order. 歧义保持 unassigned."""
    blocks = normalize_content_blocks(result)
    raw = ordered_blocks(result)
    width, height = result.get("width") or 0, result.get("height") or 0
    same_space = result.get("coordinateSpace") == "input"
    visuals, by_block, boxes = [], {}, {}
    for index, block in enumerate(blocks):
        if block["kind"] not in VISUAL_TYPES:
            continue
        original = raw[index]
        visual_id = f"visual-{index + 1:04d}"
        regions = region_for(block, width, height) if same_space else []
        visual = {"id": visual_id, "blockId": block["id"], "kind": "figure" if block["kind"] == "image" else block["kind"],
                  "blockOrder": index, "sourceBoundary": block["sourceBoundary"],
                  "renderMode": "image", "captions": [],
                  "sourceRegions": regions, "sourceImageWidth": width, "sourceImageHeight": height,
                  "geometryStatus": "exact" if regions else "unavailable", "status": "missing",
                  "captionCoverage": original.get("captionCoverage", "excluded")}
        # 保留资源标识，绝不按数组下标匹配无关图片。
        refs = re.findall(r'(?:src=["\']([^"\']+)["\']|!\[[^\]]*\]\(([^)]+)\))', block["text"])
        visual["resourceRef"] = original.get("imageUrl") or original.get("resourceRef") or next((a or b for a, b in refs), "")
        by_block[block["id"]] = visual
        for alias in (original.get("id"), original.get("visualId")):
            if alias is not None:
                by_block[str(alias)] = visual
        boxes[visual_id] = block_box(block) if same_space else None
        visuals.append(visual)
        block["visualId"] = visual_id
    unassigned = []
    for index, block in enumerate(blocks):
        if block["kind"] not in CAPTION_TYPES or not block["text"]:
            continue
        explicit = raw[index].get("visualId")
        if explicit is None:
            explicit = raw[index].get("parentId")
        family = caption_family(block)
        if explicit is not None:
            target = by_block.get(str(explicit))
        else:
            target = caption_target_by_geometry(block, blocks, visuals, boxes, family, width, height) if same_space else None
            if target is None:
                target = caption_target_by_neighbor(index, blocks, by_block, family)
        caption = {"id": f"caption-{index + 1:04d}", "text": block["text"], "sourceBlockIds": [block["id"]],
                   "order": index, "sourceRegions": region_for(block, width, height) if same_space else [],
                   "associationStatus": "confirmed" if target else "unassigned"}
        if target:
            caption["position"] = "before" if index < target["blockOrder"] else "after"
            target["captions"].append(caption)
            continue
        # 仍然无法确定的图注留在正文之外，不猜测归属。
        caption["position"] = "after"
        unassigned.append({"id": f"unassigned-{index + 1:04d}", "kind": "caption", "blockOrder": index,
                           "sourceBoundary": block["sourceBoundary"], "renderMode": "image", "captions": [caption],
                           "sourceRegions": caption["sourceRegions"], "sourceImageWidth": width, "sourceImageHeight": height,
                           "geometryStatus": "exact" if caption["sourceRegions"] else "unavailable", "status": "unassigned"})
    visuals.extend(unassigned)
    visuals.sort(key=lambda v: v["blockOrder"])
    return visuals, blocks


def _normalized(text):
    chars, positions = [], []
    # OpenCC 转换可能改变长度，逐字维护原文偏移以保证锚点。
    for index, char in enumerate(text):
        for value in to_simplified(char).casefold():
            if value.isalnum():
                chars.append(value)
                positions.append(index)
    return "".join(chars), positions


def _utf16_offsets(text):
    offsets = [0]
    for char in text:
        offsets.append(offsets[-1] + (2 if ord(char) > 0xffff else 1))
    return offsets


def _region_box(item):
    regions = item.get("sourceRegions") or []
    if not regions:
        return None
    try:
        x1, y1, x2, y2 = (float(n) for n in regions[0].get("bbox"))
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(n) for n in (x1, y1, x2, y2)) or x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def merge_caption_visuals(visuals, layout):
    """把未归属的题注块按坐标并回最近的图表，避免它们单独渲染成“标题归属待核对”。"""
    page_height = float(layout.get("imageHeight") or 0)
    if page_height <= 0 or len(visuals) < 2:
        return visuals
    targets = [(visual, _region_box(visual)) for visual in visuals if visual.get("kind") != "caption"]
    targets = [(visual, box) for visual, box in targets if box]
    orphans = [visual for visual in visuals if visual.get("kind") == "caption" and _region_box(visual)]
    if not targets or not orphans:
        return visuals
    merged = set()
    for orphan in orphans:
        box = _region_box(orphan)
        candidates = []
        for target, target_box in targets:
            overlap = min(box[2], target_box[2]) - max(box[0], target_box[0])
            narrower = min(box[2] - box[0], target_box[2] - target_box[0])
            if narrower <= 0 or overlap < narrower * 0.5:
                continue
            # 图表与题注之间可以夹着注释等正文块，这里只看两者自身的纵向距离。
            gap = max(0.0, target_box[1] - box[3], box[1] - target_box[3])
            if gap > page_height * 0.3:
                continue
            candidates.append((gap, target, target_box))
        if not candidates:
            continue
        candidates.sort(key=lambda entry: entry[0])
        if len(candidates) > 1 and candidates[1][0] <= candidates[0][0] + 2:
            continue  # 距离相同，归属有歧义，保持原状
        _gap, target, target_box = candidates[0]
        caption = dict((orphan.get("captions") or [{}])[0])
        if not caption.get("text"):
            continue
        caption["position"] = "after" if box[1] >= target_box[1] else "before"
        target.setdefault("captions", []).append(caption)
        merged.add(orphan["id"])
    if not merged:
        return visuals
    for target, _box in targets:
        captions = target.get("captions") or []
        if len(captions) > 1:
            # 按版面纵坐标排序，保证“注 → Note → 图题 → Fig.”的顺序。
            captions.sort(key=lambda cap: (_region_box(cap) or (0, float("inf"), 0, 0))[1])
    return [visual for visual in visuals if visual["id"] not in merged]


def leading_note_end(text: str, start: int, end: int):
    """紧跟图表之后、以“注：/Note:”开头的首段，作为图表注释单独渲染。"""
    segment = text[start:end]
    if not NOTE_HINT.match(segment):
        return None
    paragraph_end = segment.find("\n\n")
    note_end = start + (paragraph_end if paragraph_end >= 0 else len(segment))
    if note_end - start > NOTE_MAX_CHARS:
        return None
    return note_end


def build_reader_content(layout, page):
    displayed = page.get("punctuatedText") or page.get("ocrText") or ""
    source = layout.get("contentSourceText", page.get("ocrText") or "")
    visuals = deepcopy(page.get("visuals") or [])
    image_hash = page.get("imageHash") or (page.get("imageFile") or {}).get("sha256", "")
    current_image = not layout.get("contentImageHash") or layout.get("contentImageHash") == image_hash
    if not current_image:
        visuals = []
    visuals = merge_caption_visuals(visuals, layout)
    normalized_source, source_pos = _normalized(source)
    normalized_target, target_pos = _normalized(displayed)
    matches = SequenceMatcher(None, normalized_source, normalized_target, autojunk=False).get_matching_blocks() if visuals else []
    mapping = {a + k: b + k for a, b, size in matches for k in range(size)}
    # 先按完整段落断句；仅在 OCR 没有段落分隔时才退到句子边界。
    boundaries = [0] + [m.end() for m in re.finditer(r"\n+", displayed)] + [len(displayed)]
    if len(set(boundaries)) <= 2:
        boundaries += [m.end() for m in re.finditer(r"[。！？!?；;]+", displayed)]
    boundaries = sorted(set(boundaries))
    placed = []
    content_blocks = [b for b in (layout.get("contentBlocks") or []) if isinstance(b, dict)]
    blocks_by_id = {str(b.get("id")): b for b in content_blocks if b.get("id") is not None}
    for visual in visuals:
        block = blocks_by_id.get(str(visual.get("blockId") or ""))
        anchor = visual_anchor(block, content_blocks) if block else visual.get("sourceBoundary")
        boundary = min(len(source), max(0, int(anchor or 0)))
        if boundary == 0:
            point, state = 0, "aligned"
        elif boundary == len(source):
            point, state = len(displayed), "aligned"
        else:
            split = bisect.bisect_left(source_pos, boundary)
            left = next((mapping[i] for i in range(split - 1, max(-1, split - 65), -1) if i in mapping), None)
            right = next((mapping[i] for i in range(split, min(len(source_pos), split + 64)) if i in mapping), None)
            if left is not None and right is not None and left <= right:
                low, high = target_pos[left] + 1, target_pos[right]
                options = [b for b in boundaries if low <= b <= high]
                point = min(options, key=lambda b: abs(b - (low + high) / 2)) if options else min(boundaries, key=lambda b: abs(b - (low + high) / 2))
                state = "aligned" if options else "approximate"
            elif left is not None or right is not None:
                near = target_pos[left] + 1 if left is not None else target_pos[right]
                point, state = min(boundaries, key=lambda b: abs(b - near)), "approximate"
            else:
                point, state = None, "unplaced"
        placed.append((point, visual, state))
    previous = 0
    for index, (point, visual, state) in enumerate(placed):
        if point is None:
            point = next((p for p, _, _ in placed[index + 1:] if p is not None and p >= previous), len(displayed))
        if point < previous:
            point, state = previous, "approximate"
        placed[index] = (point, visual, state)
        previous = point
    offsets, items, cursor, last_visual = _utf16_offsets(displayed), [], 0, None
    for point, visual, state in placed:
        if point > cursor:
            start = cursor
            note_end = leading_note_end(displayed, start, point) if last_visual else None
            if note_end is not None:
                items.append({"type": "note", "start": offsets[start], "end": offsets[note_end],
                              "visualId": last_visual})
                start = note_end
            if point > start:
                items.append({"type": "text", "start": offsets[start], "end": offsets[point]})
        items.append({"type": "visual", "visualId": visual["id"], "placement": state})
        cursor, last_visual = point, visual["id"]
    if cursor < len(displayed):
        items.append({"type": "text", "start": offsets[cursor], "end": offsets[-1]})
    return {"version": 1, "sourceRevision": int(page.get("processingRevision") or 0),
            "textHash": digest(displayed), "displayedText": displayed, "imageHash": image_hash,
            "status": "ready", "layoutStatus": "ready" if page.get("visualsExtracted") and current_image else "layout_unavailable",
            "items": items, "visuals": {v["id"]: v for v in visuals},
            "warnings": ["源页图已变化，请重新处理本页。"] if not current_image else []}


def build_visual_catalog(document):
    pages = sorted(document.get("pages") or [], key=lambda p: p.get("pageNumber", 0))
    items, indexed = [], 0
    for page in pages:
        indexed += bool(page.get("visualsExtracted"))
        for visual in sorted(page.get("visuals") or [], key=lambda v: v.get("blockOrder", 0)):
            if visual.get("kind") == "caption":
                continue
            items.append({"pageId": page["id"], "pageNumber": page.get("pageNumber", 0), "visualId": visual["id"],
                          "kind": visual.get("kind"), "renderMode": visual.get("renderMode"),
                          "title": " ".join(c["text"] for c in visual.get("captions", []) if c.get("text")),
                          "blockOrder": visual.get("blockOrder", 0), "sourceRevision": page.get("processingRevision", 0),
                          "status": visual.get("status", "ready")})
    total_pages = max(len(pages), int((document.get("processingTask") or {}).get("totalPages") or 0))
    identity = json.dumps([items, indexed, total_pages], ensure_ascii=False, sort_keys=True)
    return {"documentId": document["id"], "catalogRevision": digest(identity), "items": items, "total": len(items),
            "indexedPages": indexed, "totalPages": total_pages, "complete": indexed == total_pages}


def _image_bytes(value):
    if not isinstance(value, str) or len(value) > MAX_IMAGE_BYTES * 2:
        raise ValueError("图片内容为空或过大")
    # JPEG 的裸 Base64 以 /9j/ 开头，不能因为首字符 / 就当作站内 URL。
    if value.startswith("/9j/"):
        try:
            data = base64.b64decode(value, validate=True)
        except ValueError:
            pass  # 不是合法 Base64，仍按正常资源地址校验。
        else:
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError("图片过大")
            return data
    data_url = value.startswith("data:")
    if data_url:
        value = value.split(",", 1)[1]
    if not data_url and (value.startswith(("http://", "https://", "/")) or re.match(r"^[^\s]+\.(?:png|jpg|jpeg|webp)(?:\?.*)?$", value, re.I)):
        base = os.getenv("OCR_UPSTREAM_URL", "").rstrip("/") + "/"
        allowed = {urlsplit(base).netloc} | {urlsplit(x.strip()).netloc for x in os.getenv("OCR_ASSET_ORIGINS", "").split(",") if x.strip()}
        url = urljoin(base, value)
        def check(target):
            parts = urlsplit(target)
            if parts.scheme not in {"http", "https"} or not parts.netloc or parts.netloc not in allowed or parts.username or parts.password:
                raise ValueError("图片资源地址不属于配置的 OCR 服务")
        class SafeRedirect(HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                check(newurl)
                return super().redirect_request(req, fp, code, msg, headers, newurl)
        check(url)
        with build_opener(SafeRedirect).open(Request(url), timeout=20) as response:
            data = response.read(MAX_IMAGE_BYTES + 1)
    else:
        data = base64.b64decode(value, validate=True)
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片过大")
    return data


def materialize_visual_images(result, source_path):
    """Worker-only resource I/O. Returned image data are internal, never cached in the browser."""
    visuals = result.get("visuals") or []
    source_bytes = Path(source_path).read_bytes()
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    with Image.open(io.BytesIO(source_bytes)) as source_image:
        for visual in visuals:
            visual["sourceImageHash"] = source_hash
            visual["sourceImageWidth"], visual["sourceImageHeight"] = source_image.size
            dimensions_match = result.get("width") == source_image.width and result.get("height") == source_image.height
            if not dimensions_match:
                visual.update(geometryStatus="unavailable", sourceRegions=[])
                for caption in visual.get("captions", []):
                    caption["sourceRegions"] = []
            reference = visual.pop("resourceRef", "")
            if not isinstance(reference, str):
                reference = reference.get("url", "") if isinstance(reference, dict) else ""
            if visual.get("kind") == "caption":
                continue
            resource_error, image = None, None
            try:
                resources = result.get("markdownImages") or {}
                value = resources.get(reference) if isinstance(resources, dict) else None
                value = value or (reference if (reference.startswith(("data:", "http://", "https://", "/")) or re.match(r"^[^\s]+\.(?:png|jpg|jpeg|webp)(?:\?.*)?$", reference, re.I)) else "")
                if isinstance(value, dict):
                    value = value.get("data") or value.get("url") or value.get("image")
                if value:
                    with Image.open(io.BytesIO(_image_bytes(value))) as resource:
                        if resource.width * resource.height > 40_000_000:
                            raise ValueError("图表图像尺寸过大")
                        resource.load()
                        image = resource.convert("RGB")
            except (ValueError, OSError, KeyError, Image.DecompressionBombError) as exc:
                resource_error = str(exc)
            try:
                if image is None:
                    if visual.get("geometryStatus") != "exact" or not visual.get("sourceRegions"):
                        raise ValueError(resource_error or "没有可验证的图表资源或原图坐标")
                    box = visual["sourceRegions"][0]["bbox"]
                    image = source_image.crop((math.floor(box[0]), math.floor(box[1]), math.ceil(box[2]), math.ceil(box[3]))).convert("RGB")
                    for caption in visual.get("captions", []):
                        caption_boxes = [region.get("bbox") for region in caption.get("sourceRegions", [])]
                        caption["inImage"] = bool(caption_boxes) and all(
                            b and box[0] <= b[0] <= b[2] <= box[2] and box[1] <= b[1] <= b[3] <= box[3]
                            for b in caption_boxes)

                output = io.BytesIO()
                image.save(output, format="PNG")
                visual["width"], visual["height"] = image.size
                visual["imageDataUrl"] = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")
                visual["status"] = "ready"
                if resource_error:
                    visual["warning"] = "上游图像资源不可用，已使用原页区域裁图。"
            except (ValueError, OSError, KeyError) as exc:
                visual["status"] = "missing"
                visual["warning"] = str(exc)
    return result
