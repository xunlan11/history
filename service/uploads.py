"""临时上传与正式登记分离，取消不会影响已登记原件。"""
from __future__ import annotations

import hashlib
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field


router = APIRouter(prefix="/api/uploads")
UPLOAD_TTL_SECONDS = 24 * 3600
_cleanup_stop = threading.Event()
_cleanup_thread = None


def ensure_schema(connection):
    connection.execute("""CREATE TABLE IF NOT EXISTS pending_uploads (
        id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, status TEXT NOT NULL,
        file_name TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL DEFAULT '', document_id TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL)""")
    columns = {row[1] for row in connection.execute('PRAGMA table_info(pending_uploads)')}
    if 'document_id' not in columns:
        connection.execute("ALTER TABLE pending_uploads ADD COLUMN document_id TEXT NOT NULL DEFAULT ''")
    connection.execute("""CREATE TABLE IF NOT EXISTS upload_registrations (
        id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, created_at REAL NOT NULL)""")


def upload_root():
    from service import data
    return Path(data.STORAGE_DIR) / "uploads"


def require_upload(connection, upload_id, user):
    row = connection.execute("SELECT * FROM pending_uploads WHERE id=?", (upload_id,)).fetchone()
    if not row:
        raise HTTPException(404, "上传任务不存在")
    if row["owner_id"] != user["id"]:
        raise HTTPException(403, "无权操作此上传")
    return row


def remove_file(row):
    if row["path"]:
        try:
            (upload_root() / row["path"]).unlink(missing_ok=True)
        except PermissionError:
            # Windows 上合并中的文件可能暂时占用，留给过期清理。
            pass


def cleanup_expired():
    from service import data
    cutoff = time.time() - UPLOAD_TTL_SECONDS
    with data.database() as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute("SELECT * FROM pending_uploads WHERE status!='registered' AND updated_at<?", (cutoff,)).fetchall()
        for row in rows:
            remove_file(row)
            connection.execute("DELETE FROM pending_uploads WHERE id=?", (row["id"],))
    root = upload_root()
    if root.exists():
        # 清理进程中止后遗留的分块文件。
        for path in root.glob("*.part"):
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)


def start_cleanup():
    global _cleanup_thread
    if _cleanup_thread and _cleanup_thread.is_alive():
        return
    _cleanup_stop.clear()
    def run():
        while not _cleanup_stop.is_set():
            try:
                cleanup_expired()
            except Exception:
                import logging
                logging.getLogger(__name__).exception("临时上传清理失败")
            _cleanup_stop.wait(300)
    _cleanup_thread = threading.Thread(target=run, name="upload-cleanup", daemon=True)
    _cleanup_thread.start()


def stop_cleanup():
    _cleanup_stop.set()
    if _cleanup_thread:
        _cleanup_thread.join(timeout=2)


class UploadStart(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9-]{1,100}$")
    fileName: str = Field(min_length=1)
    size: int = Field(gt=0)
    mimeType: str = "application/octet-stream"


class Registration(BaseModel):
    title: str = ""
    author: str = ""
    publisher: str = ""
    year: str = ""
    tags: str = ""
    uploadIds: list[str] = Field(min_length=1)
    coverVariant: int = 0
    processingMode: str = "chunked"
    processingChunkSize: int = 3


@router.post("")
def begin_upload(payload: UploadStart):
    from service import data
    user = data.current_user()
    with data.database() as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("""INSERT OR IGNORE INTO pending_uploads
            (id,owner_id,status,file_name,size,mime_type,updated_at) VALUES(?,?,'uploading',?,?,?,?)""",
            (payload.id, user["id"], payload.fileName, payload.size, payload.mimeType, time.time()))
        row = require_upload(connection, payload.id, user)
        if row["status"] == "cancelled":
            raise HTTPException(409, "上传已取消")
        if (row["file_name"], row["size"], row["mime_type"]) != (payload.fileName, payload.size, payload.mimeType):
            raise HTTPException(409, "上传文件信息不一致")
    return {"id": payload.id, "status": row["status"]}


