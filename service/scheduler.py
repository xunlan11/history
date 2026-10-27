"""由数据接口托管的持久化全局文献调度器。

只有此工作器会推进已登记文献。OCR 和 LLM 使用现有 HTTP 服务，无需在此处
加载模型、保持浏览器会话或创建模拟任务。登记任务会在操作边界抢占，先等待
正在执行的调用完成。
"""
from __future__ import annotations

import base64
import http.client
import json
import logging
import mimetypes
import os
import socket
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from urllib import error, request
from urllib.parse import quote

from service.variant import to_simplified
from service import reader_index

logger = logging.getLogger(__name__)
TERMINAL = {"completed", "failed", "cancelled"}
MAX_ATTEMPTS = 3
RETRY_SECONDS = float(os.getenv("PROCESSING_RETRY_SECONDS", "10"))


def _env_int(name, default, minimum=1):
    """环境变量读成整数；写错时退回默认值，不能因为一个配置笔误让调度器起不来。"""
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


# 处理链路：serial 逐页串行、parallel 四阶段流水线、chunked 大串小并（块间串行、块内并行）。
PROCESSING_MODES = ("serial", "parallel", "chunked")
DEFAULT_PROCESSING_MODE = "chunked"
CHUNK_SIZE_DEFAULT = 3
CHUNK_SIZE_MAX = 10
# 线程池大小和块内并行度都是环境变量：换大设备只调配置，不改代码。
STAGE_WORKERS = _env_int("PROCESSING_STAGE_WORKERS", 4)
# 块内每个阶段可同时处理几页。默认 1 = 和并行链路完全一致（四阶段各一路、错位推进）；
# 只有确实需要同一阶段并行多页时才调大。
STAGE_LANES = _env_int("PROCESSING_STAGE_LANES", 1)


def normalize_chunk_size(value, default=CHUNK_SIZE_DEFAULT):
    """块大小只允许 1..CHUNK_SIZE_MAX；非法值退回默认值。"""
    try:
        size = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(CHUNK_SIZE_MAX, size))


# 渲染页既用于阅读回显，也是 OCR 的输入图；JPEG q90 在 1.5 倍缩放下肉眼无损，
# 体积约为 PNG 的一半，避免单页 data URL 接近 1MB。
RENDER_SCALE = 1.5
RENDER_JPEG_QUALITY = 90
# 校对只用于判断本页开头的续句与简称，喂整页会让提示词越过模型上下文。
PREVIOUS_PAGE_TAIL_CHARS = int(os.getenv("PROCESSING_PREVIOUS_PAGE_TAIL_CHARS", "300"))
PROCESSING_STAGES = ("ocr", "variant", "punctuation", "proofreading")
STAGE_LABELS = {
    "ocr": "文字识别",
    "variant": "简繁转换",
    "punctuation": "标点符号",
    "proofreading": "校对",
}


class ServiceUnavailable(RuntimeError):
    """服务恢复后重试，且不消耗普通失败重试次数。"""


class ProcessingFailure(RuntimeError):
    """文件、结果或协议异常使用有限的重试次数。"""


PROCESSING_JOBS_DDL = """
        CREATE TABLE IF NOT EXISTS processing_jobs (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id TEXT NOT NULL UNIQUE REFERENCES documents(id),
            mode TEXT NOT NULL CHECK(mode IN ('serial', 'parallel', 'chunked')),
            chunk_size INTEGER NOT NULL DEFAULT 3,
            phase TEXT NOT NULL DEFAULT 'registration',
            status TEXT NOT NULL DEFAULT 'queued',
            source_path TEXT NOT NULL,
            checkpoint TEXT NOT NULL DEFAULT '{}',
            retry_at REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
"""


PROCESSING_QUEUE_INDEX_DDL = """
        CREATE INDEX IF NOT EXISTS idx_processing_jobs_queue
            ON processing_jobs(phase, status, sequence)
"""


def ensure_current_schema(connection):
    """把既有库的 processing_jobs 升级到支持分块链路；新库由 ensure_schema 建表。

    每次 connect 都会调用，所以先用一次 sqlite_master 查询探底：已升级时只剩一句
    幂等的 CREATE INDEX IF NOT EXISTS。
    """
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='processing_jobs'").fetchone()
    if row is None:
        return  # 新库交给 ensure_schema 建表建索引
    if "chunked" not in (row["sql"] or ""):
        connection.execute("BEGIN IMMEDIATE")
        try:
            _upgrade_processing_jobs(connection)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    # 重建表会连带丢掉旧索引，这里补回来（已存在时是空操作）。
    connection.execute(PROCESSING_QUEUE_INDEX_DDL)


def _upgrade_processing_jobs(connection):
    """把旧的 processing_jobs 重建成支持分块链路的形状。

    SQLite 无法直接放宽 CHECK 约束，只能重建表。旧库里的任务按默认块大小继续处理，
    已登记的串行/并行不受影响。
    """
    columns = {item[1] for item in connection.execute("PRAGMA table_info(processing_jobs)")}
    chunk_expr = "chunk_size" if "chunk_size" in columns else str(CHUNK_SIZE_DEFAULT)
    # 上一次升级若在中间失败，残留的临时表会挡住 RENAME。
    connection.execute("DROP TABLE IF EXISTS processing_jobs_legacy")
    connection.execute("ALTER TABLE processing_jobs RENAME TO processing_jobs_legacy")
    # 索引名会跟着表走；先删掉，避免新表上 CREATE INDEX IF NOT EXISTS 变成空操作。
    connection.execute("DROP INDEX IF EXISTS idx_processing_jobs_queue")
    connection.execute(PROCESSING_JOBS_DDL)
    connection.execute(f"""INSERT INTO processing_jobs
            (sequence, document_id, mode, chunk_size, phase, status, source_path, checkpoint, retry_at, created_at, updated_at)
        SELECT sequence, document_id, mode, {chunk_expr}, phase, status, source_path, checkpoint, retry_at, created_at, updated_at
        FROM processing_jobs_legacy""")
    connection.execute("DROP TABLE processing_jobs_legacy")


