"""Durable, global document scheduler hosted by the data API.

Only this worker advances registered documents. OCR and LLM use the existing
HTTP services; no models, browser sessions or synthetic tasks are needed.
Registration preempts at operation boundaries (in-flight calls drain first).
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
from typing import Any
from urllib import error, request

logger = logging.getLogger(__name__)
TERMINAL = {"completed", "failed", "cancelled"}
MAX_ATTEMPTS = 3
RETRY_SECONDS = float(os.getenv("PROCESSING_RETRY_SECONDS", "10"))


class ServiceUnavailable(RuntimeError):
    """Retry after recovery, without consuming the ordinary failure budget."""


class ProcessingFailure(RuntimeError):
    """Bad files/results/protocols have a finite retry budget."""


def ensure_schema(connection):
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS processing_jobs (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id TEXT NOT NULL UNIQUE REFERENCES documents(id),
            mode TEXT NOT NULL CHECK(mode IN ('serial', 'parallel')),
            phase TEXT NOT NULL DEFAULT 'registration',
            status TEXT NOT NULL DEFAULT 'queued',
            source_path TEXT NOT NULL,
            checkpoint TEXT NOT NULL DEFAULT '{}',
            retry_at REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_processing_jobs_queue
            ON processing_jobs(phase, status, sequence);
    """)


def metadata(document):
    return {key: str(document.get(key) or "") for key in ("title", "author", "year", "publisher")}


def upgrade_checkpoint(checkpoint):
    """登记阶段只剩元数据识别：旧任务的封面步骤检查点直接前进到下一步。"""
    if checkpoint.get("registrationStep") in {"cover_candidate", "cover"}:
        checkpoint["registrationStep"] = "metadata_candidate"
    for key in ("coverCandidate", "cover"):
        checkpoint.pop(key, None)
    return checkpoint


class HttpServices:
    """Small stdlib adapter; server-to-server URLs never come from clients."""
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
            kind = result.get("errorKind")
            if kind == "processing":
                raise ProcessingFailure(result.get("message") or "识别结果无效")
            if kind == "unavailable":
                raise ServiceUnavailable(result.get("message") or "等候中")
            # Rolling deployment: old services lack errorKind. A live, ready
            # provider returning malformed content must not wait indefinitely.
            health = self._request(f"{self.llm_url}/health", timeout=5)
            cls = ServiceUnavailable if not health.get("ready") else ProcessingFailure
            raise cls(result.get("message") or "识别结果无效")
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

    def execute(self, operation, job, document, checkpoint, page_number=0):
        source = Path(job["source_path"])
        if operation == "metadata_candidate":
            return self._form("/ocr/metadata-candidate", "document", source)
        if operation == "metadata":
            text = checkpoint["metadataCandidate"].get("text") or document.get("fileName") or source.name
            result = self._llm("extract-metadata", {"documentId": document["id"], "text": text,
                "source": "ocr", "metadata": metadata(document)})
            if not isinstance(result.get("metadata"), dict):
                raise ProcessingFailure("元数据结果无效")
            return result
        if operation == "prepare":
            if source.suffix.lower() == ".pdf":
                import fitz
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
                content = source.read_bytes()
            else:
                import fitz
                with fitz.open(source) as pdf:
                    content = pdf.load_page(page_number - 1).get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).tobytes("png")
                mime = "image/png"
            return {"imageDataUrl": f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}"}
        if operation == "ocr":
            page = next(page for page in document["pages"] if page["pageNumber"] == page_number)
            image_path = (Path(job["asset_root"]) / page["imageFile"]["path"]).resolve()
            if not image_path.is_relative_to(Path(job["asset_root"]).resolve()):
                raise ProcessingFailure("页面图片路径无效")
            return self._form("/ocr", "image", image_path, {"pageNumber": page_number})
        if operation == "llm":
            page = next(page for page in document["pages"] if page["pageNumber"] == page_number)
            previous = sorted((p for p in document["pages"] if p["pageNumber"] < page_number and (
                p.get("cleanText") or p.get("punctuatedText"))), key=lambda p: p["pageNumber"])[-2:]
            result = self._llm("finalize-page", {
                "documentId": document["id"], "pageId": page["id"], "pageNumber": page_number,
                "metadata": metadata(document), "ocrText": page.get("ocrText", ""),
                "cleanText": page.get("cleanText", ""), "punctuatedText": page.get("punctuatedText", ""),
                "previousPages": [{"pageNumber": p["pageNumber"], "text": p.get("punctuatedText") or p.get("cleanText", "")} for p in previous]})
            if page.get("ocrText", "").strip() and not (result.get("cleanText") or result.get("punctuatedText")):
                raise ProcessingFailure("整理服务没有返回正文")
            return result
        raise ProcessingFailure(f"未知阶段：{operation}")


