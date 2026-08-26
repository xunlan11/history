from __future__ import annotations

import base64
import json
import math
import os
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

APP_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = APP_DIR / "ocr-storage"
TASKS_DIR = STORAGE_DIR / "tasks"
PREPROCESS_DIR = STORAGE_DIR / "preprocessed"
PUBLIC_BASE_URL = os.getenv("OCR_PUBLIC_BASE_URL", "http://127.0.0.1:8765").rstrip("/")

TASKS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="近代军史数智平台 OCR 服务")
app.mount("/files", StaticFiles(directory=str(STORAGE_DIR)), name="files")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

OCR_ENGINE = None
TASKS: dict[str, dict[str, Any]] = {}


def get_ocr_engine():
    global OCR_ENGINE
    if OCR_ENGINE is None:
        from paddleocr import PaddleOCR

        # paddleocr 3.x：不再接受 2.x 的 use_angle_cls 参数，方向分类由
        # use_textline_orientation 控制。
        # enable_mkldnn=False：Paddle 静态模型在新执行器（PIR）+ oneDNN 下会触发
        # ConvertPirAttribute2RuntimeAttribute 未实现错误，必须关闭。
        OCR_ENGINE = PaddleOCR(
            lang="ch",
            use_textline_orientation=True,
            enable_mkldnn=False,
        )
    return OCR_ENGINE


@app.get("/health")
def health():
    return {"status": "ok", "storage": str(STORAGE_DIR)}


@app.post("/ocr")
async def recognize_page(image: UploadFile = File(...), pageNumber: str = Form("1")):
    page_path = await save_upload(image)
    result = recognize_image(page_path)
    result["pageNumber"] = int(pageNumber or 1)
    return JSONResponse(result)


@app.post("/ocr/cover-candidate")
async def extract_cover_candidate(document: UploadFile = File(...)):
    source_path = await save_upload(document, prefix=f"cover-{uuid.uuid4().hex[:8]}")
    candidate = build_cover_candidate(source_path)
    candidate["sourceFileName"] = document.filename
    return JSONResponse(candidate)


@app.post("/ocr/batch")
async def submit_batch(
    background_tasks: BackgroundTasks,
    document: UploadFile = File(...),
    documentId: str = Form(""),
    title: str = Form(""),
):
    task_id = f"task-{uuid.uuid4().hex[:12]}"
    task_dir = TASKS_DIR / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    source_path = await save_task_source(document, task_dir)
    task = {
        "taskId": task_id,
        "documentId": documentId,
        "title": title or document.filename,
        "status": "排队中",
        "message": "任务已接收，等待整本识别。",
        "totalPages": 0,
        "pages": [],
        "sourceFileName": document.filename,
        "sourcePath": str(source_path),
    }
    save_task(task)
    background_tasks.add_task(process_batch_task, task_id)

    return JSONResponse(public_task(task))


@app.get("/ocr/batch/{task_id}")
def get_batch(task_id: str):
    task = load_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return JSONResponse(public_task(task))


async def save_upload(upload: UploadFile, prefix: str | None = None) -> Path:
    suffix = Path(upload.filename or "upload.bin").suffix or ".bin"
    name = f"{prefix or uuid.uuid4().hex}{suffix}"
    path = STORAGE_DIR / "temp" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(await upload.read())
    return path


async def save_task_source(upload: UploadFile, task_dir: Path) -> Path:
    suffix = Path(upload.filename or "document.bin").suffix or ".bin"
    path = task_dir / f"source{suffix}"
    path.write_bytes(await upload.read())
    return path


def process_batch_task(task_id: str) -> None:
    task = load_task(task_id)
    if not task:
        return

    task["status"] = "处理中"
    task["message"] = "正在拆页和识别，请稍后刷新。"
    task["totalPages"] = 0
    task["completedPages"] = 0
    task["currentPage"] = 0
    task["currentPageStage"] = "准备中"
    task["currentPageProgress"] = 0
    save_task(task)

    try:
        pages, total_pages = process_document(Path(task["sourcePath"]), task_id)
        task["pages"] = pages
        task["totalPages"] = total_pages
        task["completedPages"] = total_pages
        task["currentPage"] = total_pages
        task["currentPageStage"] = "已完成"
        task["currentPageProgress"] = 100
        task["status"] = "已完成"
        task["message"] = "整本处理完成，请回到平台刷新结果。"
    except Exception as exc:  # noqa: BLE001
        task["status"] = "处理失败"
        task["message"] = f"处理失败：{exc}"

    save_task(task)


def process_document(path: Path, task_id: str) -> tuple[list[dict[str, Any]], int]:
    if path.suffix.lower() == ".pdf":
        return process_pdf(path, task_id)

    page_path = copy_image_to_page(path, task_id, 1)
    set_batch_progress(
        task_id,
        completed_pages=0,
        total_pages=1,
        current_page=1,
        stage="预处理中",
        progress=10,
    )
    result = recognize_image(
        page_path,
        page_number=1,
        task_id=task_id,
        on_progress=make_page_progress_callback(task_id, 1, 1),
    )
    set_batch_pages(task_id, [result])
    set_batch_progress(
        task_id,
        completed_pages=1,
        total_pages=1,
        current_page=1,
        stage="已完成",
        progress=100,
    )
    return [result], 1


def process_pdf(path: Path, task_id: str) -> tuple[list[dict[str, Any]], int]:
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("未安装 PDF 拆页组件 PyMuPDF") from exc

    pages: list[dict[str, Any]] = []
    doc = fitz.open(path)
    total_pages = doc.page_count
    output_dir = TASKS_DIR / task_id / "pages"
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        for index, page in enumerate(doc, start=1):
            set_batch_progress(
                task_id,
                completed_pages=index - 1,
                total_pages=total_pages,
                current_page=index,
                stage="拆页中",
                progress=5,
            )
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            image_path = output_dir / f"page-{index}.png"
            pix.save(image_path)
            pages.append(
                recognize_image(
                    image_path,
                    page_number=index,
                    task_id=task_id,
                    on_progress=make_page_progress_callback(task_id, index, total_pages),
                )
            )
            # 每页识别完成后增量写回，前端可边轮询边把已识别页交给大模型整理。
            set_batch_pages(task_id, pages)
            set_batch_progress(
                task_id,
                completed_pages=index,
                total_pages=total_pages,
                current_page=index,
                stage="已完成",
                progress=100,
            )
    finally:
        doc.close()

    return pages, total_pages