def ensure_schema(connection):
    connection.execute(PROCESSING_JOBS_DDL)
    ensure_current_schema(connection)


def metadata(document):
    return {key: str(document.get(key) or "") for key in ("title", "author", "year", "publisher")}


def previous_page_tail(document, page_number, limit=PREVIOUS_PAGE_TAIL_CHARS):
    """上一页末尾片段：校对只需要承接关系，不能再把整页正文塞进提示词。"""
    candidates = [page for page in document.get("pages") or []
                  if int(page.get("pageNumber") or 0) < page_number
                  and (page.get("punctuatedText") or page.get("punctuationDraftText") or page.get("normalizedText"))]
    if not candidates:
        return []
    page = max(candidates, key=lambda item: int(item.get("pageNumber") or 0))
    text = str(page.get("punctuatedText") or page.get("punctuationDraftText") or page.get("normalizedText") or "").strip()
    if not text:
        return []
    return [{"pageNumber": page.get("pageNumber"), "text": ("…… " + text[-limit:].lstrip()) if len(text) > limit else text}]


def progress_key(document_id, operation, page_number):
    """服务与调度器共用的单页任务进度键。"""
    return f"{document_id}:{operation}:{page_number}"


class HttpServices:
    """标准库 HTTP 适配器；服务间 URL 从不接受客户端传入。"""
    def __init__(self):
        self.ocr_url = os.getenv("PROCESSING_OCR_URL", "http://127.0.0.1:8765").rstrip("/")
        self.llm_url = os.getenv("PROCESSING_LLM_URL", "http://127.0.0.1:8865").rstrip("/")

    def _request(self, url, data=None, content_type="application/json", timeout=None):
        timeout = timeout if timeout is not None else float(os.getenv("PROCESSING_HTTP_TIMEOUT_SECONDS", "1000"))
        req = request.Request(url, data=data, headers={"Content-Type": content_type})
        try:
            with request.urlopen(req, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(body).get("detail", {})
            except (ValueError, AttributeError):
                detail = {}
            if isinstance(detail, dict) and detail.get("code", "").startswith("ocr_upstream_"):
                code, status = detail["code"], detail.get("upstreamStatus")
                unavailable = code in {"ocr_upstream_not_configured", "ocr_upstream_unavailable"} or (
                    code == "ocr_upstream_http_error" and status in {429, 502, 503, 504})
                cls = ServiceUnavailable if unavailable else ProcessingFailure
                raise cls(detail.get("message") or body) from exc
            cls = ServiceUnavailable if exc.code in {429, 502, 503, 504} else ProcessingFailure
            raise cls(f"HTTP {exc.code}: {body[:500]}") from exc
        except (error.URLError, TimeoutError, socket.timeout, OSError, http.client.IncompleteRead) as exc:
            raise ServiceUnavailable(str(exc)) from exc
        except (ValueError, UnicodeError) as exc:
            raise ProcessingFailure("服务返回的不是有效 JSON") from exc
        if not isinstance(result, dict):
            raise ProcessingFailure("服务返回的结果不是对象")
        if result.get("ready") is False:
            if result.get("errorKind") == "unavailable":
                raise ServiceUnavailable(result.get("message") or "等候中")
            raise ProcessingFailure(result.get("message") or "识别结果无效")
        return result

    def _form(self, route, field, path, fields=None):
        boundary = uuid.uuid4().hex
        chunks = []
        for key, value in (fields or {}).items():
            chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        name = Path(path).name.replace('"', '_').replace('\r', '_').replace('\n', '_')
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode())
        chunks.extend([Path(path).read_bytes(), f"\r\n--{boundary}--\r\n".encode()])
        return self._request(f"{self.ocr_url}{route}", b"".join(chunks), f"multipart/form-data; boundary={boundary}")

    def _llm(self, route, payload):
        return self._request(f"{self.llm_url}/llm/{route}", json.dumps(payload).encode("utf-8"))

    def llm_progress(self, key):
        """轮询大模型服务的单页任务进度；短超时，失败由调度器忽略后重试。"""
        return self._request(f"{self.llm_url}/llm/progress/{quote(str(key), safe='')}", timeout=3)

    def ocr_progress(self, key):
        """轮询 OCR 服务的正文或登记候选页实际识别进度。"""
        return self._request(f"{self.ocr_url}/ocr/progress/{quote(str(key), safe='')}", timeout=3)

    def execute(self, operation, job, document, checkpoint, page_number=0):
        source = Path(job["source_path"])
        if operation == "metadata_candidate":
            return self._form("/ocr/metadata-candidate", "document", source,
                              {"progressKey": job.get("ocr_progress_key") or progress_key(document["id"], operation, 0)})
        if operation == "metadata":
            text = checkpoint["metadataCandidate"].get("text") or document.get("fileName") or source.name
            result = self._llm("extract-metadata", {"documentId": document["id"], "text": text,
                "source": "ocr", "metadata": metadata(document),
                "options": {"progressKey": job.get("llm_progress_key") or progress_key(document["id"], operation, 0)}})
            if not isinstance(result.get("metadata"), dict):
                raise ProcessingFailure("元数据结果无效")
            return result
        if operation == "prepare":
            if source.suffix.lower() == ".pdf":
                import pymupdf as fitz
                with fitz.open(source) as pdf:
                    if pdf.needs_pass or pdf.page_count < 1:
                        raise ProcessingFailure("PDF 已加密或没有页面")
                    return {"totalPages": pdf.page_count}
            from PIL import Image
            with Image.open(source) as image:
                image.verify()
            return {"totalPages": 1}
        if operation == "render":
            if source.suffix.lower() != ".pdf":
                mime = mimetypes.guess_type(source.name)[0] or "image/png"
                suffix = source.suffix.lower() or ".png"
                content = source.read_bytes()
            else:
                import pymupdf as fitz
                with fitz.open(source) as pdf:
                    pixmap = pdf.load_page(page_number - 1).get_pixmap(
                        matrix=fitz.Matrix(RENDER_SCALE, RENDER_SCALE), alpha=False)
                content = pixmap.tobytes("jpeg", jpg_quality=RENDER_JPEG_QUALITY)
                mime, suffix = "image/jpeg", ".jpg"
            return {"imageDataUrl": f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}",
                    "imageName": f"page-{page_number}{suffix}"}
        if operation == "ocr":
            page = next(page for page in document["pages"] if page["pageNumber"] == page_number)
            image_path = (Path(job["asset_root"]) / page["imageFile"]["path"]).resolve()
            if not image_path.is_relative_to(Path(job["asset_root"]).resolve()):
                raise ProcessingFailure("页面图片路径无效")
            return self._form("/ocr", "image", image_path, {"pageNumber": page_number,
                              "progressKey": job.get("ocr_progress_key") or progress_key(document["id"], operation, page_number)})
        if operation == "variant":
            page = next(page for page in document["pages"] if page["pageNumber"] == page_number)
            return {"normalizedText": to_simplified(str(page.get("ocrText") or ""))}
        if operation == "punctuation":
            page = next(page for page in document["pages"] if page["pageNumber"] == page_number)
            if not page.get("normalizedText", "").strip():
                return {"punctuatedText": "", "warnings": []}
            result = self._llm("punctuate", {
                "documentId": document["id"], "pageId": page["id"], "pageNumber": page_number,
                "metadata": metadata(document), "sourceText": page.get("normalizedText", ""),
                "sourceLayer": "normalized",
                "options": {"progressKey": job.get("llm_progress_key") or progress_key(document["id"], "punctuation", page_number)}})
            if not result.get("punctuatedText"):
                raise ProcessingFailure("标点服务没有返回正文")
            return result
        if operation == "proofreading":
            page = next(page for page in document["pages"] if page["pageNumber"] == page_number)
            draft = str(page.get("punctuationDraftText") or page.get("normalizedText") or page.get("ocrText") or "").strip()
            if not draft:
                return {"punctuatedText": "", "warnings": []}
            # 只提交标点稿和上一页末尾：OCR 原文、简体稿和各页整页上下文都交给模型，
            # 会让提示词超出模型上下文被截断，反而更容易触发校验失败重试。
            result = self._llm("finalize-page", {
                "documentId": document["id"], "pageId": page["id"], "pageNumber": page_number,
                "metadata": metadata(document),
                "punctuationDraftText": draft,
                "options": {"progressKey": job.get("llm_progress_key") or progress_key(document["id"], "proofreading", page_number)},
                "previousPages": previous_page_tail(document, page_number)})
            if not result.get("punctuatedText"):
                raise ProcessingFailure("校对服务没有返回正文")
            return result
        raise ProcessingFailure(f"未知阶段：{operation}")


