from __future__ import annotations

import base64
import json
import uuid
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

APP_DIR = Path(__file__).resolve().parent
STORAGE_DIR = APP_DIR / "storage"
TASKS_DIR = STORAGE_DIR / "tasks"
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


def copy_image_to_page(path: Path, task_id: str, page_number: int) -> Path:
    output_dir = TASKS_DIR / task_id / "pages"
    output_dir.mkdir(parents=True, exist_ok=True)
    suffix = path.suffix.lower() if path.suffix else ".png"
    target = output_dir / f"page-{page_number}{suffix}"
    target.write_bytes(path.read_bytes())
    return target


def recognize_image(
    path: Path,
    page_number: int | None = None,
    task_id: str | None = None,
) -> dict[str, Any]:
    ensure_image_readable(path)
    engine = get_ocr_engine()
    raw = engine.ocr(str(path), cls=True)
    text_lines, scores = parse_paddle_result(raw)

    payload: dict[str, Any] = {
        "text": "\n".join(text_lines),
        "confidence": sum(scores) / len(scores) if scores else None,
        "engine": "PaddleOCR",
        "warnings": build_warnings(scores),
        "imageName": path.name,
    }

    if task_id:
        payload["imageUrl"] = build_file_url(path)
    else:
        payload["imageDataUrl"] = image_to_data_url(path)

    if page_number is not None:
        payload["pageNumber"] = page_number
    return payload


def ensure_image_readable(path: Path) -> None:
    with Image.open(path) as image:
        image.verify()


def parse_paddle_result(raw: Any) -> tuple[list[str], list[float]]:
    text_lines: list[str] = []
    scores: list[float] = []

    for page_result in raw or []:
        for line in page_result or []:
            if not line or len(line) < 2:
                continue
            text_score = line[1]
            if isinstance(text_score, (list, tuple)) and len(text_score) >= 2:
                text_lines.append(str(text_score[0]))
                try:
                    scores.append(float(text_score[1]))
                except (TypeError, ValueError):
                    pass

    return text_lines, scores


def build_warnings(scores: list[float]) -> list[str]:
    if not scores:
        return ["未返回置信度，请人工核对。"]
    if min(scores) < 0.75:
        return ["存在低置信度文字，请重点核对。"]
    return []


def image_to_data_url(path: Path) -> str:
    mime = "image/png"
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        mime = "image/jpeg"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


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