def preserve_server_fields(connection, document):
    """A stale browser sync must never overwrite a scheduler checkpoint."""
    row = connection.execute("SELECT payload FROM documents WHERE id=?", (document["id"],)).fetchone()
    job = connection.execute("SELECT mode FROM processing_jobs WHERE document_id=?", (document["id"],)).fetchone()
    if not row or not job:
        return document
    stored = json.loads(row["payload"])
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
    # Notes remain editable. Processed text/status and the page list belong to
    # the scheduler while it is active; ordinary metadata remains editable.
    active = connection.execute("SELECT status FROM processing_jobs WHERE document_id=?", (document["id"],)).fetchone()["status"] not in TERMINAL
    incoming = {p.get("id"): p for p in document.get("pages", [])}
    pages = []
    for page in stored.get("pages", []):
        edit = incoming.get(page["id"])
        merged = dict(page)
        if edit:
            merged["notes"] = edit.get("notes", page.get("notes", ""))
            if not active or page.get("llmDone"):
                for key in ("cleanText", "punctuatedText"):
                    if key in edit:
                        # A stale unprocessed snapshot has no authority to erase
                        # freshly generated text. Explicit text editing is kept.
                        if edit.get("processingRevision", -1) == page.get("processingRevision", 0):
                            merged[key] = edit[key]
        pages.append(merged)
    document["pages"] = pages
    return document


def save_job_state(data, connection, job, doc, cp):
    stamp = data.now_iso()
    doc["updatedAt"] = stamp
    task = doc.get("processingTask") or {}
    task["revision"] = int(task.get("revision") or 0) + 1
    task["metadataSnapshot"] = metadata(doc)
    doc["processingTask"] = task
    data.materialize_document_assets(connection, doc["id"], doc, stamp)
    connection.execute("UPDATE documents SET payload=?, updated_at=?, version=version+1 WHERE id=? AND deleted_at IS NULL",
                       (data.json_dump(doc), stamp, doc["id"]))
    data.upsert_document_pages(connection, doc["id"], doc.get("pages", []), stamp)
    connection.execute("UPDATE processing_jobs SET phase=?, status=?, checkpoint=?, retry_at=?, updated_at=? WHERE document_id=?",
                       (job["phase"], job["status"], data.json_dump(cp), job["retry_at"], stamp, doc["id"]))
    data.bump_sync_version(connection)