def preserve_server_fields(connection, document):
    """过期的浏览器同步绝不能覆盖调度器检查点。"""
    row = connection.execute("SELECT payload FROM documents WHERE id=?", (document["id"],)).fetchone()
    job = connection.execute("SELECT * FROM processing_jobs WHERE document_id=?", (document["id"],)).fetchone()
    if not row or not job:
        return document
    stored = json.loads(row["payload"])
    # 页正文以 document_pages 为准，payload 里不再内嵌 pages。
    stored["pages"] = [json.loads(page["payload"]) for page in connection.execute(
        "SELECT payload FROM document_pages WHERE document_id=? AND deleted_at IS NULL ORDER BY page_number",
        (document["id"],))]
    current_revision = (stored.get("processingTask") or {}).get("revision", 0)
    client_revision = (document.get("processingTask") or {}).get("revision", -1)
    baseline = (document.get("processingTask") or {}).get("metadataSnapshot") or {}
    if client_revision != current_revision:
        for key in ("title", "author", "year", "publisher"):
            if key not in baseline or document.get(key, "") == baseline[key]:
                document[key] = stored.get(key, "")
    for key in ("processingTask", "registration", "status", "metadataStatus",
                "coverImageDataUrl", "coverImageUrl", "coverImageFile", "sourceFile", "fileUrl", "filePath",
                "fileHash", "fileMimeType", "fileSize", "fileName"):
        if key in stored:
            document[key] = stored[key]
    document["processingMode"] = job["mode"]
    # job 是 sqlite3.Row（没有 .get），列名直接取；升级过的表一定有 chunk_size。
    document["processingChunkSize"] = normalize_chunk_size(job["chunk_size"])
    # 备注仍可编辑。调度器运行期间负责正文、状态和页列表；普通元数据仍可编辑。
    active = connection.execute("SELECT status FROM processing_jobs WHERE document_id=?", (document["id"],)).fetchone()["status"] not in TERMINAL
    incoming = {p.get("id"): p for p in document.get("pages", [])}
    pages = []
    for page in stored.get("pages", []):
        edit = incoming.get(page["id"])
        merged = dict(page)
        if edit:
            merged["notes"] = edit.get("notes", page.get("notes", ""))
            if (not active or page.get("proofreadingDone")) and "punctuatedText" in edit:
                # 过期的未处理快照不能删除刚生成的文本；显式文本编辑仍予以保留。
                if edit.get("processingRevision", -1) == page.get("processingRevision", 0):
                    merged["punctuatedText"] = edit["punctuatedText"]
        pages.append(merged)
    document["pages"] = pages
    return document