@router.post("/{upload_id}/file")
async def upload_file(upload_id: str, document: UploadFile = File(...)):
    from service import data
    user = data.current_user()
    with data.database() as connection:
        row = require_upload(connection, upload_id, user)
    if row["status"] not in {"uploading", "ready"}:
        raise HTTPException(409, "上传已取消或已登记")
    root = upload_root()
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{upload_id}-{secrets.token_hex(8)}.part"
    saved = False
    try:
        digest, size = hashlib.sha256(), 0
        with path.open("wb") as output:
            while chunk := await document.read(1024 * 1024):
                size += len(chunk)
                if size > row["size"]:
                    raise HTTPException(422, "上传文件大小不符")
                output.write(chunk)
                digest.update(chunk)
        if size != row["size"]:
            raise HTTPException(422, "上传文件不完整")
        with data.database() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            current = require_upload(connection, upload_id, user)
            if current["status"] not in {"uploading", "ready"}:
                raise HTTPException(409, "上传已取消或已登记")
            if current["status"] == "uploading":
                connection.execute("UPDATE pending_uploads SET status='ready',path=?,sha256=?,updated_at=? WHERE id=?",
                    (path.name, digest.hexdigest(), time.time(), upload_id))
                saved = True
        return {"id": upload_id, "status": "ready"}
    finally:
        if not saved:
            path.unlink(missing_ok=True)


@router.delete("/{upload_id}")
def cancel_upload(upload_id: str):
    from service import data
    user = data.current_user()
    if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", upload_id):
        raise HTTPException(422, "上传编号无效")
    with data.database() as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        # 取消标记拦截迟到的初始化和上传请求。
        connection.execute("INSERT OR IGNORE INTO pending_uploads(id,owner_id,status,updated_at) VALUES(?,?,'cancelled',?)",
                           (upload_id, user["id"], time.time()))
        row = require_upload(connection, upload_id, user)
        if row["status"] == "registered":
            return {"status": "registered"}
        remove_file(row)
        connection.execute("UPDATE pending_uploads SET status='cancelled',path='',updated_at=? WHERE id=?", (time.time(), upload_id))
    return {"status": "cancelled"}


@router.get("/{upload_id}")
def upload_status(upload_id: str):
    from service import data
    user = data.current_user()
    with data.database() as connection:
        row = require_upload(connection, upload_id, user)
        result = {"id": upload_id, "status": row["status"]}
        if row["status"] == "registered":
            result["document"] = data.public_processing_document(connection, row["document_id"], user)
    return result


def registered_document(connection, registration_id, user):
    from service import data
    row = connection.execute("SELECT * FROM upload_registrations WHERE id=?", (registration_id,)).fetchone()
    if not row:
        return None
    if row["owner_id"] != user["id"]:
        raise HTTPException(403, "无权操作此登记")
    return data.public_processing_document(connection, registration_id, user)


@router.get("/registrations/{registration_id}")
def registration_status(registration_id: str):
    from service import data
    user = data.current_user()
    with data.database() as connection:
        document = registered_document(connection, registration_id, user)
    return {"status": "registered" if document else "pending", "document": document}


def ready_uploads(connection, ids, user):
    rows = [require_upload(connection, upload_id, user) for upload_id in ids]
    for row in rows:
        if row["status"] != "ready":
            raise HTTPException(409, f'“{row["file_name"]}”尚未上传完成、已取消或已被登记')
        path = upload_root() / row["path"]
        try:
            complete = path.stat().st_size == row["size"]
        except FileNotFoundError:
            complete = False
        if not complete:
            raise HTTPException(409, f'“{row["file_name"]}”临时原件不存在或不完整，请重新上传')
    return rows


