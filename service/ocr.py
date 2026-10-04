"""OCR 服务：对外接口 + 拆页 / 任务编排 / 存储；识别能力全部来自服务端。

数据端只做三件事：接收上传、拆页与任务编排、把结果落盘并回给前端。
**不加载任何识别模型，也没有自研的图像预处理与版面分析**——版面结构、阅读顺序、
表格与图片区域一律采用服务端（数据处理服务器）的返回结果。
服务端契约与部署方式见 `deploy/README.md`，调用实现见 `service/ocr_upstream.py`。

对外接口（前端契约，Nginx 前缀由 `root/nginx/conf.d/*.conf` 剥离）：

- `GET  /health`                     健康检查（含服务端可达性）
- `POST /ocr`                        单页识别（image / pageNumber / quickRead）
- `POST /ocr/cover-candidate`        封面候选图提取（数据端拆页，不经服务端）
- `POST /ocr/stream`                 整本逐页识别任务提交
- `GET  /ocr/stream/{task_id}`       任务进度与逐页结果
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import threading
import time
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

try:  # `uvicorn service.ocr:app` 时是包内导入；直接跑脚本时退化为平级导入
    from . import ocr_upstream
except ImportError:  # pragma: no cover
    import ocr_upstream  # type: ignore[no-redef]

APP_DIR = Path(__file__).resolve().parent.parent
# OCR 存储目录可用 OCR_STORAGE_DIR 环境变量覆盖（/literature 实例指向独立目录）
STORAGE_DIR = Path(os.getenv("OCR_STORAGE_DIR", APP_DIR / "ocr-storage")).resolve()
TASKS_DIR = STORAGE_DIR / "tasks"
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

TASKS: dict[str, dict[str, Any]] = {}
PROCESSING_SLOT = threading.Semaphore(1)

# 取消标记：**存在任务目录之外**（cancelled/<task_id>），因为取消时要立刻删掉任务目录
# （原件 + 逐页图，动辄几十 MB），标记如果跟着被删，正在跑的循环就发现不了、会继续跑完。
CANCEL_DIR = STORAGE_DIR / "cancelled"
# temp/ 下临时文件（封面候选图、单页识别残留）的保留时长
TEMP_MAX_AGE_SECONDS = 24 * 3600
# 没有 task.json 的空壳任务目录的保留时长
ORPHAN_TASK_MAX_AGE_SECONDS = 3600
# 取消标记的保留时长（够长到任务不可能再写文件即可）
CANCEL_MARKER_MAX_AGE_SECONDS = 7 * 24 * 3600


class TaskCancelled(Exception):
    """任务被取消（文献已删除 / 手动停止）。"""


def cancel_marker_path(task_id: str) -> Path:
    return CANCEL_DIR / task_id


def is_task_cancelled(task_id: str) -> bool:
    return cancel_marker_path(task_id).exists()


def raise_if_cancelled(task_id: str) -> None:
    """逐页循环毎页前调用：命中取消标记就中断整本任务。"""
    if is_task_cancelled(task_id):
        raise TaskCancelled(f"任务 {task_id} 已取消")


def mark_task_cancelled(task_id: str) -> bool:
    try:
        CANCEL_DIR.mkdir(parents=True, exist_ok=True)
        cancel_marker_path(task_id).write_text(str(time.time()), encoding="utf-8")
    except OSError:
        return False
    return True


def cleanup_cancel_markers(max_age_seconds: int = CANCEL_MARKER_MAX_AGE_SECONDS) -> int:
    if not CANCEL_DIR.exists():
        return 0
    now = time.time()
    removed = 0
    for path in CANCEL_DIR.iterdir():
        if not path.is_file():
            continue
        try:
            if now - path.stat().st_mtime > max_age_seconds:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def task_storage_bytes(task_id: str) -> int:
    task_dir = TASKS_DIR / task_id
    if not task_dir.exists():
        return 0
    return sum(path.stat().st_size for path in task_dir.rglob("*") if path.is_file())


def delete_task_storage(task_id: str) -> int:
    """删掉任务目录（原件 + 逐页图），返回释放的字节数。"""
    freed = task_storage_bytes(task_id)
    shutil.rmtree(TASKS_DIR / task_id, ignore_errors=True)
    TASKS.pop(task_id, None)
    return freed


def cancel_task(task_id: str) -> int:
    mark_task_cancelled(task_id)
    return delete_task_storage(task_id)


def cleanup_temp_files(max_age_seconds: int = TEMP_MAX_AGE_SECONDS) -> int:
    """清理 temp/ 下的陈旧临时文件，给新登记腾地方。"""
    temp_dir = STORAGE_DIR / "temp"
    if not temp_dir.exists():
        return 0
    now = time.time()
    removed = 0
    for path in temp_dir.iterdir():
        if not path.is_file():
            continue
        try:
            if now - path.stat().st_mtime > max_age_seconds:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def cleanup_orphan_task_dirs(max_age_seconds: int = ORPHAN_TASK_MAX_AGE_SECONDS) -> int:
    """清理没有 task.json 的空壳任务目录（提交中断留下的）。"""
    if not TASKS_DIR.exists():
        return 0
    now = time.time()
    removed = 0
    for task_dir in TASKS_DIR.glob("task-*"):
        if not task_dir.is_dir() or (task_dir / "task.json").exists():
            continue
        try:
            if now - task_dir.stat().st_mtime > max_age_seconds:
                shutil.rmtree(task_dir, ignore_errors=True)
                TASKS.pop(task_dir.name, None)
                removed += 1
        except OSError:
            continue
    return removed

# 不进入正文的版面角色（按服务端标签判定，不含任何本地版面推断）：
# 页眉、页脚、页码，以及不含文字内容的图片 / 图表 / 印章区域。
NON_BODY_BLOCK_TYPES = {"header", "footer", "page_number", "figure", "chart", "seal", "image"}


def upstream_unavailable(exc: ocr_upstream.OcrUpstreamError) -> HTTPException:
    """服务端未部署 / 不可达 / 协议不符 → 503，`detail` 带机器可读的 code。"""
    return HTTPException(status_code=503, detail=exc.as_detail())


def require_upstream_configured() -> None:
    if not ocr_upstream.upstream_url():
        raise upstream_unavailable(ocr_upstream.not_configured_error())


def call_upstream(func: Any, *args: Any, **kwargs: Any) -> Any:
    """把服务端异常转成 503，避免 FastAPI 直接回 500。"""
    try:
        return func(*args, **kwargs)
    except ocr_upstream.OcrUpstreamError as exc:
        raise upstream_unavailable(exc) from exc


@app.get("/health")
def health():
    upstream = ocr_upstream.health()
    return {
        "status": "ok",
        "service": "ocr",
        "storage": str(STORAGE_DIR),
        "upstream": upstream,
        "ready": bool(upstream.get("configured") and upstream.get("reachable")),
    }


@app.post("/ocr")
async def recognize_page(
    image: UploadFile = File(...),
    pageNumber: str = Form("1"),
    quick_read: str = Form("false", alias="quickRead"),
):
    page_path = await save_upload(image)
    result = call_upstream(
        recognize_image,
        page_path,
        quick_read=quick_read.lower() == "true",
    )
    result["pageNumber"] = int(pageNumber or 1)
    return JSONResponse(result)


@app.post("/ocr/cover-candidate")
async def extract_cover_candidate(document: UploadFile = File(...)):
    """封面候选图：数据端拆页 + 缩图，不依赖服务端识别能力。"""
    source_path = await save_upload(document, prefix=f"cover-{uuid.uuid4().hex[:8]}")
    candidate = build_cover_candidate(source_path)
    candidate["sourceFileName"] = document.filename
    return JSONResponse(candidate)


@app.post("/ocr/stream")
async def submit_stream(
    background_tasks: BackgroundTasks,
    document: UploadFile = File(...),
    documentId: str = Form(""),
    title: str = Form(""),
    quick_read: str = Form("false", alias="quickRead"),
):
    # 服务端没部署时立刻拒绝，避免任务排队后才失败。
    require_upstream_configured()

    task_id = f"task-{uuid.uuid4().hex[:12]}"
    task_dir = TASKS_DIR / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    source_path = await save_task_source(document, task_dir)
    is_quick = quick_read.lower() == "true"
    task = {
        "taskId": task_id,
        "documentId": documentId,
        "title": title or document.filename,
        "status": "排队中",
        "message": (
            "临时文件已接收，等待快速读取。"
            if is_quick
            else "任务已接收，等待逐页识别。"
        ),
        "totalPages": 0,
        "pages": [],
        "sourceFileName": document.filename,
        "sourcePath": str(source_path),
        "quickRead": is_quick,
    }
    save_task(task)
    background_tasks.add_task(process_stream_task, task_id)

    return JSONResponse(public_task(task))


@app.get("/ocr/stream/{task_id}")
def get_stream(task_id: str):
    task = load_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return JSONResponse(public_task(task))


@app.delete("/ocr/stream/{task_id}")
def cancel_stream(task_id: str):
    """取消单个任务并删除它的缓存（原件 + 逐页图）。正在跑的任务会在本页结束后停下。"""
    task = load_task(task_id)
    if not task and not (TASKS_DIR / task_id).exists():
        raise HTTPException(status_code=404, detail="任务不存在")
    freed = cancel_task(task_id)
    return {"status": "ok", "cancelled": [task_id], "freedBytes": freed}


@app.delete("/ocr/stream")
def cancel_streams_by_document(documentId: str = ""):
    """按文献取消它的全部任务并清缓存（删除文献时调用），幂等。"""
    document_id = (documentId or "").strip()
    if not document_id:
        raise HTTPException(status_code=400, detail="documentId 不能为空")

    cancelled: list[str] = []
    freed = 0
    for task_file in TASKS_DIR.glob("task-*/task.json"):
        task = load_task(task_file.parent.name)
        if not task or str(task.get("documentId") or "") != document_id:
            continue
        task_id = str(task.get("taskId") or task_file.parent.name)
        freed += cancel_task(task_id)
        cancelled.append(task_id)
    return {"status": "ok", "cancelled": cancelled, "freedBytes": freed}


@app.on_event("startup")
def recover_pending_tasks() -> None:
    """Resume tasks that were queued when the OCR service was restarted."""
    cleanup_temp_files()
    cleanup_orphan_task_dirs()
    cleanup_cancel_markers()

    for task_path in TASKS_DIR.glob("task-*/task.json"):
        task = load_task(task_path.parent.name)
        if not task:
            continue
        task_id = str(task.get("taskId") or task_path.parent.name)
        # 被取消的任务（文献已删除 / 手动停止）不恢复，顺手把缓存清掉。
        if is_task_cancelled(task_id):
            delete_task_storage(task_id)
            continue
        if task.get("status") not in {"排队中", "处理中", "准备中"}:
            continue
        task["status"] = "排队中"
        task["message"] = "服务已恢复，任务等待处理。"
        save_task(task)
        threading.Thread(
            target=process_stream_task,
            args=(task["taskId"],),
            daemon=True,
        ).start()


def upload_suffix(filename: str | None, fallback: str) -> str:
    return Path(filename or fallback).suffix or ".bin"


async def save_upload(upload: UploadFile, prefix: str | None = None) -> Path:
    suffix = upload_suffix(upload.filename, "upload.bin")
    name = f"{prefix or uuid.uuid4().hex}{suffix}"
    path = STORAGE_DIR / "temp" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(await upload.read())
    return path


async def save_task_source(upload: UploadFile, task_dir: Path) -> Path:
    suffix = upload_suffix(upload.filename, "document.bin")
    path = task_dir / f"source{suffix}"
    path.write_bytes(await upload.read())
    return path


def process_stream_task(task_id: str) -> None:
    if is_task_cancelled(task_id):
        delete_task_storage(task_id)
        return

    PROCESSING_SLOT.acquire()
    try:
        task = load_task(task_id)
        if not task:
            return
        if is_task_cancelled(task_id):
            return
        quick_read = bool(task.get("quickRead"))
        task["status"] = "处理中"
        task["message"] = "正在快速拆页并提交服务端识别。" if quick_read else "正在拆页并提交服务端识别，请稍后刷新。"
        task["totalPages"] = 0
        task["completedPages"] = 0
        task["currentPage"] = 0
        task["currentPageStage"] = "准备中"
        task["currentPageProgress"] = 0
        save_task(task)

        try:
            raise_if_cancelled(task_id)
            pages, total_pages = process_document(
                Path(task["sourcePath"]),
                task_id,
                quick_read=quick_read,
            )
            task["pages"] = pages
            task["totalPages"] = total_pages
            task["completedPages"] = total_pages
            task["currentPage"] = total_pages
            task["currentPageStage"] = "已完成"
            task["currentPageProgress"] = 100
            task["status"] = "已完成"
            task["message"] = (
                "临时文件已快速读取。"
                if quick_read
                else "逐页处理完成，请回到平台查看结果。"
            )
        except TaskCancelled:
            task["status"] = "已取消"
            task["message"] = "任务已取消，缓存已清理。"
        except ocr_upstream.OcrUpstreamError as exc:
            task["status"] = "处理失败"
            task["message"] = f"识别服务端不可用：{exc}"
        except Exception as exc:  # noqa: BLE001
            task["status"] = "处理失败"
            task["message"] = f"处理失败：{exc}"

        save_task(task)
    finally:
        PROCESSING_SLOT.release()
        # 被取消的任务不留缓存（原件 + 逐页图），腾出空间给后登记的文献。
        if is_task_cancelled(task_id):
            delete_task_storage(task_id)


def process_document(
    path: Path,
    task_id: str,
    quick_read: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    if path.suffix.lower() == ".pdf":
        return process_pdf(path, task_id, quick_read=quick_read)

    page_path = copy_image_to_page(path, task_id, 1)
    set_stream_progress(
        task_id,
        completed_pages=0,
        total_pages=1,
        current_page=1,
        stage="提交识别中",
        progress=10,
    )
    result = recognize_image(
        page_path,
        page_number=1,
        task_id=task_id,
        on_progress=make_page_progress_callback(task_id, 1, 1),
        quick_read=quick_read,
    )
    set_stream_pages(task_id, [result])
    set_stream_progress(
        task_id,
        completed_pages=1,
        total_pages=1,
        current_page=1,
        stage="已完成",
        progress=100,
    )
    return [result], 1


def process_pdf(
    path: Path,
    task_id: str,
    quick_read: bool = False,
) -> tuple[list[dict[str, Any]], int]:
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
            raise_if_cancelled(task_id)
            set_stream_progress(
                task_id,
                completed_pages=index - 1,
                total_pages=total_pages,
                current_page=index,
                stage="拆页中",
                progress=5,
            )
            scale = 1.5 if quick_read else 2
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            image_path = output_dir / f"page-{index}.png"
            pix.save(image_path)
            pages.append(
                recognize_image(
                    image_path,
                    page_number=index,
                    task_id=task_id,
                    on_progress=make_page_progress_callback(task_id, index, total_pages),
                    quick_read=quick_read,
                )
            )
            # 每页识别完成后增量写回，前端可边轮询边把已识别页交给大模型整理。
            set_stream_pages(task_id, pages)
            set_stream_progress(
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


def recognize_image(
    path: Path,
    page_number: int | None = None,
    task_id: str | None = None,
    on_progress: Any = None,
    quick_read: bool = False,
) -> dict[str, Any]:
    """单页图片 → 服务端识别 → 组对外响应。

    本函数不再做灰度/矫正/倾斜/栏位等任何本地图像或版面处理；`blocks`、
    `lines`、阅读顺序、表格与图片区域全部来自服务端。
    """
    ensure_image_readable(path)
    mode = "quick" if quick_read else "formal"
    report_progress(on_progress, "快速识别" if quick_read else "提交服务端识别", 50)
    result = ocr_upstream.recognize_page_image(path, page_number=page_number, mode=mode)

    blocks = result.get("blocks") or []
    lines = result.get("lines") or []
    text = "\n".join(
        block["text"]
        for block in blocks
        if block.get("text") and block.get("type") not in NON_BODY_BLOCK_TYPES
    ).strip()
    scores = confidences(lines)

    payload: dict[str, Any] = {
        "text": text,
        "confidence": sum(scores) / len(scores) if scores else None,
        "engine": result.get("engine") or "remote",
        "readMode": mode,
        "width": result.get("width"),
        "height": result.get("height"),
        "blocks": blocks,
        "lines": lines,
        "markdown": result.get("markdown"),
        "warnings": build_warnings(result),
        "imageName": path.name,
        "upstream": result.get("upstream"),
    }

    if task_id:
        payload["imageUrl"] = build_file_url(path)
    else:
        payload["imageDataUrl"] = image_to_data_url(path)

    if page_number is not None:
        payload["pageNumber"] = page_number

    report_progress(on_progress, "已完成", 100)
    return payload


def confidences(lines: list[dict[str, Any]]) -> list[float]:
    return [
        line["confidence"]
        for line in lines
        if isinstance(line.get("confidence"), (int, float))
    ]


def build_warnings(result: dict[str, Any]) -> list[str]:
    """只依据服务端返回的识别结果提示，不做任何自研版面判断。"""
    warnings = [str(item) for item in result.get("warnings") or [] if str(item).strip()]
    blocks = result.get("blocks") or []
    lines = result.get("lines") or []
    scores = confidences(lines)

    if not blocks and not lines:
        warnings.append("服务端没有返回任何文本，请检查原图清晰度或服务端识别配置。")
    elif not scores:
        warnings.append("服务端未返回置信度，建议对照原图检查。")
    elif min(scores) < 0.75:
        warnings.append("存在低置信度文字，建议对照原图检查。")

    types = {block.get("type") for block in blocks}
    if {"table", "table_title"} & types:
        warnings.append("服务端标出了表格区域，表格内容以结构化文本保留，建议对照原图核对。")
    if {"figure", "figure_title", "chart", "seal"} & types:
        warnings.append("服务端标出了图片、图表或印章区域，这些区域不进入正文。")
    if {"header", "footer", "page_number"} & types:
        warnings.append("服务端把页眉、页脚或页码标为独立区域，已保留在版面结构中但不进入正文。")
    if "footnote" in types:
        warnings.append("服务端标出了脚注区域，建议检查归属。")

    return warnings


def ensure_image_readable(path: Path) -> None:
    with Image.open(path) as image:
        image.verify()


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
        set_stream_progress(
            task_id,
            completed_pages=page_number - 1,
            total_pages=total_pages,
            current_page=page_number,
            stage=stage,
            progress=progress,
        )

    return on_progress


def set_stream_progress(
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


def set_stream_pages(task_id: str, pages: list[dict[str, Any]]) -> None:
    task = load_task(task_id)
    if not task:
        return

    task["pages"] = list(pages)
    save_task(task)