def save_job_state(data, connection, job, doc, cp, page_ids=None):
    """保存任务状态与页内容。

    `page_ids`：None = 全量对账（结构变化、浏览器推送）；[] = 只保存任务状态；
    非空列表 = 只写这些页。阶段完成时只传当前页，不再重写整本文献的每一页。
    """
    stamp = data.now_iso()
    doc["updatedAt"] = stamp
    task = doc.get("processingTask") or {}
    task["revision"] = int(task.get("revision") or 0) + 1
    task["metadataSnapshot"] = metadata(doc)
    doc["processingTask"] = task
    allowed = None if page_ids is None else set(page_ids)
    data.materialize_document_assets(connection, doc["id"], doc, stamp, page_ids=allowed)
    pages = doc.get("pages") or []
    touched = pages if allowed is None else [page for page in pages if page.get("id") in allowed]
    source_pdf = data.document_source_pdf(connection, doc["id"])
    for page in touched:
        reader_index.reconcile_reader_index(connection, doc["id"], page, stamp, source_pdf=source_pdf)
    connection.execute("UPDATE documents SET payload=?, updated_at=?, version=version+1 WHERE id=? AND deleted_at IS NULL",
                       (data.document_payload(doc), stamp, doc["id"]))
    if allowed is None:
        data.upsert_document_pages(connection, doc["id"], pages, stamp)
    elif touched:
        data.upsert_document_pages(connection, doc["id"], touched, stamp, sweep=False)
    connection.execute("UPDATE processing_jobs SET phase=?, status=?, checkpoint=?, retry_at=?, updated_at=? WHERE document_id=?",
                       (job["phase"], job["status"], data.json_dump(cp), job["retry_at"], stamp, doc["id"]))
    data.bump_sync_version(connection)