def build_cover_candidate(path: Path) -> dict[str, Any]:
    if path.suffix.lower() == ".pdf":
        image_path = render_pdf_first_page(path)
        return {
            "imageDataUrl": image_to_cover_data_url(image_path),
            "imageName": image_path.name,
            "source": "pdf-first-page",
        }

    ensure_image_readable(path)
    return {
        "imageDataUrl": image_to_cover_data_url(path),
        "imageName": path.name,
        "source": "uploaded-image",
    }


def render_pdf_first_page(path: Path) -> Path:
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("未安装 PDF 拆页组件 PyMuPDF") from exc

    output_dir = STORAGE_DIR / "temp"
    output_dir.mkdir(parents=True, exist_ok=True)
    image_path = output_dir / f"{path.stem}-cover.png"

    doc = fitz.open(path)
    try:
        if doc.page_count < 1:
            raise RuntimeError("PDF 没有可提取的页面")
        page = doc.load_page(0)
        pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
        pix.save(image_path)
    finally:
        doc.close()

    return image_path


def copy_image_to_page(path: Path, task_id: str, page_number: int) -> Path:
    output_dir = TASKS_DIR / task_id / "pages"
    output_dir.mkdir(parents=True, exist_ok=True)
    suffix = path.suffix.lower() if path.suffix else ".png"
    target = output_dir / f"page-{page_number}{suffix}"
    target.write_bytes(path.read_bytes())
    return target


def preprocess_image(
    path: Path,
    page_number: int | None = None,
    task_id: str | None = None,
) -> tuple[Path, dict[str, Any]]:
    target = preprocessed_image_path(path, page_number, task_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    steps: list[str] = []

    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image)
        steps.append("方向修正")

        image, scan_correction = correct_scan_geometry(image)
        if scan_correction.get("applied"):
            steps.append("扫描透视矫正")

        image = image.convert("L")
        steps.append("灰度化")

        image = ImageOps.autocontrast(image, cutoff=1)
        steps.append("自动对比度")

        image = image.filter(ImageFilter.MedianFilter(size=3))
        steps.append("中值降噪")

        image = ImageEnhance.Contrast(image).enhance(1.35)
        steps.append("对比度增强")

        image = ImageEnhance.Sharpness(image).enhance(1.2)
        steps.append("轻量锐化")

        angle = estimate_skew_angle(image)
        if abs(angle) >= 0.25:
            image = image.rotate(-angle, resample=resampling_bicubic(), expand=False, fillcolor=255)
            steps.append(f"倾斜校正({angle:+.1f}°)")

        image.save(target, format="PNG", optimize=True)

    return target, {
        "enabled": True,
        "imageName": target.name,
        "steps": steps,
        "deskewAngle": angle,
        "scanCorrection": scan_correction,
    }


def preprocessed_image_path(path: Path, page_number: int | None, task_id: str | None) -> Path:
    if task_id:
        name = f"page-{page_number or path.stem}-preprocessed.png"
        return TASKS_DIR / task_id / "preprocessed" / name

    return PREPROCESS_DIR / f"{path.stem}-{uuid.uuid4().hex[:8]}-preprocessed.png"


def correct_scan_geometry(image: Image.Image) -> tuple[Image.Image, dict[str, Any]]:
    cv2, np = get_cv2_modules()
    if cv2 is None or np is None:
        return image, {
            "enabled": False,
            "applied": False,
            "reason": "未安装 OpenCV，跳过扫描透视矫正",
        }

    original_mode = image.mode
    rgb = image.convert("RGB")
    array = np.array(rgb)
    height, width = array.shape[:2]
    if width < 120 or height < 120:
        return image, {
            "enabled": True,
            "applied": False,
            "reason": "图像尺寸过小，跳过扫描透视矫正",
        }

    scale = min(1.0, 1400 / max(width, height))
    sample = cv2.resize(array, (int(width * scale), int(height * scale))) if scale < 1 else array
    gray = cv2.cvtColor(sample, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), dtype=np.uint8), iterations=1)

    contours, _ = find_external_contours(edges, cv2)
    if not contours:
        return image, {
            "enabled": True,
            "applied": False,
            "reason": "未检测到可用于透视矫正的页面边界",
        }

    sample_area = sample.shape[0] * sample.shape[1]
    quad = None
    contour_area = 0.0
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
        area = float(cv2.contourArea(contour))
        if area < sample_area * 0.18:
            continue
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.025 * perimeter, True)
        if len(approx) == 4:
            quad = approx.reshape(4, 2).astype("float32")
            contour_area = area
            break

    if quad is None:
        return image, {
            "enabled": True,
            "applied": False,
            "reason": "未找到稳定的四边形页面边界",
        }

    if scale < 1:
        quad = quad / scale

    ordered = order_quad_points(quad, np)
    if quad_is_near_full_frame(ordered, width, height):
        return image, {
            "enabled": True,
            "applied": False,
            "reason": "页面边界已接近图像边框，无需透视矫正",
        }

    warped = four_point_transform(array, ordered, cv2, np)
    if warped is None:
        return image, {
            "enabled": True,
            "applied": False,
            "reason": "页面边界几何异常，跳过透视矫正",
        }

    corrected = Image.fromarray(warped)
    if original_mode in {"L", "RGB", "RGBA"}:
        corrected = corrected.convert(original_mode)

    return corrected, {
        "enabled": True,
        "applied": True,
        "method": "opencv-four-point-transform",
        "confidence": round(min(0.95, max(0.55, contour_area / max(1, sample_area))), 2),
        "sourceSize": {"width": width, "height": height},
        "outputSize": {"width": corrected.width, "height": corrected.height},
        "quad": [[round(float(x), 2), round(float(y), 2)] for x, y in ordered.tolist()],
    }


def get_cv2_modules():
    try:
        import cv2
        import numpy as np

        return cv2, np
    except Exception:
        return None, None


def find_external_contours(mask: Any, cv2: Any) -> tuple[Any, Any]:
    result = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return result[-2], result[-1]


