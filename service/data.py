from __future__ import annotations

import json
import base64
import binascii
import hashlib
import mimetypes
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


APP_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.getenv("DATA_DB_PATH", APP_DIR / "storage" / "app.db")).resolve()
STORAGE_DIR = Path(os.getenv("DATA_STORAGE_DIR", DB_PATH.parent)).resolve()
FILE_STORAGE_DIR = Path(os.getenv("DATA_FILE_STORAGE_DIR", STORAGE_DIR / "files")).resolve()
PUBLIC_BASE_URL = os.getenv("DATA_PUBLIC_BASE_URL", "/history/api/data").rstrip("/")
SCHEMA_VERSION = 2
DATA_URL_RE = re.compile(r"^data:(?P<mime>[-\w.+/]+)?;base64,(?P<data>.+)$", re.DOTALL)

FILE_STORAGE_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="近代军史数智平台数据服务")
app.mount("/files", StaticFiles(directory=str(FILE_STORAGE_DIR)), name="files")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SyncPayload(BaseModel):
    clientId: str = ""
    documents: list[dict[str, Any]] = Field(default_factory=list)
    conversations: list[dict[str, Any]] = Field(default_factory=list)
    deletedDocumentIds: list[str] = Field(default_factory=list)
    deletedConversationIds: list[str] = Field(default_factory=list)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    ensure_schema(connection)
    return connection