class Scheduler:
    def __init__(self, data, services=None, clock=time.time):
        self.data = data
        self.services = services or HttpServices()
        self.clock = clock
        # 并发能力全部来自环境变量：换大设备把 worker 数和在飞页数一起调上去即可。
        self.executor = ThreadPoolExecutor(max_workers=STAGE_WORKERS, thread_name_prefix="document-stage")
        self.running: dict[str, tuple[Future, str, str, int]] = {}
        # 单页任务的实时进度（仅内存）：doc_id -> stage -> {pageNumber, percent, updatedAt}
        self.page_progress: dict[str, dict[str, dict]] = {}
        # 登记阶段的实时进度：doc_id -> {stage, percent, updatedAt}
        self.registration_progress: dict[str, dict] = {}
        self.progress_lock = threading.Lock()
        self.progress_watchers: dict[str, threading.Event] = {}
        self.stop_event = threading.Event()
        self.thread = None
        self.lock_file = None

    def _load(self, connection, document_id):
        row = connection.execute("SELECT * FROM processing_jobs WHERE document_id=?", (document_id,)).fetchone()
        document = connection.execute("SELECT payload FROM documents WHERE id=? AND deleted_at IS NULL", (document_id,)).fetchone()
        if not row or not document or row["status"] in TERMINAL:
            return None
        payload = json.loads(document["payload"])
        payload["pages"] = [json.loads(page["payload"]) for page in connection.execute(
            "SELECT payload FROM document_pages WHERE document_id=? AND deleted_at IS NULL ORDER BY page_number",
            (document_id,))]
        return dict(row), payload, json.loads(row["checkpoint"])

    # —— 单页阶段任务进度（仅内存，供 /processing 读取）——
    def _set_page_progress(self, document_id, stage, page_number, percent, detail=None, stop=None,
                           monotonic=False):
        with self.progress_lock:
            if stop is not None and stop.is_set():
                return
            stages = self.page_progress.setdefault(document_id, {})
            value = max(0, min(100, int(percent or 0)))
            previous = stages.get(stage)
            if previous and int(previous.get("pageNumber") or 0) != int(page_number):
                # 分块模式下同一阶段会有多页并行：界面只报最靠前的那一页，避免数字来回跳。
                if int(previous.get("pageNumber") or 0) < int(page_number):
                    return
            elif monotonic and previous:
                # 重试会换新的进度键并从 0 开始；同一页同一阶段只允许往前推。
                value = max(value, int(previous.get("percent") or 0))
            stages[stage] = {"pageNumber": int(page_number),
                             "percent": value, "updatedAt": self.clock(),
                             **({"detail": dict(detail)} if detail else {})}

    def _clear_page_progress(self, document_id, stage, page_number=None):
        with self.progress_lock:
            stages = self.page_progress.get(document_id)
            if not stages:
                return
            entry = stages.get(stage)
            if entry and page_number is not None and int(entry.get("pageNumber") or 0) != int(page_number):
                # 该阶段还有更靠前的页在处理，清掉会让进度倒退。
                return
            stages.pop(stage, None)
            if not stages:
                self.page_progress.pop(document_id, None)

    def progress_snapshot(self, document_id):
        with self.progress_lock:
            return {stage: dict(entry) for stage, entry in (self.page_progress.get(document_id) or {}).items()}

    def _set_registration_progress(self, document_id, stage, percent, detail=None, stop=None):
        with self.progress_lock:
            if stop is not None and stop.is_set():
                return
            self.registration_progress[document_id] = {"stage": stage,
                "percent": max(0, min(100, int(percent or 0))), "updatedAt": self.clock(),
                **({"detail": dict(detail)} if detail else {})}

    def _clear_registration_progress(self, document_id):
        with self.progress_lock:
            self.registration_progress.pop(document_id, None)

    def registration_snapshot(self, document_id):
        with self.progress_lock:
            entry = self.registration_progress.get(document_id)
            return dict(entry) if entry else {}

    def _start_progress_watcher(self, lane, document_id, stage, page_number, registration=False, source="llm", key=None):
        self._stop_progress_watcher(lane)
        stop = threading.Event()
        self.progress_watchers[lane] = stop
        threading.Thread(target=self._watch_progress,
                         args=(document_id, stage, page_number, registration, source, stop, key),
                         name=f"progress-{stage}-{page_number}", daemon=True).start()

    def _stop_progress_watcher(self, lane):
        stop = self.progress_watchers.pop(lane, None)
        if stop:
            with self.progress_lock:
                stop.set()

    def _watch_progress(self, document_id, stage, page_number, registration, source, stop, key=None):
        key = key or progress_key(document_id, stage, page_number)
        reader = self.services.ocr_progress if source == "ocr" else self.services.llm_progress
        while not stop.wait(0.5):
            try:
                payload = reader(key)
            except Exception:  # 服务暂时不可达时保持已有百分比
                continue
            if not payload.get("updatedAt"):
                continue
            if registration:
                self._set_registration_progress(document_id, stage, payload.get("percent"),
                                                detail=payload if source == "ocr" else None, stop=stop)
            else:
                # 大模型逐字生成时重试会从 0 重新播报，页面进度取历史最大值避免倒退。
                self._set_page_progress(document_id, stage, page_number, payload.get("percent"),
                                        detail=payload if source == "ocr" else None, stop=stop,
                                        monotonic=source != "ocr")

    @staticmethod
    def _page(doc, number):
        for page in doc["pages"]:
            if page["pageNumber"] == number:
                page.setdefault("stageStatus", {})
                page.setdefault("normalizedText", "")
                page.setdefault("punctuationDraftText", "")
                for stage in PROCESSING_STAGES:
                    page.setdefault(f"{stage}Done", False)
                return page
        page = {
            "id": f"{doc['id']}-page-{number}", "pageNumber": number,
            "ocrText": "", "normalizedText": "", "punctuationDraftText": "",
            "punctuatedText": "", "notes": "",
            "stageStatus": {}, "status": "待整理",
        }
        doc["pages"].append(page)
        doc["pages"].sort(key=lambda p: p["pageNumber"])
        return page

    @staticmethod
    def _stage_terminal(page, stage):
        if page.get(f"{stage}Done"):
            return True
        status = (page.get("stageStatus") or {}).get(stage)
        if status in {"done", "failed", "skipped"}:
            return True
        failure_stage = page.get("failureStage")
        if failure_stage in PROCESSING_STAGES:
            failure_index = PROCESSING_STAGES.index(failure_stage)
            return PROCESSING_STAGES.index(stage) > failure_index and failure_stage in {"ocr", "variant"}
        return False

    @staticmethod
    def _stage_failed(page, stage):
        return (page.get("stageStatus") or {}).get(stage) == "failed" or page.get("failureStage") == stage

    @staticmethod
    def _set_stage(page, stage, status):
        page.setdefault("stageStatus", {})[stage] = status
        page[f"{stage}Done"] = True

    @classmethod
    def _skip_downstream(cls, page, stage):
        index = PROCESSING_STAGES.index(stage)
        for downstream in PROCESSING_STAGES[index + 1:]:
            cls._set_stage(page, downstream, "skipped")

    @classmethod
    def _stage_progress(cls, doc, cp, total):
        omitted = set(cp.get("omittedPages", []))
        pages = {int(page.get("pageNumber")): page for page in doc.get("pages", []) if page.get("pageNumber")}
        progress = {}
        for stage in PROCESSING_STAGES:
            done = len(omitted)
            for number in range(1, total + 1):
                if number in omitted:
                    continue
                page = pages.get(number)
                if page and cls._stage_terminal(page, stage):
                    done += 1
            progress[stage] = {"done": min(total, done), "total": total}
        return progress

    def _record(self, document_id, operation, number, future, lane=None):
        with self.data.database() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            loaded = self._load(connection, document_id)
            if not loaded:
                return
            job, doc, cp = loaded
            task = doc["processingTask"]
            active_stage = "ocr" if operation == "render" else operation
            # 分块模式下 lane 是 "阶段:页号"，每条在飞任务只清理自己那一条。
            task.setdefault("activeStages", {}).pop(lane or active_stage, None)
            key = f"{operation}:{number}"
            try:
                result = future.result()
            except Exception as exc:
                task["message"] = str(exc)
                cp.setdefault("errors", {})[key] = str(exc)
                if isinstance(exc, ServiceUnavailable):
                    cp.setdefault("waiting", {})[key] = self.clock() + RETRY_SECONDS
                else:
                    cp.get("waiting", {}).pop(key, None)
                    attempts = cp.setdefault("attempts", {})
                    attempts[key] = attempts.get(key, 0) + 1
                    if attempts[key] < MAX_ATTEMPTS:
                        cp.setdefault("retries", {})[key] = self.clock() + RETRY_SECONDS
                    elif job["phase"] == "body" and operation in {"render", *PROCESSING_STAGES}:
                        page = self._page(doc, number)
                        failed_stage = "ocr" if operation == "render" else operation
                        page["processingRevision"] = int(page.get("processingRevision") or 0) + 1
                        page["failureStage"] = page.get("failureStage") or failed_stage
                        page["failureMessage"] = str(exc)
                        page["status"] = f"{STAGE_LABELS[failed_stage]}失败"
                        self._set_stage(page, failed_stage, "failed")
                        if failed_stage in {"ocr", "variant"}:
                            self._skip_downstream(page, failed_stage)
                        elif failed_stage == "proofreading":
                            page["punctuatedText"] = ""
                        cp.setdefault("stageErrors", {})[failed_stage] = str(exc)
                        cp.get("retries", {}).pop(key, None)
                    else:
                        job["status"] = "failed"
                        task["status"] = "处理失败"
                        task["finishedAt"] = self.data.now_iso()
                        doc["status"] = "登记未完成" if job["phase"] == "registration" else "处理失败"
                        if job["phase"] == "registration":
                            doc["registration"].update(status="failed", error=str(exc))
            else:
                for field in ("waiting", "retries", "errors", "attempts"):
                    cp.get(field, {}).pop(key, None)
                if operation == "metadata_candidate":
                    cp["metadataCandidate"] = result
                    cp["registrationStep"] = "metadata"
                elif operation == "metadata":
                    for field, value in result["metadata"].items():
                        if field in {"title", "author", "year", "publisher"} and not str(doc.get(field) or "").strip() and isinstance(value, (str, int)):
                            doc[field] = str(value).strip()
                    doc["metadataStatus"] = "已自动识别"
                    doc["registration"].update(status="completed", stage="completed", metadata="completed", completedAt=self.data.now_iso(), error="")
                    cp.pop("metadataCandidate", None)
                    job.update(phase="body", status="queued")
                    task.update(status="排队中", message="登记准备完成，正文按后端队列顺序处理。")
                    doc["status"] = "排队中"
                elif operation == "prepare":
                    cp.update(totalPages=result["totalPages"], stageNext={stage: 1 for stage in PROCESSING_STAGES})
                    cp.setdefault("omittedPages", [])
                    doc["pages"] = doc.get("pages", [])[:1]
                    task["totalPages"] = result["totalPages"]
                elif operation == "render":
                    page = self._page(doc, number)
                    page.update(imageDataUrl=result["imageDataUrl"],
                                imageName=result.get("imageName") or f"page-{number}")
                    cp["renderedPage"] = number
                elif operation == "ocr":
                    page = self._page(doc, number)
                    page["processingRevision"] = int(page.get("processingRevision") or 0) + 1
                    page.update(ocrText=str(result.get("text") or ""), ocr={k: result.get(k) for k in ("confidence", "engine", "warnings", "width", "height")}, status="已识别",
                                imageName=page.get("imageName") or f"page-{number}")
                    page.update(visuals=result.get("visuals") or [], visualsExtracted=True)
                    self._set_stage(page, "ocr", "done")
                    reader_index.save_ocr_layout(connection, doc["id"], page, result, self.data.now_iso())
                elif operation == "variant":
                    page = self._page(doc, number)
                    page["processingRevision"] = int(page.get("processingRevision") or 0) + 1
                    page["normalizedText"] = str(result.get("normalizedText") or "").strip()
                    page["status"] = "已完成简繁转换"
                    self._set_stage(page, "variant", "done")
                elif operation == "punctuation":
                    page = self._page(doc, number)
                    page["processingRevision"] = int(page.get("processingRevision") or 0) + 1
                    page["punctuationDraftText"] = str(result.get("punctuatedText") or "").strip()
                    page["status"] = "已完成标点"
                    self._set_stage(page, "punctuation", "done")
                elif operation == "proofreading":
                    page = self._page(doc, number)
                    page["processingRevision"] = int(page.get("processingRevision") or 0) + 1
                    page.update(punctuatedText=str(result.get("punctuatedText") or "").strip(),
                                status="已生成整理稿")
                    self._set_stage(page, "proofreading", "done")
            self._update_status(job, doc, cp)
            if operation == "prepare":
                # prepare 会按真实页数重建页列表，必须全量对账（含占位页的软删除）。
                save_job_state(self.data, connection, job, doc, cp)
            elif operation in {"render", "ocr", "variant", "punctuation", "proofreading"}:
                save_job_state(self.data, connection, job, doc, cp, page_ids=[self._page(doc, number)["id"]])
            else:
                # 登记类操作只改任务状态，不动页内容。
                save_job_state(self.data, connection, job, doc, cp, page_ids=[])

    def _update_status(self, job, doc, cp):
        if job["status"] in TERMINAL:
            return
        task = doc["processingTask"]
        if job["phase"] == "body":
            total = int(cp.get("totalPages") or task.get("totalPages") or 0)
            progress = self._stage_progress(doc, cp, total)
            task["stageProgress"] = progress
            task["completedPages"] = progress["ocr"]["done"]
            task["finalizedPages"] = progress["proofreading"]["done"]
            task["failedPages"] = [{"pageNumber": p["pageNumber"], "stage": p["failureStage"], "message": p.get("failureMessage", "")} for p in doc["pages"] if p.get("failureStage")]
        waiting = cp.get("waiting", {})
        retry_times = list(waiting.values()) + list(cp.get("retries", {}).values())
        job["retry_at"] = min(retry_times, default=0)
        if waiting:
            job["status"] = "waiting"
            task["status"] = doc["status"] = "等候中"
            if job["phase"] == "registration":
                doc["registration"].update(status="waiting", error=task.get("message", ""))
            return
        if job["phase"] == "registration":
            doc["registration"]["status"] = "running"
            task["status"] = doc["status"] = "登记中"
            job["status"] = "running"
        else:
            if job["status"] == "queued":
                task["status"] = doc["status"] = "排队中"
            else:
                task["status"] = doc["status"] = "处理中"
                job["status"] = "running"

    def _launch(self, lane, job, doc, cp, operation, number=0):
        # 在线程接手任务前先提交检查点。进程重启后会重试当前阶段，不会重置到第一页。
        with self.data.database() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            loaded = self._load(connection, doc["id"])
            if not loaded:
                return
            job, doc, cp = loaded
            job["status"] = "running"
            task = doc["processingTask"]
            task.setdefault("activeStages", {})[lane] = {"operation": operation, "pageNumber": number}
            task["pausedForRegistration"] = False
            task.update(currentPage=number, currentPageStage=operation, currentPageProgress=0,
                        message="正在准备登记" if job["phase"] == "registration" else "正在处理正文")
            if job["phase"] == "registration":
                doc["registration"]["stage"] = "metadata"
            self._update_status(job, doc, cp)
            # 启动阶段只记录任务状态，页内容要到结果回写时才变。
            save_job_state(self.data, connection, job, doc, cp, page_ids=[])
        job["asset_root"] = str(self.data.FILE_STORAGE_DIR)
        source_path = (self.data.FILE_STORAGE_DIR / job["source_path"]).resolve()
        if not source_path.is_relative_to(self.data.FILE_STORAGE_DIR.resolve()):
            future = Future()
            future.set_exception(ProcessingFailure("归档原件路径无效"))
        else:
            job["source_path"] = str(source_path)
            # OCR 每次尝试独立进度键，避免重试时读取上次已完成的条目。
            if operation in {"ocr", "metadata_candidate"}:
                key = f"{progress_key(doc['id'], operation, number)}:{uuid.uuid4().hex}"
                job["ocr_progress_key"] = key
                if operation == "ocr":
                    self._set_page_progress(doc["id"], operation, number, 0)
                else:
                    self._set_registration_progress(doc["id"], operation, 0)
                self._start_progress_watcher(lane, doc["id"], operation, number,
                                             registration=operation == "metadata_candidate", source="ocr", key=key)
            # 标点/校对是大模型逐字生成，边生成边回报该页该阶段的百分比。
            # 每次尝试都用独立进度键：同一页重试时不会先读到上一次留下的百分比。
            elif operation in {"punctuation", "proofreading"}:
                key = f"{progress_key(doc['id'], operation, number)}:{uuid.uuid4().hex}"
                job["llm_progress_key"] = key
                # 重试不把该页该阶段已有的百分比清零，进度只许前进（完成后由 tick 清掉）。
                self._set_page_progress(doc["id"], operation, number, 0, monotonic=True)
                self._start_progress_watcher(lane, doc["id"], operation, number, key=key)
            # 登记元数据识别继续由大模型流式回报（同样每次尝试独立键）。
            elif operation == "metadata":
                key = f"{progress_key(doc['id'], operation, 0)}:{uuid.uuid4().hex}"
                job["llm_progress_key"] = key
                self._set_registration_progress(doc["id"], operation, 0)
                self._start_progress_watcher(lane, doc["id"], operation, 0, registration=True, key=key)
            future = self.executor.submit(self.services.execute, operation, job, doc, cp, number)
        self.running[lane] = (future, doc["id"], operation, number)

    def _pause_body_for_registration(self):
        with self.data.database() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("""SELECT j.document_id FROM processing_jobs j JOIN documents d ON d.id=j.document_id
                WHERE j.phase='body' AND j.status='running' AND d.deleted_at IS NULL ORDER BY j.sequence LIMIT 1""").fetchone()
            loaded = self._load(connection, row["document_id"]) if row else None
            if loaded:
                job, doc, cp = loaded
                if not doc["processingTask"].get("pausedForRegistration"):
                    doc["processingTask"]["pausedForRegistration"] = True
                    save_job_state(self.data, connection, job, doc, cp, page_ids=[])

    def tick(self):
        for lane, (future, doc_id, operation, number) in list(self.running.items()):
            if future.done():
                self._stop_progress_watcher(lane)
                self._record(doc_id, operation, number, future, lane)
                del self.running[lane]
                if operation in {"metadata_candidate", "metadata"}:
                    self._clear_registration_progress(doc_id)
                else:
                    self._clear_page_progress(doc_id, "ocr" if operation == "render" else operation, number)
        with self.data.database() as connection:
            jobs = [dict(row) for row in connection.execute("""
                SELECT j.* FROM processing_jobs j JOIN documents d ON d.id=j.document_id
                WHERE d.deleted_at IS NULL AND j.status NOT IN ('completed','failed','cancelled')
                ORDER BY j.sequence
            """)]
        registrations = [job for job in jobs if job["phase"] == "registration" and job["retry_at"] <= self.clock()]
        if registrations:
            # 登记不能与正在执行的正文操作重叠；并行模式下两条通道都排空后才开始优先任务。
            if not self.running:
                self._pause_body_for_registration()
                job = registrations[0]
                with self.data.database() as connection:
                    loaded = self._load(connection, job["document_id"])
                if loaded:
                    job, doc, cp = loaded
                    self._launch("registration", job, doc, cp, cp.get("registrationStep", "metadata_candidate"))
            return
        if "registration" in self.running:
            return
        bodies = [job for job in jobs if job["phase"] == "body"]
        if not bodies:
            return
        job = bodies[0]  # 不能跳过正在等待的队首文献去处理另一份文献。
        # 原件归档保留先进先出顺序，即使登记仍在等待服务。后续登记可以准备，
        # 但其正文不能越过这份真实且尚未完成的文献。
        if any(entry["phase"] == "registration" and entry["sequence"] < job["sequence"] for entry in jobs):
            return
        with self.data.database() as connection:
            loaded = self._load(connection, job["document_id"])
        if not loaded:
            return
        job, doc, cp = loaded
        if any(entry[1] != doc["id"] for entry in self.running.values()):
            return
        if job["retry_at"] > self.clock():
            return
        if not cp.get("totalPages"):
            if not self.running:
                self._launch("ocr", job, doc, cp, "prepare")
            return
        total = cp["totalPages"]
        if self._body_complete(doc, cp, total) and not self.running:
            with self.data.database() as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                loaded = self._load(connection, doc["id"])
                if not loaded:
                    return
                job, doc, saved = loaded
                job.update(status="completed", retry_at=0)
                task = doc["processingTask"]
                task.update(status="已完成", finishedAt=self.data.now_iso(), currentPageProgress=100,
                            currentPageStage="已完成", finalizedPages=total, pausedForRegistration=False, activeStages={},
                            stageProgress={stage: {"done": total, "total": total} for stage in PROCESSING_STAGES},
                            message="正文处理及结果保存完成" + ("，失败页需人工处理" if task.get("failedPages") else ""))
                task["completedPages"] = total
                doc["status"] = "已完成"
                save_job_state(self.data, connection, job, doc, saved, page_ids=[])
            return
        busy = {(entry[2], entry[3]) for entry in self.running.values()}
        for lane, operation, number in self._body_operations(job, doc, cp, total, busy=busy):
            key = f"{operation}:{number}"
            if lane in self.running or cp.get("retries", {}).get(key, 0) > self.clock():
                continue
            if cp.get("waiting") and key not in cp["waiting"]:
                continue
            if cp.get("waiting", {}).get(key, 0) > self.clock():
                continue
            self._launch(lane, job, doc, cp, operation, number)

    @classmethod
    def _body_complete(cls, doc, cp, total):
        omitted = set(cp.get("omittedPages", []))
        pages = {}
        for page in doc.get("pages", []):
            pages.setdefault(page.get("pageNumber"), page)
        for number in range(1, total + 1):
            if number in omitted:
                continue
            page = pages.get(number)
            if not page or not cls._stage_terminal(page, "proofreading"):
                return False
        return True

    @classmethod
    def _body_operations(cls, job, doc, cp, total, busy=None):
        """选择依赖就绪的阶段。

        - serial：逐页完成四个阶段后再进入下一页。
        - parallel：四阶段跨页流水线，每个阶段最多一路。
        - chunked：按 chunk_size 分块，块间串行；块内就是并行链路（四阶段错位推进），
          只是可选页被限制在当前块内。
        """
        omitted = set(cp.get("omittedPages", []))
        pages = {}
        for page in doc.get("pages", []):
            pages.setdefault(page.get("pageNumber"), page)

        def page_for(number):
            return pages.get(number)

        def ready(stage, page):
            if cls._stage_terminal(page, stage):
                return False
            index = PROCESSING_STAGES.index(stage)
            previous = PROCESSING_STAGES[index - 1] if index else None
            if previous and not cls._stage_terminal(page, previous):
                return False
            if stage in {"variant", "punctuation", "proofreading"} and cls._stage_failed(page, "ocr"):
                return False
            if stage in {"punctuation", "proofreading"} and cls._stage_failed(page, "variant"):
                return False
            return True

        def operation_for(stage, page):
            if stage == "ocr" and not page.get("imageFile") and not page.get("imageDataUrl"):
                return ("ocr", "render")
            return (stage, stage)

        if job["mode"] == "serial":
            for number in range(1, total + 1):
                if number in omitted:
                    continue
                page = page_for(number) or {"pageNumber": number}
                for stage in PROCESSING_STAGES:
                    if ready(stage, page):
                        lane, operation = operation_for(stage, page)
                        return [(lane, operation, number)]
                if not cls._stage_terminal(page, "proofreading"):
                    return []
            return []

        if job["mode"] == "chunked":
            return cls._chunked_operations(job, total, omitted, page_for, ready, operation_for, busy or set())

        operations = []
        for stage in PROCESSING_STAGES:
            for number in range(1, total + 1):
                if number in omitted:
                    continue
                page = page_for(number)
                if page is None:
                    page = {"pageNumber": number}
                if ready(stage, page):
                    lane, operation = operation_for(stage, page)
                    operations.append((lane, operation, number))
                    break
        return operations

    @classmethod
    def _chunked_operations(cls, job, total, omitted, page_for, ready, operation_for, busy):
        """大串小并：块间串行，块内按并行链路的四阶段错位推进。

        `PROCESSING_STAGE_LANES` 默认 1，即每个阶段同时只处理一页，行为与 parallel 一致；
        调大后同一阶段也能并行多页（仅换大设备时才需要）。
        """
        size = normalize_chunk_size(job.get("chunk_size"))
        current = None
        for start in range(1, total + 1, size):
            numbers = [number for number in range(start, min(start + size, total + 1)) if number not in omitted]
            if not numbers:
                continue
            if all(cls._stage_terminal(page_for(number) or {"pageNumber": number}, "proofreading") for number in numbers):
                continue
            current = numbers
            break
        if not current:
            return []

        def previous_punctuation_ready(number):
            if number <= 1:
                return True
            previous = page_for(number - 1)
            if previous is None or cls._stage_failed(previous, "ocr"):
                # 没渲染或前页没有正文时没有上文可用，不能让这一页永远等下去。
                return True
            return cls._stage_terminal(previous, "punctuation")

        operations = []
        for stage in PROCESSING_STAGES:
            # 名额要按「该阶段真正在飞的数量」算：在飞的页虽然被跳过，但已经占住了这一路。
            stage_operations = {"render", "ocr"} if stage == "ocr" else {stage}
            slots = STAGE_LANES - sum(1 for operation, _ in busy if operation in stage_operations)
            if slots <= 0:
                continue  # 这一路已经满了，本轮不再给这个阶段排新页
            for number in current:
                if slots <= 0:
                    break
                page = page_for(number) or {"pageNumber": number}
                if not ready(stage, page):
                    continue
                lane, operation = operation_for(stage, page)
                if (operation, number) in busy:
                    continue  # 这页这个阶段已在处理
                if stage == "proofreading" and not previous_punctuation_ready(number):
                    continue  # 等上一页标点完成再借上文
                operations.append((f"{lane}:{number}", operation, number))
                slots -= 1
        return operations

    def _acquire_worker_lock(self):
        # 进程生命周期内的操作系统锁可防止重复工作器，包括 uvicorn --workers。
        # 进程退出后锁会自动释放。
        path = self.data.DB_PATH.with_suffix(".processing.lock")
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                if path.stat().st_size == 0:
                    handle.write(b"0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        self.lock_file = handle
        with self.data.database() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            ids = [r["document_id"] for r in connection.execute("SELECT document_id FROM processing_jobs WHERE status NOT IN ('completed','failed','cancelled')")]
            for doc_id in ids:
                loaded = self._load(connection, doc_id)
                if loaded:
                    job, doc, cp = loaded
                    doc["processingTask"]["activeStages"] = {}
                    save_job_state(self.data, connection, job, doc, cp, page_ids=[])
        return True

    def _run(self):
        while not self.stop_event.is_set():
            try:
                if self.lock_file is not None or self._acquire_worker_lock():
                    self.tick()
            except Exception:
                logger.exception("Document scheduler tick failed; durable state retained")
            self.stop_event.wait(0.25)
        # 释放单工作器锁前先排空正在执行的调用；如果进程被终止，持久化检查点会在重启后重试。
        self.executor.shutdown(wait=True)
        for stop in list(self.progress_watchers.values()):
            stop.set()
        self.progress_watchers.clear()
        for lane, (future, doc_id, operation, number) in list(self.running.items()):
            self._record(doc_id, operation, number, future, lane)
        if self.lock_file:
            self.lock_file.close()
            self.lock_file = None

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._run, name="document-scheduler", daemon=True)
            self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)