def merge_sources(rows, output):
    import pymupdf as fitz
    with fitz.open() as merged:
        for row in rows:
            try:
                with fitz.open(upload_root() / row["path"]) as source:
                    if source.needs_pass:
                        raise ValueError("PDF 已加密")
                    if source.page_count < 1:
                        raise ValueError("文件没有可读取的页面")
                    if source.is_pdf:
                        merged.insert_pdf(source)
                    else:
                        with fitz.open(stream=source.convert_to_pdf(), filetype="pdf") as image_pdf:
                            merged.insert_pdf(image_pdf)
            except (RuntimeError, ValueError, OSError) as exc:
                raise HTTPException(422, f'无法合并“{row["file_name"]}”：{exc}') from exc
        merged.save(output)


@router.post("/{registration_id}/register")
def register_upload(registration_id: str, payload: Registration):
    from service import data
    user = data.current_user()
    if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", registration_id):
        raise HTTPException(422, "登记编号无效")
    if len(set(payload.uploadIds)) != len(payload.uploadIds):
        raise HTTPException(422, "文件列表包含重复的上传编号")
    merged = None
    try:
        with data.database() as connection:
            document = registered_document(connection, registration_id, user)
            if document:
                return {"document": document}
            rows = ready_uploads(connection, payload.uploadIds, user)
        merged = upload_root() / f"merge-{secrets.token_hex(16)}.part" if len(rows) > 1 else None
        if merged:
            merge_sources(rows, merged)
            source = merged
            name = f'{Path(rows[0]["file_name"]).stem}_合并.pdf'
            mime_type = "application/pdf"
            digest = hashlib.sha256()
            with source.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            sha256, size = digest.hexdigest(), source.stat().st_size
        else:
            row = rows[0]
            source = upload_root() / row["path"]
            name, mime_type, sha256, size = row["file_name"], row["mime_type"], row["sha256"], row["size"]
        with data.database() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            document = registered_document(connection, registration_id, user)
            if document:
                return {"document": document}
            # 合并期间可能发生取消或另一次登记，必须在提交前重新核对。
            ready_uploads(connection, payload.uploadIds, user)
            if connection.execute("SELECT 1 FROM documents WHERE id=?", (registration_id,)).fetchone():
                raise HTTPException(409, "文献编号已被使用，请重新登记")
            stamp = data.now_iso()
            metadata = payload.model_dump(exclude={"uploadIds"})
            document = {**metadata, "id": registration_id, "pages": [], "visibility": "private",
                        "createdAt": stamp, "fileName": name, "fileType": mime_type,
                        "fileSize": size, "metadataStatus": "待自动识别"}
            relative = data.relative_storage_path(registration_id, "source", sha256, mime_type, name)
            target = data.FILE_STORAGE_DIR / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copyfile(source, target)
                data.upsert_documents(connection, [document], stamp, user)
                asset = {"storagePath": relative.as_posix(), "url": data.public_file_url(relative),
                         "sha256": sha256, "size": size, "mimeType": mime_type, "fileName": name}
                data.upsert_file_record(connection, document_id=registration_id, role="source", asset=asset, timestamp=stamp)
                data.enqueue_document(connection, registration_id, payload.processingMode, payload.processingChunkSize)
                for row in rows:
                    connection.execute("UPDATE pending_uploads SET status='registered',document_id=?,path='',updated_at=? WHERE id=?",
                                       (registration_id, time.time(), row["id"]))
                connection.execute("INSERT INTO upload_registrations VALUES(?,?,?)", (registration_id, user["id"], time.time()))
                data.bump_sync_version(connection)
                result = {"document": data.public_processing_document(connection, registration_id, user)}
            except Exception:
                target.unlink(missing_ok=True)
                raise
        for row in rows:
            remove_file(row)
        return result
    except HTTPException:
        # 并发的同一批次可能已登记并清理了临时文件，返回已提交结果。
        with data.database() as connection:
            document = registered_document(connection, registration_id, user)
        if document:
            return {"document": document}
        raise
    finally:
        if merged:
            merged.unlink(missing_ok=True)