def order_quad_points(points: Any, np: Any):
    rect = np.zeros((4, 2), dtype="float32")
    sums = points.sum(axis=1)
    diffs = np.diff(points, axis=1)
    rect[0] = points[np.argmin(sums)]
    rect[2] = points[np.argmax(sums)]
    rect[1] = points[np.argmin(diffs)]
    rect[3] = points[np.argmax(diffs)]
    return rect


def quad_is_near_full_frame(points: Any, width: int, height: int) -> bool:
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    margin_x = max(8, width * 0.015)
    margin_y = max(8, height * 0.015)
    return (
        min(xs) <= margin_x
        and min(ys) <= margin_y
        and max(xs) >= width - margin_x
        and max(ys) >= height - margin_y
    )


def four_point_transform(array: Any, points: Any, cv2: Any, np: Any) -> Any:
    top_left, top_right, bottom_right, bottom_left = points
    width_a = np.linalg.norm(bottom_right - bottom_left)
    width_b = np.linalg.norm(top_right - top_left)
    height_a = np.linalg.norm(top_right - bottom_right)
    height_b = np.linalg.norm(top_left - bottom_left)
    max_width = int(max(width_a, width_b))
    max_height = int(max(height_a, height_b))

    if max_width < 80 or max_height < 80:
        return None

    destination = np.array(
        [
            [0, 0],
            [max_width - 1, 0],
            [max_width - 1, max_height - 1],
            [0, max_height - 1],
        ],
        dtype="float32",
    )
    matrix = cv2.getPerspectiveTransform(points, destination)
    return cv2.warpPerspective(array, matrix, (max_width, max_height), borderValue=(255, 255, 255))


def estimate_skew_angle(image: Image.Image) -> float:
    sample = image.copy()
    max_width = 700
    if sample.width > max_width:
        ratio = max_width / sample.width
        sample = sample.resize(
            (max_width, max(1, int(sample.height * ratio))),
            resampling_bicubic(),
        )

    thresholded = sample.point(lambda pixel: 0 if pixel < 185 else 255)
    best_angle = 0.0
    best_score = -math.inf

    for index in range(-6, 7):
        angle = index * 0.5
        rotated = thresholded.rotate(angle, resample=resampling_bicubic(), expand=False, fillcolor=255)
        score = horizontal_projection_score(rotated)
        if score > best_score:
            best_score = score
            best_angle = angle

    return best_angle


def horizontal_projection_score(image: Image.Image) -> float:
    pixels = image.load()
    width, height = image.size
    counts: list[int] = []

    for y in range(height):
        black = 0
        for x in range(width):
            if pixels[x, y] < 128:
                black += 1
        counts.append(black)

    if not counts:
        return 0.0

    average = sum(counts) / len(counts)
    return sum((count - average) ** 2 for count in counts) / len(counts)


def resampling_bicubic():
    return getattr(Image, "Resampling", Image).BICUBIC


def recognize_image(
    path: Path,
    page_number: int | None = None,
    task_id: str | None = None,
    on_progress: Any = None,
) -> dict[str, Any]:
    report_progress(on_progress, "预处理中", 20)
    ensure_image_readable(path)
    processed_path, preprocessing = preprocess_image(path, page_number, task_id)
    report_progress(on_progress, "识别中", 55)
    engine = get_ocr_engine()
    # paddleocr 3.x：predict() 取代 ocr()，不再接受 cls 参数
    raw = engine.predict(str(processed_path))
    report_progress(on_progress, "版面分析", 85)
    ocr_lines = parse_paddle_result(raw)
    layout = analyze_page_layout(processed_path, ocr_lines)
    ordered_lines = layout["readingOrder"]
    text_lines = [line["text"] for line in ordered_lines]
    scores = [line["confidence"] for line in ocr_lines if isinstance(line.get("confidence"), (int, float))]

    payload: dict[str, Any] = {
        "text": "\n".join(text_lines),
        "confidence": sum(scores) / len(scores) if scores else None,
        "engine": "PaddleOCR",
        "warnings": build_warnings(scores, layout),
        "imageName": path.name,
        "preprocessing": preprocessing,
        "layout": layout,
    }

    if task_id:
        payload["imageUrl"] = build_file_url(path)
        payload["preprocessedImageUrl"] = build_file_url(processed_path)
    else:
        payload["imageDataUrl"] = image_to_data_url(path)
        payload["preprocessedImageDataUrl"] = image_to_data_url(processed_path)

    if page_number is not None:
        payload["pageNumber"] = page_number

    report_progress(on_progress, "已完成", 100)
    return payload


def ensure_image_readable(path: Path) -> None:
    with Image.open(path) as image:
        image.verify()


def parse_paddle_result(raw: Any) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []

    for page_result in raw or []:
        parsed = _parse_paddle_page(page_result)
        if parsed:
            lines.extend(parsed)

    return lines


def _parse_paddle_page(page_result: Any) -> list[dict[str, Any]]:
    """解析一页的识别结果，兼容 paddleocr 2.x 与 3.x 两种返回格式。"""
    # paddleocr 2.x 旧格式：[[points, (text, score)], ...]
    if (
        isinstance(page_result, (list, tuple))
        and page_result
        and _is_legacy_line(page_result[0])
    ):
        lines: list[dict[str, Any]] = []
        for line in page_result or []:
            parsed = parse_paddle_line(line)
            if parsed:
                lines.append(parsed)
        return lines

    # paddleocr 3.x：OCRResult.json = {"res": {"rec_texts": [...], ...}}
    data = _extract_ocr3_data(page_result)
    if not data:
        return []

    texts = data.get("rec_texts") or []
    scores = data.get("rec_scores") or []
    polys = data.get("rec_polys") or []
    lines: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        text = str(text).strip()
        if not text:
            continue
        points = normalize_points(polys[index] if index < len(polys) else [])
        confidence = _safe_float(scores[index]) if index < len(scores) else None
        lines.append(
            {
                "text": text,
                "confidence": confidence,
                "points": points,
                "bbox": bbox_from_points(points),
            }
        )
    return lines


def _is_legacy_line(value: Any) -> bool:
    """判断是否为 paddleocr 2.x 的行格式：[points, (text, score)]。"""
    return (
        isinstance(value, (list, tuple))
        and len(value) >= 2
        and isinstance(value[0], (list, tuple))
    )