class Scheduler:
    def __init__(self, data, services=None, clock=time.time):
        self.data = data
        self.services = services or HttpServices()
        self.clock = clock
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="document-stage")
        self.running: dict[str, tuple[Future, str, str, int]] = {}
        self.stop_event = threading.Event()
        self.thread = None
        self.lock_file = None

    def _save(self, connection, job, doc, cp):
        save_job_state(self.data, connection, job, doc, cp)

    def _load(self, connection, document_id):
        row = connection.execute("SELECT * FROM processing_jobs WHERE document_id=?", (document_id,)).fetchone()
        document = connection.execute("SELECT payload FROM documents WHERE id=? AND deleted_at IS NULL", (document_id,)).fetchone()
        if not row or not document or row["status"] in TERMINAL:
            return None
        return dict(row), json.loads(document["payload"]), upgrade_checkpoint(json.loads(row["checkpoint"]))

    @staticmethod
    def _page(doc, number):
        for page in doc["pages"]:
            if page["pageNumber"] == number:
                return page
        page = {"id": f"{doc['id']}-page-{number}", "pageNumber": number, "ocrText": "", "cleanText": "", "punctuatedText": "", "notes": "", "status": "待整理"}
        doc["pages"].append(page)
        doc["pages"].sort(key=lambda p: p["pageNumber"])
        return page

    def _record(self, document_id, operation, number, future):
        with self.data.database() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            loaded = self._load(connection, document_id)
            if not loaded:
                return
            job, doc, cp = loaded
            task = doc["processingTask"]
            task.setdefault("activeStages", {}).pop("registration" if job["phase"] == "registration" else "ocr" if operation in {"prepare", "render"} else operation, None)
            key = f"{operation}:{number}"
            try:
                result = future.result()
            except Exception as exc:
                task["message"] = str(exc)
                # Concurrent lane successes must not accidentally clear another
                # lane's wait. Each failed operation has its own durable retry.
                cp.setdefault("errors", {})[key] = str(exc)
                if isinstance(exc, ServiceUnavailable):
                    cp.setdefault("waiting", {})[key] = self.clock() + RETRY_SECONDS
                else:
                    cp.get("waiting", {}).pop(key, None)
                    attempts = cp.setdefault("attempts", {})
                    attempts[key] = attempts.get(key, 0) + 1
                    if attempts[key] < MAX_ATTEMPTS:
                        cp.setdefault("retries", {})[key] = self.clock() + RETRY_SECONDS
                    elif job["phase"] == "body" and operation in {"render", "ocr", "llm"}:
                        page = self._page(doc, number)
                        failed_lane = "ocr" if operation == "render" else operation
                        page["processingRevision"] = int(page.get("processingRevision") or 0) + 1
                        page["failureStage"] = failed_lane
                        page["failureMessage"] = str(exc)
                        page["status"] = "识别失败" if failed_lane == "ocr" else "生成失败"
                        page[f"{failed_lane}Done"] = True
                        if failed_lane == "ocr":
                            page["llmDone"] = True
                            cp["ocrNext"] = number + 1
                        else:
                            cp["llmNext"] = number + 1
                        cp.get("retries", {}).pop(key, None)
                    else:
                        job["status"] = "failed"
                        task["status"] = "处理失败"
                        task["finishedAt"] = self.data.now_iso()
                        doc["status"] = "登记未完成" if job["phase"] == "registration" else "处理失败"
                        if job["phase"] == "registration":
                            doc["registration"].update(status="failed", error=str(exc))
                # Health-classified failures do not eat the ordinary retry budget.
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
                    cp.update(totalPages=result["totalPages"], ocrNext=1, llmNext=1)
                    # Keep the initial page id (reader selections), discard no
                    # processed pages: prepare is only run before any body OCR.
                    doc["pages"] = doc.get("pages", [])[:1]
                    task["totalPages"] = result["totalPages"]
                elif operation == "render":
                    page = self._page(doc, number)
                    page.update(imageDataUrl=result["imageDataUrl"], imageName=f"page-{number}.png")
                    cp["renderedPage"] = number
                elif operation == "ocr":
                    page = self._page(doc, number)
                    page["processingRevision"] = int(page.get("processingRevision") or 0) + 1
                    page.update(ocrText=str(result.get("text") or ""), ocr={k: result.get(k) for k in ("confidence", "engine", "warnings", "width", "height")}, ocrDone=True, status="已识别",
                                imageName=page.get("imageName") or f"page-{number}.png")
                    cp["ocrNext"] = number + 1
                elif operation == "llm":
                    page = self._page(doc, number)
                    page["processingRevision"] = int(page.get("processingRevision") or 0) + 1
                    page.update(cleanText=str(result.get("cleanText") or "").strip(),
                                punctuatedText=str(result.get("punctuatedText") or "").strip(), llmDone=True, status="已生成整理稿")
                    cp["llmNext"] = number + 1
            self._update_status(job, doc, cp)
            self._save(connection, job, doc, cp)

    def _update_status(self, job, doc, cp):
        if job["status"] in TERMINAL:
            return
        task = doc["processingTask"]
        if job["phase"] == "body":
            task["completedPages"] = sum(bool(p.get("ocrDone")) for p in doc["pages"]) + len(cp.get("omittedPages", []))
            task["finalizedPages"] = sum(bool(p.get("llmDone")) for p in doc["pages"]) + len(cp.get("omittedPages", []))
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
        # Commit a checkpoint BEFORE handing work to a thread. On a process
        # restart this same stage is retried, never reset to the first page.
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
            self._save(connection, job, doc, cp)
        job["asset_root"] = str(self.data.FILE_STORAGE_DIR)
        source_path = (self.data.FILE_STORAGE_DIR / job["source_path"]).resolve()
        if not source_path.is_relative_to(self.data.FILE_STORAGE_DIR.resolve()):
            future = Future()
            future.set_exception(ProcessingFailure("归档原件路径无效"))
        else:
            job["source_path"] = str(source_path)
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
                    self._save(connection, job, doc, cp)

    def tick(self):
        for lane, (future, doc_id, operation, number) in list(self.running.items()):
            if future.done():
                self._record(doc_id, operation, number, future)
                del self.running[lane]
        with self.data.database() as connection:
            jobs = [dict(row) for row in connection.execute("""
                SELECT j.* FROM processing_jobs j JOIN documents d ON d.id=j.document_id
                WHERE d.deleted_at IS NULL AND j.status NOT IN ('completed','failed','cancelled')
                ORDER BY j.sequence
            """)]
        registrations = [job for job in jobs if job["phase"] == "registration" and job["retry_at"] <= self.clock()]
        if registrations:
            # Do not overlap registration with any in-flight body operation.
            # In parallel mode both lanes drain before priority work begins.
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
        job = bodies[0]  # Never skip a waiting head to process another document.
        # Source archival reserves FIFO order even if registration is still
        # waiting for service. Later registrations may be prepared, but their
        # bodies cannot overtake this real, unfinished document.
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
        # Failed OCR pages remain visible but need no LLM call.
        previous_llm_next = cp["llmNext"]
        while cp["llmNext"] < cp["ocrNext"]:
            if cp["llmNext"] in cp.get("omittedPages", []):
                cp["llmNext"] += 1
                continue
            page = self._page(doc, cp["llmNext"])
            if not page.get("llmDone"):
                break
            cp["llmNext"] += 1
        if cp["llmNext"] != previous_llm_next:
            with self.data.database() as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                loaded = self._load(connection, doc["id"])
                if not loaded:
                    return
                saved_job, saved_doc, saved_cp = loaded
                saved_cp["llmNext"] = cp["llmNext"]
                self._save(connection, saved_job, saved_doc, saved_cp)
        if cp["ocrNext"] > total and cp["llmNext"] > total and not self.running:
            with self.data.database() as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                loaded = self._load(connection, doc["id"])
                if not loaded:
                    return
                job, doc, saved = loaded
                saved["llmNext"] = cp["llmNext"]
                job.update(status="completed", retry_at=0)
                task = doc["processingTask"]
                task.update(status="已完成", finishedAt=self.data.now_iso(), currentPageProgress=100,
                            currentPageStage="已完成", finalizedPages=total, pausedForRegistration=False, activeStages={},
                            message="正文处理及结果保存完成" + ("，失败页需人工处理" if task.get("failedPages") else ""))
                doc["status"] = "已完成"
                self._save(connection, job, doc, saved)
            return
        for lane, number in self._body_operations(job, cp, total):
            operation = "render" if lane == "ocr" and cp.get("renderedPage") != number else lane
            key = f"{operation}:{number}"
            if lane in self.running or cp.get("retries", {}).get(key, 0) > self.clock():
                continue
            # On outage only retry operations that caused it, before advancing
            # another lane. A service outage therefore pauses this document at
            # its exact checkpoint instead of silently changing the selected mode.
            if cp.get("waiting") and key not in cp["waiting"]:
                continue
            if cp.get("waiting", {}).get(key, 0) > self.clock():
                continue
            self._launch(lane, job, doc, cp, operation, number)

    @staticmethod
    def _body_operations(job, cp, total):
        """Return the next real stages for the fixed document mode.

        Serial is deliberately one operation at a time: OCR/render page N,
        then the shared LLM finalizer for page N, then page N+1. Parallel has
        two independent lanes: OCR may advance to any page while the LLM lane
        consumes completed OCR pages in order. Both lanes call the same service
        contract and prompt, so mode only changes scheduling, not semantics.
        """
        if job["mode"] == "serial":
            if cp["ocrNext"] <= total and cp["ocrNext"] <= cp["llmNext"]:
                return [("ocr", cp["ocrNext"])]
            if cp["llmNext"] < cp["ocrNext"] and cp["llmNext"] <= total:
                return [("llm", cp["llmNext"])]
            return []

        operations = []
        if cp["ocrNext"] <= total:
            operations.append(("ocr", cp["ocrNext"]))
        if cp["llmNext"] < cp["ocrNext"] and cp["llmNext"] <= total:
            operations.append(("llm", cp["llmNext"]))
        return operations

    def _acquire_worker_lock(self):
        # A process-lifetime OS lock prevents duplicate workers, including
        # uvicorn --workers. It is automatically released on process death.
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
                    self._save(connection, job, doc, cp)
        return True

    def _run(self):
        while not self.stop_event.is_set():
            try:
                if self.lock_file is not None or self._acquire_worker_lock():
                    self.tick()
            except Exception:
                logger.exception("Document scheduler tick failed; durable state retained")
            self.stop_event.wait(0.25)
        # Drain in-flight calls before releasing the single-worker lock.
        # If killed instead, persisted checkpoints retry after restart.
        self.executor.shutdown(wait=True)
        for future, doc_id, operation, number in self.running.values():
            self._record(doc_id, operation, number, future)
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
