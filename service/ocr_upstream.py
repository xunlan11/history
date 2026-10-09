"""远程 OCR 服务端客户端。

分工：数据端只负责存储、拆页、任务编排与对外接口，**不加载任何 OCR 模型**；
识别与版面理解全部由服务端（数据处理服务器）通过 HTTP 完成。
接口契约见 `deploy/README.md`；环境变量里的 `UPSTREAM` 即服务端。

环境变量（systemd unit 里写 `Environment=`）：

- `OCR_UPSTREAM_URL`：服务端基地址，例如 `http://10.0.0.5:8080`。
  未设置即视为「服务端未部署」，所有识别接口返回 503。
- `OCR_UPSTREAM_STYLE`：`paddlex` | `native` | `auto`（默认 `auto`，
  先按 PaddleX/PaddleOCR 官方 serving 调用，404/405 时再试 native 契约）。
- `OCR_UPSTREAM_TOKEN`：可选，按 `Authorization: Bearer <token>` 发送。
- `OCR_UPSTREAM_TIMEOUT`：单页识别超时秒数，默认 180。
- `OCR_UPSTREAM_HEALTH_TIMEOUT`：健康检查超时秒数，默认 5。
- `OCR_UPSTREAM_HEALTH_PATH`：健康检查路径，默认 `/health`；设为 `none` 跳过探活。
- `OCR_UPSTREAM_GEOMETRY_FIX`：`1` 时让服务端做整页方向分类与去扭曲。
  默认关闭：保证服务端返回的坐标与数据端保存的原图一致。开启后坐标以矫正后的
  图像为准（数据端不保存矫正图）。

输出统一为内部结构（供 `service/ocr.py` 组对外响应）：

    {
      "engine": "remote:paddleocr-pp-structurev3",
      "width": 1654, "height": 2339,          # 像素，可为 None
      "blocks": [                             # 按阅读顺序
        {
          "type": "text",                     # 归一化后的版面角色
          "label": "paragraph_title",         # 服务端原始标签，便于排查
          "bbox": [x1, y1, x2, y2],
          "order": 1,
          "confidence": 0.94,
          "text": "整块文本",
          "lines": [
            {"text": "…", "confidence": 0.95, "bbox": [...], "polygon": [[x, y], ...]}
          ],
        }
      ],
      "lines": [...],                         # 展平的全部文本行
      "markdown": "…" | None,                 # 服务端整页 Markdown（PP-StructureV3 提供）
      "upstream": {"style": "paddlex", "url": "…", "latencyMs": 1234},
      "warnings": [...],
    }
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HEALTH_CACHE_SECONDS = 10.0
_health_cache: dict[str, Any] = {"at": 0.0, "value": None}

# 服务端版面标签 → 数据端统一角色。未列出的标签原样保留。
BLOCK_TYPE_MAP = {
    "doc_title": "title",
    "title": "title",
    "paragraph_title": "title",
    "text": "text",
    "abstract": "text",
    "content": "text",
    "reference": "text",
    "vertical_text": "text",
    "aside_text": "aside",
    "image": "figure",
    "figure": "figure",
    "figure_title": "figure_title",
    "table": "table",
    "table_title": "table_title",
    "header": "header",
    "footer": "footer",
    "number": "page_number",
    "footnote": "footnote",
    "vision_footnote": "footnote",
    "formula": "formula",
    "formula_number": "formula_number",
    "seal": "seal",
    "chart": "chart",
}


class OcrUpstreamError(RuntimeError):
    """服务端调用失败的基类。`code` 会随 503 响应一起返回给前端。"""

    code = "ocr_upstream_error"

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status

    def as_detail(self) -> dict[str, Any]:
        detail: dict[str, Any] = {"code": self.code, "message": str(self)}
        if self.status is not None:
            detail["upstreamStatus"] = self.status
        return detail


class OcrUpstreamNotConfigured(OcrUpstreamError):
    code = "ocr_upstream_not_configured"


class OcrUpstreamUnavailable(OcrUpstreamError):
    code = "ocr_upstream_unavailable"


class OcrUpstreamHttpError(OcrUpstreamError):
    code = "ocr_upstream_http_error"

    def __init__(self, message: str, *, status: int, body: str = "") -> None:
        super().__init__(message, status=status)
        self.body = body


class OcrUpstreamProtocolError(OcrUpstreamError):
    code = "ocr_upstream_protocol_error"


def upstream_url() -> str:
    return os.getenv("OCR_UPSTREAM_URL", "").strip().rstrip("/")


def upstream_style() -> str:
    style = os.getenv("OCR_UPSTREAM_STYLE", "auto").strip().lower()
    return style if style in {"auto", "paddlex", "native"} else "auto"


def upstream_token() -> str:
    return os.getenv("OCR_UPSTREAM_TOKEN", "").strip()


def _timeout(env_name: str, default: float) -> float:
    try:
        value = float(os.getenv(env_name, "").strip())
    except ValueError:
        return default
    return value if value > 0 else default


def recognize_timeout() -> float:
    return _timeout("OCR_UPSTREAM_TIMEOUT", 180.0)


def health_timeout() -> float:
    return _timeout("OCR_UPSTREAM_HEALTH_TIMEOUT", 5.0)


def health_path() -> str:
    """健康检查路径。设为 `none` 表示跳过低成本探活，只报配置。"""
    return os.getenv("OCR_UPSTREAM_HEALTH_PATH", "/health").strip()


def geometry_fix_enabled() -> bool:
    return os.getenv("OCR_UPSTREAM_GEOMETRY_FIX", "").strip() in {"1", "true", "True", "yes"}


def not_configured_error() -> OcrUpstreamNotConfigured:
    return OcrUpstreamNotConfigured(
        "OCR 识别能力未部署：请设置 OCR_UPSTREAM_URL 指向数据处理服务器。",
    )


def describe() -> dict[str, Any]:
    """给 /health 用的配置摘要，不发网络请求。"""
    return {
        "configured": bool(upstream_url()),
        "url": upstream_url() or None,
        "style": upstream_style(),
        "geometryFix": geometry_fix_enabled(),
        "healthPath": health_path(),
    }


def health(force: bool = False) -> dict[str, Any]:
    """探测服务端可达性。结果缓存 10 秒，避免前端轮询打爆服务端。"""
    now = time.monotonic()
    cached = _health_cache.get("value")
    if cached is not None and not force and now - _health_cache.get("at", 0.0) < HEALTH_CACHE_SECONDS:
        return cached

    summary = describe()
    result: dict[str, Any] = {**summary, "reachable": None, "ready": False, "latencyMs": None, "detail": ""}
    if not summary["configured"]:
        result["detail"] = "未设置 OCR_UPSTREAM_URL，识别能力未部署。"
        _health_cache.update({"at": now, "value": result})
        return result

    path = summary["healthPath"]
    if not path or path.lower() in {"none", "off", "-"}:
        result["detail"] = "已跳过探活（OCR_UPSTREAM_HEALTH_PATH=none）。"
        _health_cache.update({"at": now, "value": result})
        return result

    url = f"{summary['url']}{path}"
    started = time.perf_counter()
    try:
        status, body = _request_json(url, None, timeout=health_timeout(), method="GET")
    except OcrUpstreamHttpError as exc:
        # 收到 HTTP 错误仍表示可达，但认证、探活路径或服务自身存在异常。
        result["reachable"] = True
        result["detail"] = f"HTTP {exc.status}"
    except OcrUpstreamUnavailable as exc:
        result["reachable"] = False
        result["detail"] = str(exc)
    except OcrUpstreamProtocolError as exc:
        result["reachable"] = True
        result["detail"] = str(exc)
    except (OcrUpstreamError, ValueError) as exc:
        result["detail"] = str(exc)
    else:
        result["reachable"] = True
        result["ready"] = 200 <= status < 300 and body.get("ready") is not False
        result["detail"] = f"HTTP {status}"
    result["latencyMs"] = int((time.perf_counter() - started) * 1000)

    _health_cache.update({"at": now, "value": result})
    return result


def recognize_page_image(path: Path, page_number: int | None = None, mode: str = "formal") -> dict[str, Any]:
    """把单页图片交给服务端识别，返回统一结构。"""
    base = upstream_url()
    if not base:
        raise not_configured_error()
    if mode not in {"formal", "quick"}:
        mode = "formal"

    image_base64 = base64.b64encode(path.read_bytes()).decode("ascii")
    style = upstream_style()
    candidates = [style] if style != "auto" else ["paddlex", "native"]

    started = time.perf_counter()
    last_error: OcrUpstreamError | None = None
    for candidate in candidates:
        try:
            if candidate == "paddlex":
                payload = _call_paddlex(base, image_base64, path.name, page_number, mode)
                normalized = _normalize_paddlex(payload)
            else:
                payload = _call_native(base, image_base64, path.name, page_number, mode)
                normalized = _normalize_native(payload)
        except OcrUpstreamHttpError as exc:
            if style == "auto" and exc.status in {404, 405}:
                last_error = exc
                continue
            raise OcrUpstreamUnavailable(
                f"服务端识别失败（HTTP {exc.status}）：{exc.body or '无响应内容'}",
                status=exc.status,
            ) from exc
        except OcrUpstreamProtocolError as exc:
            if style == "auto" and candidate == "paddlex":
                last_error = exc
                continue
            raise

        normalized["upstream"] = {
            "style": candidate,
            "url": base,
            "latencyMs": int((time.perf_counter() - started) * 1000),
        }
        return normalized

    raise OcrUpstreamUnavailable(
        f"服务端 {base} 既不是 PaddleX 版面解析接口，也不符合 native 契约：{last_error}",
    )


def _call_paddlex(
    base: str,
    image_base64: str,
    filename: str,
    page_number: int | None,
    mode: str,
) -> dict[str, Any]:
    """PaddleX / PaddleOCR 官方 serving：POST /layout-parsing。"""
    quick = mode == "quick"
    geometry_fix = geometry_fix_enabled()
    payload = {
        "file": image_base64,
        "fileType": 1,
        "useDocOrientationClassify": geometry_fix,
        "useDocUnwarping": geometry_fix,
        "useLayoutDetection": not quick,
        "useTableRecognition": not quick,
        "useFormulaRecognition": False,
        "useSealRecognition": False,
        "useChartRecognition": False,
        "useTextlineOrientation": not quick,
        "visualize": False,
    }
    if page_number is not None:
        payload["pageNumber"] = page_number
    payload["filename"] = filename
    _status, body = _request_json(
        f"{base}/layout-parsing",
        payload,
        timeout=recognize_timeout(),
    )
    return body


def _call_native(
    base: str,
    image_base64: str,
    filename: str,
    page_number: int | None,
    mode: str,
) -> dict[str, Any]:
    """native 契约：POST /ocr，JSON + base64，响应直接是统一结构。"""
    payload: dict[str, Any] = {
        "image": image_base64,
        "filename": filename,
        "mode": mode,
    }
    if page_number is not None:
        payload["pageNumber"] = page_number
    _status, body = _request_json(f"{base}/ocr", payload, timeout=recognize_timeout())
    return body


def _request_json(
    url: str,
    payload: dict[str, Any] | None,
    *,
    timeout: float,
    method: str = "POST",
) -> tuple[int, dict[str, Any]]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json; charset=utf-8")
    token = upstream_token()
    if token:
        request.add_header("Authorization", f"Bearer {token}")

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            status = int(response.status)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:400]
        except Exception:  # noqa: BLE001 - 读取错误响应失败不影响主流程
            body = ""
        raise OcrUpstreamHttpError(f"HTTP {exc.code}", status=int(exc.code), body=body) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise OcrUpstreamUnavailable(f"无法连接服务端 {url}：{exc}") from exc

    if not raw:
        return status, {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OcrUpstreamProtocolError(f"服务端 {url} 返回的不是合法 JSON") from exc
    if not isinstance(parsed, dict):
        raise OcrUpstreamProtocolError(f"服务端 {url} 返回的 JSON 顶层不是对象")
    return status, parsed


def _normalize_paddlex(payload: dict[str, Any]) -> dict[str, Any]:
    container = payload.get("result")
    if not isinstance(container, dict):
        container = payload

    results = container.get("layoutParsingResults")
    if not isinstance(results, list) or not results:
        raise OcrUpstreamProtocolError("服务端 /layout-parsing 响应缺少 layoutParsingResults")

    first = results[0] if isinstance(results[0], dict) else {}
    pruned = first.get("prunedResult")
    if not isinstance(pruned, dict):
        pruned = {}

    width, height = _paddlex_page_size(pruned)
    lines = _paddlex_lines(pruned)
    blocks = _paddlex_blocks(pruned, lines)
    if not blocks:
        blocks = _block_from_lines(lines) or _block_from_text(_first_text(pruned, first))

    return {
        "engine": "remote:paddleocr-pp-structurev3",
        "width": width,
        "height": height,
        "blocks": blocks,
        "lines": lines,
        "markdown": _paddlex_markdown(first),
        "warnings": [],
    }


def _paddlex_page_size(pruned: dict[str, Any]) -> tuple[int | None, int | None]:
    shape = (pruned.get("doc_preprocessor_res") or {}).get("output_img_shape")
    # PaddleX 的 shape 是 [height, width]
    if isinstance(shape, (list, tuple)) and len(shape) >= 2:
        height = _int_or_none(shape[0])
        width = _int_or_none(shape[1])
        if width and height:
            return width, height

    width = _int_or_none(pruned.get("width"))
    height = _int_or_none(pruned.get("height"))
    if width and height:
        return width, height
    return None, None


def _paddlex_lines(pruned: dict[str, Any]) -> list[dict[str, Any]]:
    ocr = pruned.get("overall_ocr_res")
    if not isinstance(ocr, dict):
        ocr = pruned.get("text_paragraphs_ocr_res") if isinstance(pruned.get("text_paragraphs_ocr_res"), dict) else {}
    return _lines_from_ocr_res(ocr)


def _lines_from_ocr_res(ocr: dict[str, Any]) -> list[dict[str, Any]]:
    texts = ocr.get("rec_texts") or []
    scores = ocr.get("rec_scores") or []
    polygons = ocr.get("rec_polys") or ocr.get("dt_polys") or ocr.get("rec_boxes") or []

    lines: list[dict[str, Any]] = []
    for index, raw_text in enumerate(texts):
        text = str(raw_text).strip()
        if not text:
            continue
        polygon = _coerce_polygon(polygons[index] if index < len(polygons) else None)
        bbox = _bbox_from_polygon(polygon)
        lines.append(
            {
                "text": text,
                "confidence": _float_or_none(scores[index]) if index < len(scores) else None,
                "polygon": polygon,
                "bbox": bbox,
            }
        )
    return lines


def _paddlex_blocks(pruned: dict[str, Any], lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    parsing = pruned.get("parsing_res_list")
    blocks: list[dict[str, Any]] = []

    if isinstance(parsing, list) and parsing:
        for index, item in enumerate(parsing):
            if not isinstance(item, dict):
                continue
            label = str(item.get("block_label") or "text")
            order = _int_or_none(item.get("block_order"))
            blocks.append(
                _make_block(
                    label,
                    _coerce_bbox(item.get("block_bbox")),
                    order if order is not None else index + 1,
                    None,
                    str(item.get("block_content") or "").strip(),
                )
            )
    else:
        boxes = (pruned.get("layout_det_res") or {}).get("boxes")
        if isinstance(boxes, list):
            for index, box in enumerate(boxes):
                if not isinstance(box, dict):
                    continue
                label = str(box.get("label") or "text")
                order = _int_or_none(box.get("order"))
                blocks.append(
                    _make_block(
                        label,
                        _coerce_bbox(box.get("coordinate") or box.get("bbox")),
                        order if order is not None else index + 1,
                        _float_or_none(box.get("score")),
                        "",
                    )
                )

    if not blocks:
        return []

    blocks.sort(key=lambda block: block["order"])
    _attach_lines(blocks, lines)
    for block in blocks:
        if not block["text"]:
            block["text"] = "\n".join(line["text"] for line in block["lines"]).strip()
    return blocks


def _paddlex_markdown(first: dict[str, Any]) -> str | None:
    markdown = first.get("markdown")
    if isinstance(markdown, dict):
        text = markdown.get("text")
        if isinstance(text, str) and text.strip():
            return text
    if isinstance(markdown, str) and markdown.strip():
        return markdown
    return None


def _first_text(pruned: dict[str, Any], first: dict[str, Any]) -> str:
    ocr = pruned.get("overall_ocr_res")
    if isinstance(ocr, dict):
        texts = ocr.get("rec_texts")
        if isinstance(texts, list) and texts:
            return "\n".join(str(text) for text in texts if str(text).strip())
    markdown = _paddlex_markdown(first)
    return markdown or ""


def _normalize_native(payload: dict[str, Any]) -> dict[str, Any]:
    container = payload.get("result")
    if isinstance(container, dict) and "blocks" not in payload and "lines" not in payload:
        payload = container

    raw_blocks = payload.get("blocks")
    raw_lines = payload.get("lines")

    lines = [_normalize_line(item) for item in raw_lines] if isinstance(raw_lines, list) else []
    lines = [line for line in lines if line]

    blocks: list[dict[str, Any]] = []
    if isinstance(raw_blocks, list):
        for index, item in enumerate(raw_blocks):
            if not isinstance(item, dict):
                continue
            label = str(item.get("type") or item.get("label") or "text")
            order = _int_or_none(item.get("order"))
            block_lines = [_normalize_line(line) for line in item.get("lines") or []]
            block_lines = [line for line in block_lines if line]
            text = str(item.get("text") or "").strip()
            if not text:
                text = "\n".join(line["text"] for line in block_lines).strip()
            blocks.append(
                _make_block(
                    label,
                    _coerce_bbox(item.get("bbox")),
                    order if order is not None else index + 1,
                    _float_or_none(item.get("confidence")),
                    text,
                    block_lines,
                )
            )

    if not blocks:
        blocks = _block_from_lines(lines) or _block_from_text(str(payload.get("text") or ""))

    return {
        "engine": str(payload.get("engine") or "remote:native"),
        "width": _int_or_none(payload.get("width")),
        "height": _int_or_none(payload.get("height")),
        "blocks": blocks,
        "lines": lines or [line for block in blocks for line in block["lines"]],
        "markdown": payload.get("markdown") if isinstance(payload.get("markdown"), str) else None,
        "warnings": [str(item) for item in payload.get("warnings") or [] if str(item).strip()],
    }


def _normalize_line(item: Any) -> dict[str, Any] | None:
    if isinstance(item, str):
        text = item.strip()
        return {"text": text, "confidence": None, "polygon": [], "bbox": None} if text else None
    if not isinstance(item, dict):
        return None

    text = str(item.get("text") or "").strip()
    if not text:
        return None
    polygon = _coerce_polygon(item.get("polygon") or item.get("points") or item.get("poly"))
    return {
        "text": text,
        "confidence": _float_or_none(item.get("confidence")),
        "polygon": polygon,
        "bbox": _coerce_bbox(item.get("bbox")) or _bbox_from_polygon(polygon),
    }


def _block_type(label: str) -> str:
    key = label.strip().lower()
    return BLOCK_TYPE_MAP.get(key, key or "text")


def _make_block(
    label: str,
    bbox: list[float] | None,
    order: int,
    confidence: float | None,
    text: str,
    lines: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "type": _block_type(label),
        "label": label,
        "bbox": bbox,
        "order": order,
        "confidence": confidence,
        "text": text,
        "lines": lines if lines is not None else [],
    }


def _attach_lines(blocks: list[dict[str, Any]], lines: list[dict[str, Any]]) -> None:
    for line in lines:
        bbox = line.get("bbox")
        if not bbox:
            continue
        center = ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
        for block in blocks:
            if _point_in_bbox(center, block.get("bbox")):
                block["lines"].append(line)
                break


def _point_in_bbox(point: tuple[float, float], bbox: Any) -> bool:
    if not bbox:
        return False
    x, y = point
    return bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3]


def _block_from_lines(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not lines:
        return []
    return [
        _make_block(
            "text",
            _union_bbox([line["bbox"] for line in lines if line.get("bbox")]),
            1,
            None,
            "\n".join(line["text"] for line in lines).strip(),
            lines,
        )
    ]


def _block_from_text(text: str) -> list[dict[str, Any]]:
    text = (text or "").strip()
    if not text:
        return []
    return [_make_block("text", None, 1, None, text)]


def _union_bbox(boxes: list[Any]) -> list[float] | None:
    boxes = [box for box in boxes if box]
    if not boxes:
        return None
    return [
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    ]


def _coerce_bbox(value: Any) -> list[float] | None:
    if isinstance(value, dict):
        if {"x", "y", "width", "height"} <= set(value):
            x = _float_or_none(value.get("x"))
            y = _float_or_none(value.get("y"))
            width = _float_or_none(value.get("width"))
            height = _float_or_none(value.get("height"))
            if None not in (x, y, width, height):
                return [x, y, x + width, y + height]
        for keys in (("x1", "y1", "x2", "y2"), ("left", "top", "right", "bottom")):
            if set(keys) <= set(value):
                numbers = [_float_or_none(value.get(key)) for key in keys]
                if None not in numbers:
                    return list(numbers)  # type: ignore[arg-type]
        return None

    if isinstance(value, (list, tuple)) and len(value) >= 4:
        numbers = [_float_or_none(item) for item in value[:4]]
        if None in numbers:
            return None
        return list(numbers)  # type: ignore[arg-type]
    return None


def _coerce_polygon(value: Any) -> list[list[float]]:
    if not isinstance(value, (list, tuple)):
        return []
    points: list[list[float]] = []
    for point in value:
        if isinstance(point, dict):
            x = _float_or_none(point.get("x"))
            y = _float_or_none(point.get("y"))
        elif isinstance(point, (list, tuple)) and len(point) >= 2:
            x = _float_or_none(point[0])
            y = _float_or_none(point[1])
        else:
            return []
        if x is None or y is None:
            return []
        points.append([x, y])
    return points if len(points) >= 3 else []


def _bbox_from_polygon(polygon: list[list[float]]) -> list[float] | None:
    if not polygon:
        return None
    xs = [point[0] for point in polygon]
    ys = [point[1] for point in polygon]
    return [min(xs), min(ys), max(xs), max(ys)]


def _float_or_none(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    return number


def _int_or_none(value: Any) -> int | None:
    number = _float_or_none(value)
    return int(number) if number is not None else None