def _extract_ocr3_data(result: Any) -> dict[str, Any] | None:
    """从 paddleocr 3.x 的 OCRResult 中提取 res 数据字典。"""
    js = getattr(result, "json", None)
    if callable(js):
        js = js()
    elif isinstance(result, dict):
        js = result
    if not isinstance(js, dict):
        return None
    res = js.get("res")
    if isinstance(res, dict) and _has_ocr3_fields(res):
        return res
    if _has_ocr3_fields(js):
        return js
    return None


def _has_ocr3_fields(data: dict[str, Any]) -> bool:
    return any(key in data for key in ("rec_texts", "rec_scores", "rec_polys"))


def _safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_paddle_line(line: Any) -> dict[str, Any] | None:
    if not line or not isinstance(line, (list, tuple)) or len(line) < 2:
        return None

    points = normalize_points(line[0])
    text_score = line[1]
    if not isinstance(text_score, (list, tuple)) or len(text_score) < 2:
        return None

    text = str(text_score[0]).strip()
    if not text:
        return None

    try:
        confidence = float(text_score[1])
    except (TypeError, ValueError):
        confidence = None

    bbox = bbox_from_points(points)
    return {
        "text": text,
        "confidence": confidence,
        "points": points,
        "bbox": bbox,
    }


def normalize_points(value: Any) -> list[list[float]]:
    points: list[list[float]] = []
    # 兼容 numpy 数组（paddleocr 3.x 内部可能返回 ndarray）
    try:
        import numpy as np

        if isinstance(value, np.ndarray):
            value = value.tolist()
    except Exception:
        pass
    if isinstance(value, (list, tuple)):
        for point in value:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            try:
                points.append([float(point[0]), float(point[1])])
            except (TypeError, ValueError):
                continue

    if len(points) >= 4:
        return points[:4]
    return []


def bbox_from_points(points: list[list[float]]) -> dict[str, float]:
    if not points:
        return {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}

    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    left = min(xs)
    top = min(ys)
    right = max(xs)
    bottom = max(ys)
    return {
        "x": left,
        "y": top,
        "width": max(0.0, right - left),
        "height": max(0.0, bottom - top),
    }


def analyze_page_layout(path: Path, lines: list[dict[str, Any]]) -> dict[str, Any]:
    with Image.open(path) as image:
        width, height = image.size

    enriched = [enrich_line(line, width, height) for line in lines if line.get("text")]
    body_candidates = [
        line for line in enriched
        if 0.08 <= line["bboxNorm"]["y"] <= 0.92
    ] or enriched
    writing_mode, writing_confidence, writing_reasons = detect_writing_mode(body_candidates, width, height)
    columns = (
        detect_vertical_columns(body_candidates, width)
        if writing_mode == "vertical-rl"
        else detect_columns(body_candidates, width)
    )
    regions = classify_regions(enriched, columns, width, height, writing_mode)
    ordered_lines = order_lines_for_reading(enriched, columns, writing_mode, width, height)
    non_text_regions = detect_non_text_regions(path, enriched, width, height)

    return {
        "imageWidth": width,
        "imageHeight": height,
        "writingMode": writing_mode,
        "writingModeConfidence": writing_confidence,
        "writingModeReasons": writing_reasons,
        "readingDirection": "right-to-left-top-to-bottom" if writing_mode == "vertical-rl" else "left-to-right-top-to-bottom",
        "outputFormat": "modern-horizontal",
        "lineCount": len(enriched),
        "columnCount": len(columns),
        "columns": columns,
        "regions": regions,
        "nonTextRegions": non_text_regions,
        "lines": enriched,
        "readingOrder": ordered_lines,
        "capabilities": [
            "line-boxes",
            "reading-order",
            "column-detection",
            "writing-mode-detection",
            "vertical-rl-modernization",
            "non-text-region-detection",
            "non-text-region-cropping",
            "header-footer-candidates",
            "footnote-caption-candidates",
        ],
    }


def enrich_line(line: dict[str, Any], image_width: int, image_height: int) -> dict[str, Any]:
    bbox = line.get("bbox") or {}
    normalized = normalize_bbox(bbox, image_width, image_height)
    return {
        "text": line.get("text", ""),
        "confidence": line.get("confidence"),
        "points": line.get("points") or [],
        "bbox": bbox,
        "bboxNorm": normalized,
        "centerX": bbox.get("x", 0.0) + bbox.get("width", 0.0) / 2,
        "centerY": bbox.get("y", 0.0) + bbox.get("height", 0.0) / 2,
        "role": "body",
        "columnIndex": 0,
    }


def normalize_bbox(bbox: dict[str, float], image_width: int, image_height: int) -> dict[str, float]:
    width = max(1, image_width)
    height = max(1, image_height)
    return {
        "x": round(float(bbox.get("x", 0.0)) / width, 4),
        "y": round(float(bbox.get("y", 0.0)) / height, 4),
        "width": round(float(bbox.get("width", 0.0)) / width, 4),
        "height": round(float(bbox.get("height", 0.0)) / height, 4),
    }


