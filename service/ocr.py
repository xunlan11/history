from __future__ import annotations

import base64
import json
import math
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
PUBLIC_BASE_URL = "http://127.0.0.1:8765"

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

        OCR_ENGINE = PaddleOCR(use_angle_cls=True, lang="ch")
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
    save_task(task)

    try:
        pages = process_document(Path(task["sourcePath"]), task_id)
        task["pages"] = pages
        task["totalPages"] = len(pages)
        task["status"] = "已完成"
        task["message"] = "整本处理完成，请回到平台刷新结果。"
    except Exception as exc:  # noqa: BLE001
        task["status"] = "处理失败"
        task["message"] = f"处理失败：{exc}"

    save_task(task)


def process_document(path: Path, task_id: str) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".pdf":
        return process_pdf(path, task_id)

    page_path = copy_image_to_page(path, task_id, 1)
    return [recognize_image(page_path, page_number=1, task_id=task_id)]


def process_pdf(path: Path, task_id: str) -> list[dict[str, Any]]:
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("未安装 PDF 拆页组件 PyMuPDF") from exc

    pages: list[dict[str, Any]] = []
    doc = fitz.open(path)
    output_dir = TASKS_DIR / task_id / "pages"
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        for index, page in enumerate(doc, start=1):
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            image_path = output_dir / f"page-{index}.png"
            pix.save(image_path)
            pages.append(recognize_image(image_path, page_number=index, task_id=task_id))
    finally:
        doc.close()

    return pages


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
    }


def preprocessed_image_path(path: Path, page_number: int | None, task_id: str | None) -> Path:
    if task_id:
        name = f"page-{page_number or path.stem}-preprocessed.png"
        return TASKS_DIR / task_id / "preprocessed" / name

    return PREPROCESS_DIR / f"{path.stem}-{uuid.uuid4().hex[:8]}-preprocessed.png"


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
) -> dict[str, Any]:
    ensure_image_readable(path)
    processed_path, preprocessing = preprocess_image(path, page_number, task_id)
    engine = get_ocr_engine()
    raw = engine.ocr(str(processed_path), cls=True)
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
    return payload


def ensure_image_readable(path: Path) -> None:
    with Image.open(path) as image:
        image.verify()


def parse_paddle_result(raw: Any) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []

    for page_result in raw or []:
        for line in page_result or []:
            parsed = parse_paddle_line(line)
            if parsed:
                lines.append(parsed)

    return lines


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
    columns = detect_columns(body_candidates, width)
    regions = classify_regions(enriched, columns, width, height)
    ordered_lines = order_lines_for_reading(enriched, columns)

    return {
        "imageWidth": width,
        "imageHeight": height,
        "lineCount": len(enriched),
        "columnCount": len(columns),
        "columns": columns,
        "regions": regions,
        "lines": enriched,
        "readingOrder": ordered_lines,
        "capabilities": [
            "line-boxes",
            "reading-order",
            "column-detection",
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
    }


def classify_regions(
    lines: list[dict[str, Any]],
    columns: list[dict[str, Any]],
    image_width: int,
    image_height: int,
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

        if y < 0.07:
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


def order_lines_for_reading(lines: list[dict[str, Any]], columns: list[dict[str, Any]]) -> list[dict[str, Any]]:
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
        warnings.append("未返回置信度，请人工核对。")
    elif min(scores) < 0.75:
        warnings.append("存在低置信度文字，请重点核对。")

    if layout:
        if layout.get("columnCount", 1) > 1:
            warnings.append("检测到多栏版面，已按栏位重排阅读顺序，请人工核对。")
        roles = {region["role"] for region in layout.get("regions", [])}
        if {"header", "footer"} & roles:
            warnings.append("检测到页眉或页脚候选区域，正文抽取时已降低其优先级。")
        if {"footnote", "caption"} & roles:
            warnings.append("检测到脚注或图题候选区域，请按原图核对归属。")

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
        "totalPages": task["totalPages"],
        "pages": task["pages"],
    }
