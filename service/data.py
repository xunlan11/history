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

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from service.extract import FileExtractionError, extract_file_content


APP_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.getenv("DATA_DB_PATH", APP_DIR / "storage" / "app.db")).resolve()
STORAGE_DIR = Path(os.getenv("DATA_STORAGE_DIR", DB_PATH.parent)).resolve()
FILE_STORAGE_DIR = Path(os.getenv("DATA_FILE_STORAGE_DIR", STORAGE_DIR / "files")).resolve()
PUBLIC_BASE_URL = os.getenv("DATA_PUBLIC_BASE_URL", "/history/api/data").rstrip("/")
SCHEMA_VERSION = 5
SESSIONS: dict[str, dict[str, Any]] = {}
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


class ConversationFileTextPayload(BaseModel):
    extractedText: str = ""
    status: str = "ready"
    warnings: list[str] = Field(default_factory=list)

class Credentials(BaseModel):
    username: str
    password: str

class UserCreate(BaseModel):
    username: str
    password: str
    isAdmin: bool = False


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
    documents_exists = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'").fetchone()
    if documents_exists:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(documents)").fetchall()}
        if "owner_id" not in columns:
            connection.executescript("DROP TABLE IF EXISTS document_files; DROP TABLE IF EXISTS document_pages; DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS conversations; DROP TABLE IF EXISTS conversation_files; DROP TABLE IF EXISTS users;")
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
            version INTEGER NOT NULL DEFAULT 1,
            owner_id INTEGER,
            visibility TEXT NOT NULL DEFAULT 'private'
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
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

        CREATE TABLE IF NOT EXISTS conversation_files (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            original_name TEXT NOT NULL DEFAULT '',
            storage_path TEXT NOT NULL,
            public_url TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
            kind TEXT NOT NULL DEFAULT 'document',
            extracted_text TEXT NOT NULL DEFAULT '',
            extraction_status TEXT NOT NULL DEFAULT 'ready',
            warnings TEXT NOT NULL DEFAULT '[]',
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
        CREATE INDEX IF NOT EXISTS idx_conversation_files_conversation
            ON conversation_files(conversation_id, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_conversation_files_hash
            ON conversation_files(sha256);

        """
    )
    connection.execute(
        "INSERT OR IGNORE INTO app_meta(key, value) VALUES('sync_version', '0')"
    )
    admin_hash = hashlib.sha256("1wdvBHU*".encode()).hexdigest()
    connection.execute("INSERT OR IGNORE INTO users(username,password_hash,is_admin,created_at) VALUES('xunlan',?,?,?)", (admin_hash, 1, now_iso()))
    schema_row = connection.execute(
        "SELECT value FROM app_meta WHERE key = 'schema_version'"
    ).fetchone()
    if schema_row is None:
        connection.execute(
            "INSERT INTO app_meta(key, value) VALUES('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
    elif int(schema_row["value"]) != SCHEMA_VERSION:
        connection.execute("UPDATE app_meta SET value = ? WHERE key = 'schema_version'", (str(SCHEMA_VERSION),))

    connection.commit()

def current_user(authorization: str | None) -> dict[str, Any]:
    token = (authorization or "").removeprefix("Bearer ").strip()
    user = SESSIONS.get(token)
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    return user

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


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


def upsert_conversation_file_record(
    connection: sqlite3.Connection,
    *,
    attachment_id: str,
    conversation_id: str,
    asset: dict[str, Any],
    extraction: dict[str, Any],
    timestamp: str,
) -> dict[str, Any]:
    existing = connection.execute(
        "SELECT created_at FROM conversation_files WHERE id = ?",
        (attachment_id,),
    ).fetchone()
    created_at = existing["created_at"] if existing else timestamp
    extraction_status = "processing" if extraction.get("needsOcr") else (
        "ready" if str(extraction.get("text") or "").strip() else "failed"
    )
    warnings = [str(value) for value in extraction.get("warnings") or [] if str(value)]
    public_url = public_file_url(asset["storagePath"])

    connection.execute(
        """
        INSERT INTO conversation_files(
            id, conversation_id, original_name, storage_path, public_url, sha256,
            size_bytes, mime_type, kind, extracted_text, extraction_status, warnings,
            created_at, updated_at, deleted_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            original_name = excluded.original_name,
            storage_path = excluded.storage_path,
            public_url = excluded.public_url,
            sha256 = excluded.sha256,
            size_bytes = excluded.size_bytes,
            mime_type = excluded.mime_type,
            kind = excluded.kind,
            extracted_text = excluded.extracted_text,
            extraction_status = excluded.extraction_status,
            warnings = excluded.warnings,
            updated_at = excluded.updated_at,
            deleted_at = NULL
        """,
        (
            attachment_id,
            conversation_id,
            asset.get("fileName") or "",
            asset["storagePath"],
            public_url,
            asset["sha256"],
            int(asset["size"]),
            asset["mimeType"],
            extraction.get("kind") or "document",
            str(extraction.get("text") or "")[:60_000],
            extraction_status,
            json_dump(warnings),
            created_at,
            timestamp,
        ),
    )
    row = connection.execute(
        "SELECT * FROM conversation_files WHERE id = ?",
        (attachment_id,),
    ).fetchone()
    return public_conversation_file(row)


def public_conversation_file(row: sqlite3.Row) -> dict[str, Any]:
    try:
        warnings = json_load(row["warnings"] or "[]")
    except (json.JSONDecodeError, TypeError):
        warnings = []
    return {
        "id": row["id"],
        "conversationId": row["conversation_id"],
        "fileName": row["original_name"] or "",
        "fileUrl": public_file_url(row["storage_path"]),
        "filePath": row["storage_path"],
        "fileHash": row["sha256"],
        "fileSize": row["size_bytes"],
        "fileType": row["mime_type"],
        "kind": row["kind"],
        "extractedText": row["extracted_text"],
        "status": row["extraction_status"],
        "warnings": warnings if isinstance(warnings, list) else [],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def rehydrate_conversation_files(connection: sqlite3.Connection, conversation: dict[str, Any]) -> dict[str, Any]:
    conversation_id = str(conversation.get("id") or "").strip()
    attachments = conversation.get("attachments") if isinstance(conversation.get("attachments"), list) else []
    if not conversation_id or not attachments:
        return conversation

    rows = connection.execute(
        """
        SELECT * FROM conversation_files
        WHERE conversation_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC
        """,
        (conversation_id,),
    ).fetchall()
    records = {row["id"]: public_conversation_file(row) for row in rows}
    conversation["attachments"] = [
        {**attachment, **records.get(str(attachment.get("id") or ""), {})}
        for attachment in attachments
        if isinstance(attachment, dict)
    ]
    return conversation


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


def active_payloads(connection: sqlite3.Connection, table: Literal["documents", "conversations"], user: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    where = "deleted_at IS NULL"
    params: tuple[Any, ...] = ()
    if table == "documents" and user:
        where += " AND (visibility = 'public' OR owner_id = ?)"
        params = (user["id"],)
    rows = connection.execute(
        f"""
        SELECT payload
        FROM {table}
        WHERE {where}
        ORDER BY sort_order ASC, updated_at DESC
        """, params).fetchall()
    payloads = [json_load(row["payload"]) for row in rows]
    if table == "documents":
        return [rehydrate_document_assets(connection, payload) for payload in payloads]
    return [rehydrate_conversation_files(connection, payload) for payload in payloads]



def upsert_documents(connection: sqlite3.Connection, documents: list[dict[str, Any]], timestamp: str, user: dict[str, Any]) -> None:
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

        visibility = "public" if document.get("visibility") == "public" else "private"
        if existing:
            connection.execute(
                """
                UPDATE documents
                SET payload = ?, sort_order = ?, updated_at = ?, deleted_at = NULL, version = version + 1, visibility = ?, owner_id = ?
                WHERE id = ? AND owner_id = ?
                """,
                (payload, sort_order, timestamp, visibility, user["id"], document_id, user["id"]),
            )
        else:
            connection.execute(
                """
                INSERT INTO documents(id, payload, sort_order, updated_at, deleted_at, version, owner_id, visibility)
                VALUES(?, ?, ?, ?, NULL, 1, ?, ?)
                """,
                (document_id, payload, sort_order, timestamp, user["id"], visibility),
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

        attachments = conversation.get("attachments") if isinstance(conversation.get("attachments"), list) else []
        active_attachment_ids: set[str] = set()
        for attachment in attachments:
            if not isinstance(attachment, dict):
                continue
            attachment_id = str(attachment.get("id") or "").strip()
            if not attachment_id:
                continue
            active_attachment_ids.add(attachment_id)
            connection.execute(
                """
                UPDATE conversation_files
                SET extracted_text = ?, extraction_status = ?, warnings = ?, updated_at = ?, deleted_at = NULL
                WHERE id = ? AND conversation_id = ?
                """,
                (
                    str(attachment.get("extractedText") or "")[:60_000],
                    str(attachment.get("status") or "ready"),
                    json_dump([str(value) for value in attachment.get("warnings") or [] if str(value)]),
                    timestamp,
                    attachment_id,
                    conversation_id,
                ),
            )

        file_rows = connection.execute(
            "SELECT id FROM conversation_files WHERE conversation_id = ? AND deleted_at IS NULL",
            (conversation_id,),
        ).fetchall()
        for row in file_rows:
            if row["id"] not in active_attachment_ids:
                connection.execute(
                    "UPDATE conversation_files SET deleted_at = ?, updated_at = ? WHERE id = ?",
                    (timestamp, timestamp, row["id"]),
                )

def soft_delete_entities(
    connection: sqlite3.Connection,
    table: Literal["documents", "conversations"],
    entity_ids: list[str],
    timestamp: str,
    user: dict[str, Any] | None = None,
) -> None:
    for entity_id in {str(value).strip() for value in entity_ids if str(value).strip()}:
        owner_clause = " AND owner_id = ?" if table == "documents" and user else ""
        params: tuple[Any, ...] = (timestamp, timestamp, entity_id) + ((user["id"],) if owner_clause else ())
        connection.execute(f"UPDATE {table} SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?{owner_clause}", params)

        if table == "documents":
            connection.execute(
                "UPDATE document_pages SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE document_id = ? AND deleted_at IS NULL",
                (timestamp, timestamp, entity_id),
            )
            connection.execute(
                "UPDATE document_files SET deleted_at = ?, updated_at = ? WHERE document_id = ? AND deleted_at IS NULL",
                (timestamp, timestamp, entity_id),
            )
        else:
            connection.execute(
                "UPDATE conversation_files SET deleted_at = ?, updated_at = ? WHERE conversation_id = ? AND deleted_at IS NULL",
                (timestamp, timestamp, entity_id),
            )


def build_snapshot(connection: sqlite3.Connection, user: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "documents": active_payloads(connection, "documents", user),
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
    document_rows = connection.execute(
        "SELECT id, storage_path, sha256, size_bytes FROM document_files WHERE deleted_at IS NULL"
    ).fetchall()
    conversation_rows = connection.execute(
        "SELECT id, storage_path, sha256, size_bytes FROM conversation_files WHERE deleted_at IS NULL"
    ).fetchall()
    rows = list(document_rows) + list(conversation_rows)
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
        conversation_file_count = connection.execute(
            "SELECT COUNT(*) AS count FROM conversation_files WHERE deleted_at IS NULL"
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
        "documentFiles": file_count,
        "conversationFiles": conversation_file_count,
        "fileRecords": file_count + conversation_file_count,
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


@app.post("/api/conversation-files/upload")
async def upload_conversation_file(
    attachment: UploadFile = File(...),
    conversationId: str = Form(...),
    attachmentId: str = Form(...),
) -> dict[str, Any]:
    conversation_id = conversationId.strip()
    attachment_id = attachmentId.strip()
    if not conversation_id or not attachment_id:
        raise HTTPException(status_code=400, detail="conversationId 和 attachmentId 不能为空")

    content = await attachment.read()
    mime_type = attachment.content_type or mimetypes.guess_type(attachment.filename or "")[0] or "application/octet-stream"
    try:
        extraction = extract_file_content(content, attachment.filename or "", mime_type)
    except FileExtractionError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc

    timestamp = now_iso()
    asset = write_asset_file(
        content,
        document_id=f"conversation-{conversation_id}",
        page_id=attachment_id,
        role="attachment",
        mime_type=mime_type,
        original_name=attachment.filename or "",
    )

    try:
        with database() as connection:
            with connection:
                file_record = upsert_conversation_file_record(
                    connection,
                    attachment_id=attachment_id,
                    conversation_id=conversation_id,
                    asset=asset,
                    extraction=extraction,
                    timestamp=timestamp,
                )
                cursor = bump_sync_version(connection)
        return {
            "status": "ok",
            "attachment": file_record,
            "needsOcr": bool(extraction.get("needsOcr")),
            "syncCursor": str(cursor),
        }
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"对话附件保存失败：{exc}") from exc


@app.put("/api/conversation-files/{attachment_id}/text")
def update_conversation_file_text(
    attachment_id: str,
    payload: ConversationFileTextPayload,
) -> dict[str, Any]:
    timestamp = now_iso()
    with database() as connection:
        with connection:
            existing = connection.execute(
                "SELECT id FROM conversation_files WHERE id = ? AND deleted_at IS NULL",
                (attachment_id,),
            ).fetchone()
            if not existing:
                raise HTTPException(status_code=404, detail="对话附件不存在")
            connection.execute(
                """
                UPDATE conversation_files
                SET extracted_text = ?, extraction_status = ?, warnings = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.extractedText[:60_000],
                    payload.status,
                    json_dump([str(value) for value in payload.warnings if str(value)]),
                    timestamp,
                    attachment_id,
                ),
            )
            row = connection.execute(
                "SELECT * FROM conversation_files WHERE id = ?",
                (attachment_id,),
            ).fetchone()
            cursor = bump_sync_version(connection)
    return {"status": "ok", "attachment": public_conversation_file(row), "syncCursor": str(cursor)}


@app.delete("/api/conversation-files/{attachment_id}")
def delete_conversation_file(attachment_id: str) -> dict[str, Any]:
    timestamp = now_iso()
    with database() as connection:
        with connection:
            connection.execute(
                "UPDATE conversation_files SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                (timestamp, timestamp, attachment_id),
            )
            cursor = bump_sync_version(connection)
    return {"status": "ok", "attachmentId": attachment_id, "syncCursor": str(cursor)}


@app.post("/api/auth/register")
def register(credentials: Credentials) -> dict[str, Any]:
    username = credentials.username.strip()
    if len(username) < 2 or len(credentials.password) < 1:
        raise HTTPException(status_code=400, detail="账号和密码不能为空")
    with database() as connection:
        try:
            with connection:
                cursor = connection.execute("INSERT INTO users(username,password_hash,is_admin,created_at) VALUES(?,?,0,?)", (username, hash_password(credentials.password), now_iso()))
                user = {"id": cursor.lastrowid, "username": username, "isAdmin": False}
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="账号已存在") from exc
    token = os.urandom(24).hex(); SESSIONS[token] = user
    return {"token": token, "user": user}