def detect_writing_mode(
    lines: list[dict[str, Any]],
    image_width: int,
    image_height: int,
) -> tuple[str, float, list[str]]:
    if len(lines) < 3:
        return "horizontal-lr", 0.55, ["文字行较少，默认按现代横排处理"]

    measurable = [
        line for line in lines
        if line["bbox"].get("width", 0.0) > 0 and line["bbox"].get("height", 0.0) > 0
    ]
    if len(measurable) < 3:
        return "horizontal-lr", 0.55, ["缺少足够坐标信息，默认按现代横排处理"]

    total_chars = sum(max(1, len(line["text"].strip())) for line in measurable)
    vertical_chars = sum(
        max(1, len(line["text"].strip()))
        for line in measurable
        if line["bbox"].get("height", 0.0) >= line["bbox"].get("width", 0.0) * 1.35
    )
    horizontal_chars = sum(
        max(1, len(line["text"].strip()))
        for line in measurable
        if line["bbox"].get("width", 0.0) >= line["bbox"].get("height", 0.0) * 1.6
    )

    median_width = median([line["bbox"].get("width", 0.0) for line in measurable]) or 1
    median_height = median([line["bbox"].get("height", 0.0) for line in measurable]) or 1
    x_clusters = cluster_axis(measurable, "centerX", max(median_width * 0.9, image_width * 0.01, 6))
    y_clusters = cluster_axis(measurable, "centerY", max(median_height * 0.9, image_height * 0.006, 6))
    median_x_density = median([len(cluster) for cluster in x_clusters]) or 0
    median_y_density = median([len(cluster) for cluster in y_clusters]) or 0
    short_line_ratio = sum(1 for line in measurable if len(line["text"].strip()) <= 2) / len(measurable)

    reasons: list[str] = []
    vertical_score = 0.0
    horizontal_score = 0.0

    if vertical_chars / max(1, total_chars) >= 0.35 and vertical_chars >= horizontal_chars:
        vertical_score += 0.45
        reasons.append("多数文字框呈竖向延展")

    if short_line_ratio >= 0.55 and median_x_density > median_y_density * 1.25 and len(x_clusters) >= 2:
        vertical_score += 0.35
        reasons.append("短文本框更集中成纵向列")

    if image_height > image_width * 1.12 and (vertical_chars > horizontal_chars or median_x_density > median_y_density):
        vertical_score += 0.15
        reasons.append("页面比例和文本分布接近古籍竖排")

    if len(x_clusters) >= 3 and median_x_density >= 3 and median_x_density > median_y_density:
        vertical_score += 0.15
        reasons.append("检测到多个竖向文字列")

    if horizontal_chars > vertical_chars:
        horizontal_score += 0.45
    if median_y_density >= median_x_density:
        horizontal_score += 0.25
    if short_line_ratio < 0.55:
        horizontal_score += 0.15

    if vertical_score >= 0.55 and vertical_score > horizontal_score:
        return "vertical-rl", round(min(0.95, vertical_score), 2), reasons or ["检测到竖排版式"]

    confidence = round(min(0.95, max(0.55, horizontal_score)), 2)
    if not reasons:
        reasons.append("文本框分布接近现代横排")
    return "horizontal-lr", confidence, reasons


def cluster_axis(
    lines: list[dict[str, Any]],
    key: str,
    tolerance: float,
) -> list[list[dict[str, Any]]]:
    if not lines:
        return []

    clusters: list[list[dict[str, Any]]] = []
    centers: list[float] = []
    for line in sorted(lines, key=lambda item: item.get(key, 0.0)):
        value = float(line.get(key, 0.0))
        if not clusters or abs(value - centers[-1]) > tolerance:
            clusters.append([line])
            centers.append(value)
            continue

        clusters[-1].append(line)
        centers[-1] = sum(float(item.get(key, 0.0)) for item in clusters[-1]) / len(clusters[-1])

    return clusters


def detect_columns(lines: list[dict[str, Any]], image_width: int) -> list[dict[str, Any]]:
    if not lines:
        return [{"index": 0, "xMin": 0.0, "xMax": float(image_width), "lineCount": 0}]

    sorted_lines = sorted(lines, key=lambda item: item["centerX"])
    median_width = median([line["bbox"].get("width", 0.0) for line in sorted_lines]) or image_width
    min_gap = max(image_width * 0.08, median_width * 1.4)
    gaps: list[tuple[float, int]] = []

    for index in range(len(sorted_lines) - 1):
        left = sorted_lines[index]["bbox"].get("x", 0.0) + sorted_lines[index]["bbox"].get("width", 0.0)
        right = sorted_lines[index + 1]["bbox"].get("x", 0.0)
        gap = right - left
        if gap >= min_gap:
            gaps.append((gap, index))

    if not gaps:
        return [build_column(0, lines, image_width)]

    _, split_index = max(gaps, key=lambda item: item[0])
    left_group = sorted_lines[: split_index + 1]
    right_group = sorted_lines[split_index + 1 :]

    if len(left_group) < 3 or len(right_group) < 3:
        return [build_column(0, lines, image_width)]

    return [
        build_column(0, left_group, image_width),
        build_column(1, right_group, image_width),
    ]


def detect_vertical_columns(lines: list[dict[str, Any]], image_width: int) -> list[dict[str, Any]]:
    if not lines:
        return [{"index": 0, "xMin": 0.0, "xMax": float(image_width), "lineCount": 0}]

    median_width = median([line["bbox"].get("width", 0.0) for line in lines]) or 1
    clusters = cluster_axis(lines, "centerX", max(median_width * 0.9, image_width * 0.01, 6))
    ordered_clusters = sorted(
        clusters,
        key=lambda group: sum(line["centerX"] for line in group) / len(group),
        reverse=True,
    )

    return [
        build_column(index, group, image_width)
        for index, group in enumerate(ordered_clusters)
    ]


def build_column(index: int, lines: list[dict[str, Any]], image_width: int) -> dict[str, Any]:
    if not lines:
        return {"index": index, "xMin": 0.0, "xMax": float(image_width), "lineCount": 0}

    x_min = min(line["bbox"].get("x", 0.0) for line in lines)
    x_max = max(line["bbox"].get("x", 0.0) + line["bbox"].get("width", 0.0) for line in lines)
    return {
        "index": index,
        "xMin": round(x_min, 2),
        "xMax": round(x_max, 2),
        "xMinNorm": round(x_min / max(1, image_width), 4),
        "xMaxNorm": round(x_max / max(1, image_width), 4),
        "lineCount": len(lines),
        "centerX": round((x_min + x_max) / 2, 2),
    }


def classify_regions(
    lines: list[dict[str, Any]],
    columns: list[dict[str, Any]],
    image_width: int,
    image_height: int,
    writing_mode: str = "horizontal-lr",
) -> list[dict[str, Any]]:
    roles: dict[str, list[dict[str, Any]]] = {
        "header": [],
        "footer": [],
        "footnote": [],
        "caption": [],
        "body": [],
    }
    median_height = median([line["bbox"].get("height", 0.0) for line in lines]) or 1

    for line in lines:
        assign_column(line, columns)
        text = line["text"]
        y = line["bboxNorm"]["y"]
        line_height = line["bbox"].get("height", 0.0)

        if writing_mode == "vertical-rl":
            if looks_like_vertical_header_or_page_number(line, text):
                role = "header" if y < 0.5 else "footer"
            else:
                role = "caption" if looks_like_caption(text) else "body"
        elif y < 0.07:
            role = "header"
        elif y > 0.94:
            role = "footer"
        elif y > 0.82 and (line_height < median_height * 0.86 or looks_like_note(text)):
            role = "footnote"
        elif looks_like_caption(text):
            role = "caption"
        else:
            role = "body"

        line["role"] = role
        roles[role].append(line)

    return [
        build_region(role, role_lines, image_width, image_height)
        for role, role_lines in roles.items()
        if role_lines
    ]