@contextmanager
def database():
    connection = connect()
    try:
        yield connection
    finally:
        connection.close()


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            version INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS document_pages (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            page_number INTEGER NOT NULL,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            version INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            version INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS document_files (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            page_id TEXT,
            role TEXT NOT NULL,
            original_name TEXT NOT NULL DEFAULT '',
            storage_path TEXT NOT NULL,
            public_url TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_documents_active_order
            ON documents(deleted_at, sort_order, updated_at);
        CREATE INDEX IF NOT EXISTS idx_document_pages_document_order
            ON document_pages(document_id, deleted_at, page_number);
        CREATE INDEX IF NOT EXISTS idx_conversations_active_order
            ON conversations(deleted_at, sort_order, updated_at);
        CREATE INDEX IF NOT EXISTS idx_document_files_document_role
            ON document_files(document_id, role, page_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_document_files_hash
            ON document_files(sha256);

        """
    )
    connection.execute(
        "INSERT OR IGNORE INTO app_meta(key, value) VALUES('sync_version', '0')"
    )
    connection.execute(
        "INSERT OR IGNORE INTO app_meta(key, value) VALUES('schema_version', ?)",
        (str(SCHEMA_VERSION),),
    )
    connection.execute(
        "UPDATE app_meta SET value = ? WHERE key = 'schema_version'",
        (str(SCHEMA_VERSION),),
    )
    connection.commit()


def get_sync_version(connection: sqlite3.Connection) -> int:
    row = connection.execute(
        "SELECT value FROM app_meta WHERE key = 'sync_version'"
    ).fetchone()
    return int(row["value"]) if row else 0


def bump_sync_version(connection: sqlite3.Connection) -> int:
    version = get_sync_version(connection) + 1
    connection.execute(
        "UPDATE app_meta SET value = ? WHERE key = 'sync_version'",
        (str(version),),
    )
    return version


def json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_load(value: str) -> Any:
    return json.loads(value)


def safe_part(value: str, fallback: str = "item") -> str:
    cleaned = re.sub(r"[^0-9A-Za-z._-]+", "-", value.strip())
    cleaned = cleaned.strip(".-")
    return cleaned[:80] or fallback


def extension_for_mime(mime_type: str, original_name: str = "") -> str:
    suffix = Path(original_name).suffix.lower()
    if suffix:
        return suffix

    if mime_type == "image/jpeg":
        return ".jpg"

    return mimetypes.guess_extension(mime_type) or ".bin"


def parse_data_url(value: str) -> tuple[str, bytes] | None:
    match = DATA_URL_RE.match(value or "")
    if not match:
        return None

    mime_type = match.group("mime") or "application/octet-stream"
    try:
        content = base64.b64decode(match.group("data"), validate=True)
    except (binascii.Error, ValueError):
        return None

    return mime_type, content


def relative_storage_path(
    document_id: str,
    role: str,
    digest: str,
    mime_type: str,
    original_name: str = "",
    page_id: str = "",
) -> Path:
    suffix = extension_for_mime(mime_type, original_name)
    role_part = safe_part(role, "asset")
    doc_part = safe_part(document_id, "document")
    if page_id:
        page_part = safe_part(page_id, "page")
        return Path(doc_part) / role_part / page_part / f"{digest[:16]}{suffix}"

    return Path(doc_part) / role_part / f"{digest[:16]}{suffix}"


def public_file_url(storage_path: str | Path) -> str:
    quoted = quote(Path(storage_path).as_posix(), safe="/")
    return f"{PUBLIC_BASE_URL}/files/{quoted}"


def write_asset_file(
    content: bytes,
    document_id: str,
    role: str,
    mime_type: str,
    original_name: str = "",
    page_id: str = "",
) -> dict[str, Any]:
    digest = hashlib.sha256(content).hexdigest()
    storage_path = relative_storage_path(
        document_id,
        role,
        digest,
        mime_type,
        original_name,
        page_id,
    )
    target = FILE_STORAGE_DIR / storage_path
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_bytes(content)

    return {
        "storagePath": storage_path.as_posix(),
        "url": public_file_url(storage_path),
        "sha256": digest,
        "size": len(content),
        "mimeType": mime_type,
        "fileName": original_name,
    }


def upsert_file_record(
    connection: sqlite3.Connection,
    *,
    document_id: str,
    role: str,
    asset: dict[str, Any],
    timestamp: str,
    page_id: str = "",
) -> dict[str, Any]:
    file_id = f"{document_id}:{page_id}:{role}"
    existing = connection.execute(
        "SELECT id, created_at FROM document_files WHERE id = ?",
        (file_id,),
    ).fetchone()
    created_at = existing["created_at"] if existing else timestamp
    public_url = public_file_url(asset["storagePath"])

    connection.execute(
        """
        INSERT INTO document_files(
            id, document_id, page_id, role, original_name, storage_path, public_url,
            sha256, size_bytes, mime_type, created_at, updated_at, deleted_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
            document_id = excluded.document_id,
            page_id = excluded.page_id,
            role = excluded.role,
            original_name = excluded.original_name,
            storage_path = excluded.storage_path,
            public_url = excluded.public_url,
            sha256 = excluded.sha256,
            size_bytes = excluded.size_bytes,
            mime_type = excluded.mime_type,
            updated_at = excluded.updated_at,
            deleted_at = NULL
        """,
        (
            file_id,
            document_id,
            page_id or None,
            role,
            asset.get("fileName") or "",
            asset["storagePath"],
            public_url,
            asset["sha256"],
            int(asset["size"]),
            asset["mimeType"],
            created_at,
            timestamp,
        ),
    )

    return {
        "id": file_id,
        "role": role,
        "pageId": page_id,
        "fileName": asset.get("fileName") or "",
        "path": asset["storagePath"],
        "url": public_url,
        "sha256": asset["sha256"],
        "size": int(asset["size"]),
        "mimeType": asset["mimeType"],
        "updatedAt": timestamp,
    }


def store_data_url_asset(
    connection: sqlite3.Connection,
    *,
    document_id: str,
    role: str,
    data_url: str,
    timestamp: str,
    original_name: str = "",
    page_id: str = "",
) -> dict[str, Any] | None:
    parsed = parse_data_url(data_url)
    if not parsed:
        return None

    mime_type, content = parsed
    asset = write_asset_file(content, document_id, role, mime_type, original_name, page_id)
    return upsert_file_record(
        connection,
        document_id=document_id,
        page_id=page_id,
        role=role,
        asset=asset,
        timestamp=timestamp,
    )


def public_asset(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "role": row["role"],
        "pageId": row["page_id"] or "",
        "fileName": row["original_name"] or "",
        "path": row["storage_path"],
        "url": public_file_url(row["storage_path"]),
        "sha256": row["sha256"],
        "size": row["size_bytes"],
        "mimeType": row["mime_type"],
        "updatedAt": row["updated_at"],
    }


def apply_asset_to_document(document: dict[str, Any], asset: dict[str, Any]) -> None:
    role = asset["role"]
    if role == "source":
        document["sourceFile"] = asset
        document["filePath"] = asset["path"]
        document["fileUrl"] = asset["url"]
        document["fileHash"] = asset["sha256"]
        document["fileMimeType"] = asset["mimeType"]
        document["fileSize"] = asset["size"]
        return

    if role == "cover":
        document["coverImageUrl"] = asset["url"]
        document["coverImageFile"] = asset
        if str(document.get("coverImageDataUrl") or "").startswith("data:"):
            document["coverImageDataUrl"] = ""
        return

    if role == "page-image":
        pages = document.get("pages") if isinstance(document.get("pages"), list) else []
        for page in pages:
            if str(page.get("id") or "") == asset["pageId"]:
                page["imageUrl"] = asset["url"]
                page["imageFile"] = asset
                page["imageHash"] = asset["sha256"]
                page["imageMimeType"] = asset["mimeType"]
                page["imageSize"] = asset["size"]
                if str(page.get("imageDataUrl") or "").startswith("data:"):
                    page["imageDataUrl"] = ""
                break


def materialize_document_assets(
    connection: sqlite3.Connection,
    document_id: str,
    document: dict[str, Any],
    timestamp: str,
) -> None:
    cover_data_url = str(document.get("coverImageDataUrl") or "")
    if cover_data_url.startswith("data:"):
        asset = store_data_url_asset(
            connection,
            document_id=document_id,
            role="cover",
            data_url=cover_data_url,
            original_name=f"{document.get('fileName') or document_id}-cover.jpg",
            timestamp=timestamp,
        )
        if asset:
            apply_asset_to_document(document, asset)

    pages = document.get("pages") if isinstance(document.get("pages"), list) else []
    for page in pages:
        page_id = str(page.get("id") or "").strip()
        image_data_url = str(page.get("imageDataUrl") or "")
        if not page_id or not image_data_url.startswith("data:"):
            continue

        asset = store_data_url_asset(
            connection,
            document_id=document_id,
            page_id=page_id,
            role="page-image",
            data_url=image_data_url,
            original_name=page.get("imageName") or f"page-{page.get('pageNumber') or ''}.png",
            timestamp=timestamp,
        )
        if asset:
            apply_asset_to_document(document, asset)


def rehydrate_document_assets(connection: sqlite3.Connection, document: dict[str, Any]) -> dict[str, Any]:
    document_id = str(document.get("id") or "").strip()
    if not document_id:
        return document

    rows = connection.execute(
        """
        SELECT *
        FROM document_files
        WHERE document_id = ? AND deleted_at IS NULL
        ORDER BY role ASC, page_id ASC
        """,
        (document_id,),
    ).fetchall()

    for row in rows:
        apply_asset_to_document(document, public_asset(row))

    return document


def active_payloads(connection: sqlite3.Connection, table: Literal["documents", "conversations"]) -> list[dict[str, Any]]:
    rows = connection.execute(
        f"""
        SELECT payload
        FROM {table}
        WHERE deleted_at IS NULL
        ORDER BY sort_order ASC, updated_at DESC
        """
    ).fetchall()
    payloads = [json_load(row["payload"]) for row in rows]
    if table == "documents":
        return [rehydrate_document_assets(connection, payload) for payload in payloads]
    return payloads



def upsert_documents(connection: sqlite3.Connection, documents: list[dict[str, Any]], timestamp: str) -> None:
    for sort_order, document in enumerate(documents):
        document_id = str(document.get("id") or "").strip()
        if not document_id:
            continue

        materialize_document_assets(connection, document_id, document, timestamp)
        payload = json_dump(document)
        existing = connection.execute(
            "SELECT version FROM documents WHERE id = ?",
            (document_id,),
        ).fetchone()

        if existing:
            connection.execute(
                """
                UPDATE documents
                SET payload = ?, sort_order = ?, updated_at = ?, deleted_at = NULL, version = version + 1
                WHERE id = ?
                """,
                (payload, sort_order, timestamp, document_id),
            )
        else:
            connection.execute(
                """
                INSERT INTO documents(id, payload, sort_order, updated_at, deleted_at, version)
                VALUES(?, ?, ?, ?, NULL, 1)
                """,
                (document_id, payload, sort_order, timestamp),
            )

        upsert_document_pages(connection, document_id, document.get("pages") or [], timestamp)


def upsert_document_pages(
    connection: sqlite3.Connection,
    document_id: str,
    pages: list[dict[str, Any]],
    timestamp: str,
) -> None:
    incoming_ids: set[str] = set()

    for page in pages:
        page_id = str(page.get("id") or "").strip()
        if not page_id:
            continue

        incoming_ids.add(page_id)
        page_number = int(page.get("pageNumber") or 0)
        payload = json_dump(page)
        existing = connection.execute(
            "SELECT version FROM document_pages WHERE id = ?",
            (page_id,),
        ).fetchone()

        if existing:
            connection.execute(
                """
                UPDATE document_pages
                SET document_id = ?, page_number = ?, payload = ?, updated_at = ?, deleted_at = NULL, version = version + 1
                WHERE id = ?
                """,
                (document_id, page_number, payload, timestamp, page_id),
            )
        else:
            connection.execute(
                """
                INSERT INTO document_pages(id, document_id, page_number, payload, updated_at, deleted_at, version)
                VALUES(?, ?, ?, ?, ?, NULL, 1)
                """,
                (page_id, document_id, page_number, payload, timestamp),
            )

    rows = connection.execute(
        "SELECT id FROM document_pages WHERE document_id = ? AND deleted_at IS NULL",
        (document_id,),
    ).fetchall()
    for row in rows:
        page_id = row["id"]
        if page_id not in incoming_ids:
            connection.execute(
                "UPDATE document_pages SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
                (timestamp, timestamp, page_id),
            )


def upsert_conversations(connection: sqlite3.Connection, conversations: list[dict[str, Any]], timestamp: str) -> None:
    for sort_order, conversation in enumerate(conversations):
        conversation_id = str(conversation.get("id") or "").strip()
        if not conversation_id:
            continue

        payload = json_dump(conversation)
        existing = connection.execute(
            "SELECT version FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()

        if existing:
            connection.execute(
                """
                UPDATE conversations
                SET payload = ?, sort_order = ?, updated_at = ?, deleted_at = NULL, version = version + 1
                WHERE id = ?
                """,
                (payload, sort_order, timestamp, conversation_id),
            )
        else:
            connection.execute(
                """
                INSERT INTO conversations(id, payload, sort_order, updated_at, deleted_at, version)
                VALUES(?, ?, ?, ?, NULL, 1)
                """,
                (conversation_id, payload, sort_order, timestamp),
            )

def soft_delete_entities(
    connection: sqlite3.Connection,
    table: Literal["documents", "conversations"],
    entity_ids: list[str],
    timestamp: str,
) -> None:
    for entity_id in {str(value).strip() for value in entity_ids if str(value).strip()}:
        connection.execute(
            f"UPDATE {table} SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
            (timestamp, timestamp, entity_id),
        )

        if table == "documents":
            connection.execute(
                "UPDATE document_pages SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE document_id = ? AND deleted_at IS NULL",
                (timestamp, timestamp, entity_id),
            )
            connection.execute(
                "UPDATE document_files SET deleted_at = ?, updated_at = ? WHERE document_id = ? AND deleted_at IS NULL",
                (timestamp, timestamp, entity_id),
            )


def build_snapshot(connection: sqlite3.Connection) -> dict[str, Any]:
    return {
        "documents": active_payloads(connection, "documents"),
        "conversations": active_payloads(connection, "conversations"),
        "syncCursor": str(get_sync_version(connection)),
    }


def get_schema_version(connection: sqlite3.Connection) -> int:
    row = connection.execute(
        "SELECT value FROM app_meta WHERE key = 'schema_version'"
    ).fetchone()
    return int(row["value"]) if row else SCHEMA_VERSION


def count_storage_files() -> int:
    if not FILE_STORAGE_DIR.exists():
        return 0
    return sum(1 for path in FILE_STORAGE_DIR.rglob("*") if path.is_file())


def storage_integrity_report(connection: sqlite3.Connection) -> dict[str, Any]:
    quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
    foreign_key_rows = connection.execute("PRAGMA foreign_key_check").fetchall()
    rows = connection.execute(
        "SELECT id, storage_path, sha256, size_bytes FROM document_files WHERE deleted_at IS NULL"
    ).fetchall()
    missing: list[str] = []
    mismatched: list[str] = []

    for row in rows:
        path = FILE_STORAGE_DIR / row["storage_path"]
        if not path.exists():
            missing.append(row["id"])
            continue
        if path.stat().st_size != row["size_bytes"]:
            mismatched.append(row["id"])
            continue

        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != row["sha256"]:
            mismatched.append(row["id"])

    return {
        "quickCheck": quick_check,
        "foreignKeyIssues": len(foreign_key_rows),
        "fileRecords": len(rows),
        "storedFiles": count_storage_files(),
        "missingFiles": missing,
        "mismatchedFiles": mismatched,
        "ok": quick_check == "ok" and not foreign_key_rows and not missing and not mismatched,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    with database() as connection:
        document_count = connection.execute(
            "SELECT COUNT(*) AS count FROM documents WHERE deleted_at IS NULL"
        ).fetchone()["count"]
        page_count = connection.execute(
            "SELECT COUNT(*) AS count FROM document_pages WHERE deleted_at IS NULL"
        ).fetchone()["count"]
        file_count = connection.execute(
            "SELECT COUNT(*) AS count FROM document_files WHERE deleted_at IS NULL"
        ).fetchone()["count"]
        schema_version = get_schema_version(connection)
    return {
        "status": "ok",
        "database": str(DB_PATH),
        "storage": str(STORAGE_DIR),
        "files": str(FILE_STORAGE_DIR),
        "schemaVersion": schema_version,
        "documents": document_count,
        "pages": page_count,
        "fileRecords": file_count,
    }


@app.get("/api/storage/check")
def check_storage() -> dict[str, Any]:
    with database() as connection:
        return storage_integrity_report(connection)


@app.post("/api/storage/vacuum")
def vacuum_storage() -> dict[str, Any]:
    try:
        with database() as connection:
            before = DB_PATH.stat().st_size if DB_PATH.exists() else 0
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            connection.execute("VACUUM")
            connection.execute("PRAGMA optimize")
            after = DB_PATH.stat().st_size if DB_PATH.exists() else 0
        return {"status": "ok", "database": str(DB_PATH), "beforeBytes": before, "afterBytes": after}
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"数据库压缩失败：{exc}") from exc


@app.post("/api/files/upload")
async def upload_file(
    document: UploadFile = File(...),
    documentId: str = Form(...),
    role: str = Form("source"),
    pageId: str = Form(""),
) -> dict[str, Any]:
    document_id = documentId.strip()
    if not document_id:
        raise HTTPException(status_code=400, detail="documentId 不能为空")

    normalized_role = safe_part(role, "source")
    content = await document.read()
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")

    mime_type = document.content_type or mimetypes.guess_type(document.filename or "")[0] or "application/octet-stream"
    timestamp = now_iso()
    asset = write_asset_file(
        content,
        document_id=document_id,
        page_id=pageId.strip(),
        role=normalized_role,
        mime_type=mime_type,
        original_name=document.filename or "",
    )

    try:
        with database() as connection:
            with connection:
                file_record = upsert_file_record(
                    connection,
                    document_id=document_id,
                    page_id=pageId.strip(),
                    role=normalized_role,
                    asset=asset,
                    timestamp=timestamp,
                )
                cursor = bump_sync_version(connection)
        return {"status": "ok", "file": file_record, "syncCursor": str(cursor)}
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"文件记录保存失败：{exc}") from exc


@app.get("/api/bootstrap")
def bootstrap() -> dict[str, Any]:
    with database() as connection:
        return build_snapshot(connection)


@app.get("/api/sync")
def sync(cursor: str = Query(default="")) -> dict[str, Any]:
    with database() as connection:
        current_cursor = str(get_sync_version(connection))
        if cursor and cursor == current_cursor:
            return {
                "changed": False,
                "syncCursor": current_cursor,
                "documents": [],
                "conversations": [],
            }

        snapshot = build_snapshot(connection)
        snapshot["changed"] = True
        return snapshot


@app.post("/api/sync/push")
def push(payload: SyncPayload) -> dict[str, Any]:
    timestamp = now_iso()
    try:
        with database() as connection:
            with connection:
                upsert_documents(connection, payload.documents, timestamp)
                upsert_conversations(connection, payload.conversations, timestamp)
                soft_delete_entities(
                    connection,
                    "documents",
                    payload.deletedDocumentIds,
                    timestamp,
                )
                soft_delete_entities(
                    connection,
                    "conversations",
                    payload.deletedConversationIds,
                    timestamp,
                )
                cursor = bump_sync_version(connection)
                snapshot = build_snapshot(connection)
        snapshot.update({"status": "ok", "syncCursor": str(cursor), "updatedAt": timestamp})
        return snapshot
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"数据库保存失败：{exc}") from exc