@app.post("/api/auth/login")
def login(credentials: Credentials) -> dict[str, Any]:
    with database() as connection:
        row = connection.execute("SELECT id,username,is_admin FROM users WHERE username=? AND password_hash=?", (credentials.username.strip(), hash_password(credentials.password))).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="账号或密码错误")
    user = {"id": row["id"], "username": row["username"], "isAdmin": bool(row["is_admin"])}
    token = os.urandom(24).hex(); SESSIONS[token] = user
    return {"token": token, "user": user}

@app.get("/api/auth/me")
def me(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return {"user": current_user(authorization)}

@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict[str, str]:
    token = (authorization or "").removeprefix("Bearer ").strip(); SESSIONS.pop(token, None)
    return {"status": "ok"}

@app.get("/api/admin/users")
def list_users(authorization: str | None = Header(default=None)) -> list[dict[str, Any]]:
    user = current_user(authorization)
    if not user["isAdmin"]: raise HTTPException(status_code=403, detail="需要管理员权限")
    with database() as connection:
        return [{"id": r["id"], "username": r["username"], "isAdmin": bool(r["is_admin"]), "createdAt": r["created_at"]} for r in connection.execute("SELECT id,username,is_admin,created_at FROM users ORDER BY id").fetchall()]

@app.post("/api/admin/users")
def create_user(payload: UserCreate, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    admin = current_user(authorization)
    if not admin["isAdmin"]: raise HTTPException(status_code=403, detail="需要管理员权限")
    try:
        with database() as connection:
            with connection:
                cursor = connection.execute("INSERT INTO users(username,password_hash,is_admin,created_at) VALUES(?,?,?,?)", (payload.username.strip(), hash_password(payload.password), int(payload.isAdmin), now_iso()))
                return {"id": cursor.lastrowid, "username": payload.username.strip(), "isAdmin": payload.isAdmin}
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="账号已存在") from exc

@app.delete("/api/admin/users/{user_id}")
def delete_user(user_id: int, authorization: str | None = Header(default=None)) -> dict[str, str]:
    user = current_user(authorization)
    if not user["isAdmin"]: raise HTTPException(status_code=403, detail="需要管理员权限")
    if user_id == user["id"]: raise HTTPException(status_code=400, detail="不能删除当前管理员")
    with database() as connection:
        with connection: connection.execute("DELETE FROM users WHERE id=?", (user_id,))
    return {"status": "ok"}

@app.get("/api/bootstrap")
def bootstrap(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user = current_user(authorization)
    with database() as connection:
        return build_snapshot(connection, user)


@app.get("/api/sync")
def sync(cursor: str = Query(default=""), authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user = current_user(authorization)
    with database() as connection:
        current_cursor = str(get_sync_version(connection))
        if cursor and cursor == current_cursor:
            return {
                "changed": False,
                "syncCursor": current_cursor,
                "documents": [],
                "conversations": [],
            }

        snapshot = build_snapshot(connection, user)
        snapshot["changed"] = True
        return snapshot


@app.post("/api/sync/push")
def push(payload: SyncPayload, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user = current_user(authorization)
    timestamp = now_iso()
    try:
        with database() as connection:
            with connection:
                upsert_documents(connection, payload.documents, timestamp, user)
                upsert_conversations(connection, payload.conversations, timestamp)
                soft_delete_entities(
                    connection,
                    "documents",
                    payload.deletedDocumentIds,
                    timestamp,
                    user,
                )
                soft_delete_entities(
                    connection,
                    "conversations",
                    payload.deletedConversationIds,
                    timestamp,
                )
                cursor = bump_sync_version(connection)
                snapshot = build_snapshot(connection, user)
        snapshot.update({"status": "ok", "syncCursor": str(cursor), "updatedAt": timestamp})
        return snapshot
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"数据库保存失败：{exc}") from exc