def assign_column(line: dict[str, Any], columns: list[dict[str, Any]]) -> None:
    if not columns:
        line["columnIndex"] = 0
        return

    center = line["centerX"]
    closest = min(
        columns,
        key=lambda column: abs(center - (column["xMin"] + column["xMax"]) / 2),
    )
    line["columnIndex"] = closest["index"]


def looks_like_note(text: str) -> bool:
    stripped = text.strip()
    return stripped.startswith(("注", "附注", "备注", "*", "①", "②", "③", "④", "⑤")) or stripped[:2].isdigit()


def looks_like_vertical_header_or_page_number(line: dict[str, Any], text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False

    bbox = line.get("bbox", {})
    norm = line.get("bboxNorm", {})
    width = float(bbox.get("width", 0.0))
    height = float(bbox.get("height", 0.0))
    x = float(norm.get("x", 0.0))
    y = float(norm.get("y", 0.0))
    text_len = len(stripped)

    in_top_bottom_margin = y < 0.06 or y > 0.94
    in_outer_margin = x < 0.04 or x > 0.96
    is_horizontal_banner = width >= height * 1.6 and text_len >= 2
    is_page_number = text_len <= 4 and stripped.strip("-—–·. 　").isdigit()
    is_chinese_page_number = text_len <= 6 and all(char in "第页頁一二三四五六七八九十百〇零0123456789-—–·. " for char in stripped)

    return (
        in_top_bottom_margin and (is_page_number or is_chinese_page_number or is_horizontal_banner)
    ) or (
        in_outer_margin and (is_page_number or is_chinese_page_number)
    )


def looks_like_caption(text: str) -> bool:
    stripped = text.strip()
    return stripped.startswith(("图", "表", "照片", "地图", "附图")) and len(stripped) <= 40


def build_region(role: str, lines: list[dict[str, Any]], image_width: int, image_height: int) -> dict[str, Any]:
    x_min = min(line["bbox"].get("x", 0.0) for line in lines)
    y_min = min(line["bbox"].get("y", 0.0) for line in lines)
    x_max = max(line["bbox"].get("x", 0.0) + line["bbox"].get("width", 0.0) for line in lines)
    y_max = max(line["bbox"].get("y", 0.0) + line["bbox"].get("height", 0.0) for line in lines)
    bbox = {"x": x_min, "y": y_min, "width": x_max - x_min, "height": y_max - y_min}
    return {
        "role": role,
        "lineCount": len(lines),
        "bbox": {key: round(value, 2) for key, value in bbox.items()},
        "bboxNorm": normalize_bbox(bbox, image_width, image_height),
    }


def detect_non_text_regions(
    path: Path,
    text_lines: list[dict[str, Any]],
    image_width: int,
    image_height: int,
) -> list[dict[str, Any]]:
    cv2, np = get_cv2_modules()
    if cv2 is None or np is None:
        return []

    gray = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        return []

    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        35,
        15,
    )
    edges = cv2.Canny(gray, 45, 140)
    content = cv2.bitwise_or(binary, edges)

    text_mask = build_text_mask(text_lines, image_width, image_height, cv2, np)
    content[text_mask > 0] = 0

    merge_size = max(9, int(min(image_width, image_height) * 0.014))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (merge_size, merge_size))
    content = cv2.morphologyEx(content, cv2.MORPH_CLOSE, kernel, iterations=2)
    content = cv2.dilate(content, kernel, iterations=1)

    contours, _ = find_external_contours(content, cv2)
    page_area = image_width * image_height
    regions: list[dict[str, Any]] = []

    for contour in sorted(contours, key=cv2.contourArea, reverse=True):
        x, y, width, height = cv2.boundingRect(contour)
        bbox = {"x": float(x), "y": float(y), "width": float(width), "height": float(height)}
        area = width * height
        if not is_non_text_region_candidate(bbox, page_area, image_width, image_height):
            continue

        text_overlap = estimate_text_overlap_ratio(text_lines, bbox)
        if text_overlap > 0.28:
            continue

        region_type, confidence = classify_non_text_region(gray, bbox, cv2, np)
        crop_path, crop_correction = save_non_text_region_crop(path, bbox, len(regions) + 1)
        region = {
            "index": len(regions),
            "type": region_type,
            "confidence": confidence,
            "bbox": {key: round(value, 2) for key, value in bbox.items()},
            "bboxNorm": normalize_bbox(bbox, image_width, image_height),
            "textOverlap": round(text_overlap, 3),
            "cropCorrection": crop_correction,
        }
        if crop_path:
            region["croppedImageUrl"] = build_file_url(crop_path)
            region["croppedImageName"] = crop_path.name
        regions.append(region)

        if len(regions) >= 12:
            break

    return dedupe_non_text_regions(regions)


def build_text_mask(
    lines: list[dict[str, Any]],
    image_width: int,
    image_height: int,
    cv2: Any,
    np: Any,
) -> Any:
    mask = np.zeros((image_height, image_width), dtype=np.uint8)
    median_height = median([line["bbox"].get("height", 0.0) for line in lines]) or 8
    padding = max(4, int(median_height * 0.35))

    for line in lines:
        bbox = line.get("bbox") or {}
        x = max(0, int(bbox.get("x", 0.0) - padding))
        y = max(0, int(bbox.get("y", 0.0) - padding))
        right = min(image_width, int(bbox.get("x", 0.0) + bbox.get("width", 0.0) + padding))
        bottom = min(image_height, int(bbox.get("y", 0.0) + bbox.get("height", 0.0) + padding))
        if right > x and bottom > y:
            cv2.rectangle(mask, (x, y), (right, bottom), 255, thickness=-1)

    return mask


