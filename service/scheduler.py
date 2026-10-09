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
from typing import Any
from urllib import error, request

logger = logging.getLogger(__name__)
TERMINAL = {"completed", "failed", "cancelled"}
MAX_ATTEMPTS = 3
RETRY_SECONDS = float(os.getenv("PROCESSING_RETRY_SECONDS", "10"))


class ServiceUnavailable(RuntimeError):
    """服务恢复后重试，且不消耗普通失败重试次数。"""


class ProcessingFailure(RuntimeError):
    """文件、结果或协议异常使用有限的重试次数。"""


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
    """过期的浏览器同步绝不能覆盖调度器检查点。"""
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
    # 备注仍可编辑。调度器运行期间负责正文、状态和页列表；普通元数据仍可编辑。
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
                        # 过期的未处理快照不能删除刚生成的文本；显式文本编辑仍予以保留。
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
                # 并发通道成功时不能误清除另一通道的等待状态；每个失败操作都有独立的持久化重试。
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
                # 按健康状态分类的失败不消耗普通重试次数。
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
                    # 保留初始页 ID（阅读页选择），不丢弃已处理页面：prepare 只会在正文 OCR 前执行。
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
            save_job_state(self.data, connection, job, doc, cp)

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
            save_job_state(self.data, connection, job, doc, cp)
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
                    save_job_state(self.data, connection, job, doc, cp)

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
        # OCR 失败的页面仍保持可见，但无需调用 LLM。
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
                save_job_state(self.data, connection, saved_job, saved_doc, saved_cp)
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
                save_job_state(self.data, connection, job, doc, saved)
            return
        for lane, number in self._body_operations(job, cp, total):
            operation = "render" if lane == "ocr" and cp.get("renderedPage") != number else lane
            key = f"{operation}:{number}"
            if lane in self.running or cp.get("retries", {}).get(key, 0) > self.clock():
                continue
            # 服务中断时只重试导致中断的操作，再推进另一条通道。因此文献会停在准确检查点，
            # 不会静默改变已选择的模式。
            if cp.get("waiting") and key not in cp["waiting"]:
                continue
            if cp.get("waiting", {}).get(key, 0) > self.clock():
                continue
            self._launch(lane, job, doc, cp, operation, number)

    @staticmethod
    def _body_operations(job, cp, total):
        """返回固定文献模式下接下来要执行的真实阶段。

        串行模式每次只执行一个操作：先对第 N 页执行 OCR/渲染，再由共享的
        LLM 完成第 N 页，最后进入第 N+1 页。并行模式有两条独立通道：OCR
        可以推进到任意页面，LLM 通道则按顺序消费已完成 OCR 的页面。两条通道
        使用相同的服务契约和提示词，因此模式只改变调度方式，不改变语义。
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
                    save_job_state(self.data, connection, job, doc, cp)
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