def is_non_text_region_candidate(
    bbox: dict[str, float],
    page_area: int,
    image_width: int,
    image_height: int,
) -> bool:
    width = bbox["width"]
    height = bbox["height"]
    area = width * height
    if area < page_area * 0.012:
        return False
    if width < image_width * 0.08 or height < image_height * 0.04:
        return False
    if area > page_area * 0.82 and bbox["x"] < image_width * 0.06 and bbox["y"] < image_height * 0.06:
        return False
    if width / max(1, height) > 18 or height / max(1, width) > 18:
        return False
    return True


def estimate_text_overlap_ratio(lines: list[dict[str, Any]], bbox: dict[str, float]) -> float:
    area = max(1.0, bbox["width"] * bbox["height"])
    overlap = 0.0
    for line in lines:
        line_bbox = line.get("bbox") or {}
        overlap += intersection_area(bbox, line_bbox)
    return overlap / area


def intersection_area(first: dict[str, float], second: dict[str, float]) -> float:
    left = max(float(first.get("x", 0.0)), float(second.get("x", 0.0)))
    top = max(float(first.get("y", 0.0)), float(second.get("y", 0.0)))
    right = min(
        float(first.get("x", 0.0)) + float(first.get("width", 0.0)),
        float(second.get("x", 0.0)) + float(second.get("width", 0.0)),
    )
    bottom = min(
        float(first.get("y", 0.0)) + float(first.get("height", 0.0)),
        float(second.get("y", 0.0)) + float(second.get("height", 0.0)),
    )
    return max(0.0, right - left) * max(0.0, bottom - top)


def classify_non_text_region(gray: Any, bbox: dict[str, float], cv2: Any, np: Any) -> tuple[str, float]:
    x = int(bbox["x"])
    y = int(bbox["y"])
    width = int(bbox["width"])
    height = int(bbox["height"])
    crop = gray[y : y + height, x : x + width]
    if crop.size == 0:
        return "unknown", 0.5

    edges = cv2.Canny(crop, 45, 140)
    edge_density = float(np.count_nonzero(edges)) / max(1, crop.size)
    tonal_std = float(np.std(crop))
    lines = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 180,
        threshold=max(24, min(width, height) // 5),
        minLineLength=max(20, min(width, height) // 4),
        maxLineGap=8,
    )
    horizontal = 0
    vertical = 0
    if lines is not None:
        for entry in lines[:80]:
            x1, y1, x2, y2 = entry[0]
            if abs(y1 - y2) <= 3:
                horizontal += 1
            elif abs(x1 - x2) <= 3:
                vertical += 1

    if horizontal >= 4 and vertical >= 4:
        return "table", 0.74
    if edge_density > 0.035 and tonal_std > 28:
        return "image", 0.68
    if edge_density > 0.025:
        return "figure", 0.6
    return "unknown", 0.52


def save_non_text_region_crop(
    source_path: Path,
    bbox: dict[str, float],
    index: int,
) -> tuple[Path | None, dict[str, Any]]:
    try:
        crop_dir = source_path.parent / "non-text-regions"
        crop_dir.mkdir(parents=True, exist_ok=True)
        with Image.open(source_path) as image:
            margin = max(6, int(min(image.width, image.height) * 0.006))
            left = max(0, int(bbox["x"]) - margin)
            top = max(0, int(bbox["y"]) - margin)
            right = min(image.width, int(bbox["x"] + bbox["width"]) + margin)
            bottom = min(image.height, int(bbox["y"] + bbox["height"]) + margin)
            crop = image.crop((left, top, right, bottom))
            corrected, correction = correct_scan_geometry(crop)
            crop_path = crop_dir / f"{source_path.stem}-region-{index}.png"
            corrected.save(crop_path, format="PNG", optimize=True)
            return crop_path, correction
    except Exception as exc:  # noqa: BLE001
        return None, {
            "enabled": False,
            "applied": False,
            "reason": f"区域裁剪失败：{exc}",
        }


def dedupe_non_text_regions(regions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    for region in regions:
        bbox = region.get("bbox") or {}
        duplicate = False
        for existing in deduped:
            existing_bbox = existing.get("bbox") or {}
            overlap = intersection_area(bbox, existing_bbox)
            smaller = min(
                float(bbox.get("width", 0.0)) * float(bbox.get("height", 0.0)),
                float(existing_bbox.get("width", 0.0)) * float(existing_bbox.get("height", 0.0)),
            )
            if smaller > 0 and overlap / smaller > 0.72:
                duplicate = True
                break
        if duplicate:
            continue
        region["index"] = len(deduped)
        deduped.append(region)
    return deduped


def order_lines_for_reading(
    lines: list[dict[str, Any]],
    columns: list[dict[str, Any]],
    writing_mode: str = "horizontal-lr",
    image_width: int = 1,
    image_height: int = 1,
) -> list[dict[str, Any]]:
    if writing_mode == "vertical-rl":
        return order_vertical_lines_for_modern_reading(lines, columns, image_width, image_height)

    body_roles = {"body", "caption", "footnote"}
    ordered = sorted(
        lines,
        key=lambda line: (
            0 if line["role"] == "header" else 2 if line["role"] == "footer" else 1,
            line["columnIndex"] if len(columns) > 1 else 0,
            line["bbox"].get("y", 0.0),
            line["bbox"].get("x", 0.0),
        ),
    )
    return [
        line for line in ordered
        if line["role"] in body_roles or len(lines) < 3
    ]


def order_vertical_lines_for_modern_reading(
    lines: list[dict[str, Any]],
    columns: list[dict[str, Any]],
    image_width: int,
    image_height: int,
) -> list[dict[str, Any]]:
    body_roles = {"body", "caption", "footnote"}
    candidates = [
        line for line in lines
        if line["role"] in body_roles or len(lines) < 3
    ]
    if not candidates:
        return []

    grouped: dict[int, list[dict[str, Any]]] = {}
    for line in candidates:
        grouped.setdefault(int(line.get("columnIndex", 0)), []).append(line)

    column_order = [column["index"] for column in sorted(columns, key=lambda column: column.get("index", 0))]
    for column_index in grouped:
        if column_index not in column_order:
            column_order.append(column_index)

    ordered: list[dict[str, Any]] = []
    for column_index in column_order:
        column_lines = grouped.get(column_index, [])
        if not column_lines:
            continue
        column_lines = sorted(
            column_lines,
            key=lambda line: (
                0 if line["role"] != "footnote" else 1,
                line["bbox"].get("y", 0.0),
                -line["bbox"].get("x", 0.0),
            ),
        )
        ordered.append(build_modern_vertical_line(column_lines, column_index, image_width, image_height))

    return ordered


def build_modern_vertical_line(
    lines: list[dict[str, Any]],
    column_index: int,
    image_width: int,
    image_height: int,
) -> dict[str, Any]:
    if len(lines) == 1:
        line = dict(lines[0])
        line["columnIndex"] = column_index
        line["sourceLineCount"] = 1
        return line

    x_min = min(line["bbox"].get("x", 0.0) for line in lines)
    y_min = min(line["bbox"].get("y", 0.0) for line in lines)
    x_max = max(line["bbox"].get("x", 0.0) + line["bbox"].get("width", 0.0) for line in lines)
    y_max = max(line["bbox"].get("y", 0.0) + line["bbox"].get("height", 0.0) for line in lines)
    bbox = {"x": x_min, "y": y_min, "width": x_max - x_min, "height": y_max - y_min}
    confidences = [
        line["confidence"] for line in lines
        if isinstance(line.get("confidence"), (int, float))
    ]
    role = "footnote" if all(line.get("role") == "footnote" for line in lines) else "body"

    return {
        "text": "".join(line["text"].strip() for line in lines if line.get("text")),
        "confidence": sum(confidences) / len(confidences) if confidences else None,
        "points": [],
        "bbox": bbox,
        "bboxNorm": normalize_bbox(bbox, image_width, image_height),
        "centerX": x_min + (x_max - x_min) / 2,
        "centerY": y_min + (y_max - y_min) / 2,
        "role": role,
        "columnIndex": column_index,
        "sourceLineCount": len(lines),
    }


def median(values: list[float]) -> float:
    cleaned = sorted(value for value in values if isinstance(value, (int, float)))
    if not cleaned:
        return 0.0
    middle = len(cleaned) // 2
    if len(cleaned) % 2:
        return float(cleaned[middle])
    return float((cleaned[middle - 1] + cleaned[middle]) / 2)


def build_warnings(scores: list[float], layout: dict[str, Any] | None = None) -> list[str]:
    warnings = []

    if not scores:
        warnings.append("未返回置信度，建议检查原图。")
    elif min(scores) < 0.75:
        warnings.append("存在低置信度文字，建议对照原图检查。")

    if layout:
        if layout.get("writingMode") == "vertical-rl":
            warnings.append("检测到古籍竖排版式，已按右起逐列、列内自上而下重排为现代横排文本。")
        elif layout.get("columnCount", 1) > 1:
            warnings.append("检测到多栏版面，已按栏位重排阅读顺序，建议检查版面顺序。")
        if layout.get("nonTextRegions"):
            warnings.append("检测到图片、地图、照片或表格等非文字区域，已保存区域坐标和裁剪图，不进入正文。")
        if layout.get("writingModeConfidence", 1) < 0.6:
            warnings.append("版式方向判断置信度较低，建议对照原图检查阅读顺序。")
        roles = {region["role"] for region in layout.get("regions", [])}
        if {"header", "footer"} & roles:
            warnings.append("检测到页眉或页脚候选区域，正文抽取时已降低其优先级。")
        if {"footnote", "caption"} & roles:
            warnings.append("检测到脚注或图题候选区域，建议检查原图归属。")

    return warnings


def image_to_data_url(path: Path) -> str:
    mime = "image/png"
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        mime = "image/jpeg"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def image_to_cover_data_url(path: Path) -> str:
    with Image.open(path) as image:
        image.thumbnail((900, 1200))
        output = BytesIO()
        image.convert("RGB").save(output, format="JPEG", quality=86, optimize=True)
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def build_file_url(path: Path) -> str:
    relative = path.resolve().relative_to(STORAGE_DIR.resolve()).as_posix()
    return f"{PUBLIC_BASE_URL}/files/{relative}"


def task_path(task_id: str) -> Path:
    return TASKS_DIR / task_id / "task.json"


def save_task(task: dict[str, Any]) -> None:
    TASKS[task["taskId"]] = task
    path = task_path(task["taskId"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")


def load_task(task_id: str) -> dict[str, Any] | None:
    if task_id in TASKS:
        return TASKS[task_id]

    path = task_path(task_id)
    if not path.exists():
        return None

    task = json.loads(path.read_text(encoding="utf-8"))
    TASKS[task_id] = task
    return task


def public_task(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "taskId": task["taskId"],
        "status": task["status"],
        "message": task["message"],
        "totalPages": task.get("totalPages", 0),
        "completedPages": task.get("completedPages", 0),
        "currentPage": task.get("currentPage", 0),
        "currentPageStage": task.get("currentPageStage", ""),
        "currentPageProgress": task.get("currentPageProgress", 0),
        "pages": task["pages"],
    }


def report_progress(callback: Any, stage: str, progress: int) -> None:
    if callback:
        callback(stage, progress)


def make_page_progress_callback(task_id: str, page_number: int, total_pages: int):
    def on_progress(stage: str, progress: int) -> None:
        set_batch_progress(
            task_id,
            completed_pages=page_number - 1,
            total_pages=total_pages,
            current_page=page_number,
            stage=stage,
            progress=progress,
        )

    return on_progress


def set_batch_progress(
    task_id: str,
    completed_pages: int,
    total_pages: int,
    current_page: int,
    stage: str,
    progress: int,
) -> None:
    task = load_task(task_id)
    if not task:
        return

    task["status"] = "处理中"
    task["totalPages"] = total_pages
    task["completedPages"] = completed_pages
    task["currentPage"] = current_page
    task["currentPageStage"] = stage
    task["currentPageProgress"] = progress
    task["message"] = f"正在识别第 {current_page}/{total_pages} 页（{stage}）"
    save_task(task)


def set_batch_pages(task_id: str, pages: list[dict[str, Any]]) -> None:
    task = load_task(task_id)
    if not task:
        return

    task["pages"] = list(pages)
    save_task(task)
