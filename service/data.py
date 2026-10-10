from __future__ import annotations

import json
import base64
import binascii
import hashlib
import mimetypes
import os
import re
import secrets
import sqlite3
import shutil
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
from service import scheduler as processing_scheduler


APP_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.getenv("DATA_DB_PATH", APP_DIR / "storage" / "app.db")).resolve()
STORAGE_DIR = Path(os.getenv("DATA_STORAGE_DIR", DB_PATH.parent)).resolve()
FILE_STORAGE_DIR = Path(os.getenv("DATA_FILE_STORAGE_DIR", STORAGE_DIR / "files")).resolve()
PUBLIC_BASE_URL = os.getenv("DATA_PUBLIC_BASE_URL", "/history/api/data").rstrip("/")
SCHEMA_VERSION = 7
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
    schemaVersion: int
    clientId: str = ""
    documents: list[dict[str, Any]] = Field(default_factory=list)
    conversations: list[dict[str, Any]] = Field(default_factory=list)
    deletedDocumentIds: list[str] = Field(default_factory=list)
    deletedConversationIds: list[str] = Field(default_factory=list)


class ConversationFileTextPayload(BaseModel):
    extractedText: str = ""
    status: str = "ready"
    warnings: list[str] = Field(default_factory=list)


class ConversationSharePayload(BaseModel):
    conversationId: str
    turnIds: list[str] = Field(default_factory=list)

class Credentials(BaseModel):
    username: str
    password: str

class UserCreate(BaseModel):
    username: str
    password: str
    isAdmin: bool = False

class UserAdminUpdate(BaseModel):
    isAdmin: bool = False


class PageAnnotationUpdate(BaseModel):
    content: str = Field(default="", max_length=100_000)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def next_available_user_id(connection: sqlite3.Connection) -> int:
    """返回当前未分配的最小正整数用户 ID。"""
    rows = connection.execute("SELECT id FROM users ORDER BY id").fetchall()
    candidate = 1
    for row in rows:
        user_id = int(row["id"])
        if user_id < candidate:
            continue
        if user_id > candidate:
            break
        candidate += 1
    return candidate


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=30)
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
            connection.executescript("DROP TABLE IF EXISTS page_annotations; DROP TABLE IF EXISTS document_files; DROP TABLE IF EXISTS document_pages; DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS conversations; DROP TABLE IF EXISTS conversation_files; DROP TABLE IF EXISTS users;")
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

        CREATE TABLE IF NOT EXISTS page_annotations (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            page_id TEXT NOT NULL REFERENCES document_pages(id) ON DELETE CASCADE,
            content TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, page_id)
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

        CREATE TABLE IF NOT EXISTS conversation_shares (
            id TEXT PRIMARY KEY,
            token TEXT NOT NULL UNIQUE,
            conversation_id TEXT NOT NULL,
            selected_turn_ids TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '[]',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_documents_active_order
            ON documents(deleted_at, sort_order, updated_at);
        CREATE INDEX IF NOT EXISTS idx_document_pages_document_order
            ON document_pages(document_id, deleted_at, page_number);
        CREATE INDEX IF NOT EXISTS idx_page_annotations_document_page
            ON page_annotations(document_id, page_id, user_id);
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
        CREATE INDEX IF NOT EXISTS idx_conversation_shares_conversation
            ON conversation_shares(conversation_id, active, updated_at);

        """
    )
    share_columns = {row[1] for row in connection.execute("PRAGMA table_info(conversation_shares)").fetchall()}
    if "content" not in share_columns:
        connection.execute("ALTER TABLE conversation_shares ADD COLUMN content TEXT NOT NULL DEFAULT '[]'")

    processing_scheduler.ensure_schema(connection)
    connection.execute(
        "INSERT OR IGNORE INTO app_meta(key, value) VALUES('sync_version', '0')"
    )
    # 新数据库只初始化一名管理员。凭据属于部署配置，不能使用代码仓库中的默认值。
    if connection.execute("SELECT 1 FROM users LIMIT 1").fetchone() is None:
        admin_username = os.getenv("INITIAL_ADMIN_USERNAME", "").strip()
        admin_password = os.getenv("INITIAL_ADMIN_PASSWORD", "")
        generated = False
        if not admin_username:
            admin_username = f"admin-{secrets.token_hex(3)}"
            generated = True
        if not admin_password:
            admin_password = secrets.token_urlsafe(16)
            generated = True
        connection.execute(
            "INSERT INTO users(username,password_hash,is_admin,created_at) VALUES(?,?,1,?)",
            (admin_username, hash_password(admin_password), now_iso()),
        )
        if generated:
            print(
                f"Initial administrator created: username={admin_username} "
                f"password={admin_password}",
                flush=True,
            )
    connection.commit()
    connection.execute("BEGIN IMMEDIATE")
    schema_row = connection.execute(
        "SELECT value FROM app_meta WHERE key = 'schema_version'"
    ).fetchone()
    conversation_columns = {row[1] for row in connection.execute("PRAGMA table_info(conversations)")}
    if "owner_id" not in conversation_columns or (schema_row and int(schema_row["value"]) < 7):
        connection.execute("DELETE FROM conversation_shares")
        connection.execute("DELETE FROM conversation_files")
        for conversation_asset_dir in FILE_STORAGE_DIR.glob("conversation-*"):
            if conversation_asset_dir.is_dir():
                shutil.rmtree(conversation_asset_dir)
        connection.execute("DROP TABLE conversations")
        connection.execute(
            "CREATE TABLE conversations ("
            "id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
            "payload TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, "
            "deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1)"
        )
        bump_sync_version(connection)
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_owner_order "
        "ON conversations(owner_id, deleted_at, sort_order, updated_at)"
    )
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


def purge_sessions_for(user_id: int) -> None:
    """注销某用户当前持有的全部登录会话，权限/删除变更后立即生效。"""
    for token in [t for t, u in SESSIONS.items() if u.get("id") == user_id]:
        SESSIONS.pop(token, None)


def create_session(user: dict[str, Any]) -> str:
    token = os.urandom(24).hex()
    SESSIONS[token] = user
    return token


def require_admin(user: dict[str, Any]) -> None:
    if not user["isAdmin"]:
        raise HTTPException(status_code=403, detail="需要管理员权限")


def ensure_admin_remains(connection: sqlite3.Connection) -> None:
    admin_count = connection.execute("SELECT COUNT(*) AS n FROM users WHERE is_admin=1").fetchone()["n"]
    if admin_count <= 1:
        raise HTTPException(status_code=400, detail="至少需要保留一名管理员")


def insert_user(connection: sqlite3.Connection, username: str, password: str, is_admin: bool) -> dict[str, Any]:
    connection.execute("BEGIN IMMEDIATE")
    user_id = next_available_user_id(connection)
    with connection:
        connection.execute(
            "INSERT INTO users(id,username,password_hash,is_admin,created_at) VALUES(?,?,?,?,?)",
            (user_id, username, hash_password(password), int(is_admin), now_iso()),
        )
    return {"id": user_id, "username": username, "isAdmin": bool(is_admin)}


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
    if table == "conversations":
        if not user:
            return []
        where += " AND owner_id = ?"
        params = (user["id"],)
    columns = "payload, owner_id"
    rows = connection.execute(
        f"""
        SELECT {columns}
        FROM {table}
        WHERE {where}
        ORDER BY sort_order ASC, updated_at DESC
        """, params).fetchall()
    payloads = [json_load(row["payload"]) for row in rows]
    if table == "documents":
        result = []
        for row, payload in zip(rows, payloads):
            owner = connection.execute(
                "SELECT username FROM users WHERE id = ?",
                (row["owner_id"],),
            ).fetchone()
            payload.pop("creator", None)
            payload.pop("ownerId", None)
            payload.pop("canEdit", None)
            is_owner = bool(user and row["owner_id"] == user.get("id"))
            payload["ownerId"] = row["owner_id"] if is_owner else None
            payload["canEdit"] = is_owner
            if owner:
                payload["creator"] = {"username": owner["username"]}
            result.append(rehydrate_document_assets(connection, payload))
        return result
    result = []
    for row, payload in zip(rows, payloads):
        payload["ownerId"] = row["owner_id"]
        payload = rehydrate_conversation_files(connection, payload)
        share = connection.execute(
            "SELECT token, selected_turn_ids, active, updated_at FROM conversation_shares "
            "WHERE conversation_id = ? AND active = 1 AND deleted_at IS NULL",
            (str(payload.get("id") or ""),),
        ).fetchone()
        if share:
            payload["share"] = {
                "token": share["token"],
                "selectedTurnIds": json_load(share["selected_turn_ids"]),
                "active": True,
                "updatedAt": share["updated_at"],
            }
        else:
            payload["share"] = None
        result.append(payload)
    return result


def upsert_documents(connection: sqlite3.Connection, documents: list[dict[str, Any]], timestamp: str, user: dict[str, Any]) -> None:
    for sort_order, document in enumerate(documents):
        document_id = str(document.get("id") or "").strip()
        if not document_id:
            continue

        existing = connection.execute(
            "SELECT version, owner_id FROM documents WHERE id = ?",
            (document_id,),
        ).fetchone()
        if existing and existing["owner_id"] != user["id"]:
            continue

        stored_document = processing_scheduler.preserve_server_fields(connection, dict(document))
        stored_document.pop("creator", None)
        stored_document.pop("ownerId", None)
        stored_document.pop("canEdit", None)
        materialize_document_assets(connection, document_id, stored_document, timestamp)
        payload = json_dump(stored_document)

        visibility = "public" if stored_document.get("visibility") == "public" else "private"
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

        upsert_document_pages(connection, document_id, stored_document.get("pages") or [], timestamp)


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
            "SELECT version, document_id FROM document_pages WHERE id = ?",
            (page_id,),
        ).fetchone()
        if existing and existing["document_id"] != document_id:
            continue

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


def upsert_conversations(connection: sqlite3.Connection, conversations: list[dict[str, Any]], timestamp: str, user: dict[str, Any]) -> None:
    for sort_order, conversation in enumerate(conversations):
        conversation_id = str(conversation.get("id") or "").strip()
        if not conversation_id:
            continue

        existing = connection.execute(
            "SELECT version, owner_id FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()
        if existing and existing["owner_id"] != user["id"]:
            continue
        stored = dict(conversation)
        stored.pop("ownerId", None)
        stored.pop("share", None)
        payload = json_dump(stored)

        if existing:
            connection.execute(
                """
                UPDATE conversations
                SET payload = ?, sort_order = ?, updated_at = ?, deleted_at = NULL, version = version + 1
                WHERE id = ? AND owner_id = ?
                """,
                (payload, sort_order, timestamp, conversation_id, user["id"]),
            )
        else:
            connection.execute(
                """
                INSERT INTO conversations(id, owner_id, payload, sort_order, updated_at, deleted_at, version)
                VALUES(?, ?, ?, ?, ?, NULL, 1)
                """,
                (conversation_id, user["id"], payload, sort_order, timestamp),
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
        if table == "conversations" and not user:
            raise HTTPException(status_code=401, detail="authentication required")
        owner_clause = " AND owner_id = ?" if user else ""
        params: tuple[Any, ...] = (timestamp, timestamp, entity_id) + ((user["id"],) if owner_clause else ())
        cursor = connection.execute(f"UPDATE {table} SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?{owner_clause}", params)

        if user and cursor.rowcount == 0:
            continue

        if table == "documents":
            connection.execute("UPDATE processing_jobs SET status='cancelled',updated_at=? WHERE document_id=?", (timestamp, entity_id))
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
        "conversations": active_payloads(connection, "conversations", user),
        "syncCursor": str(get_sync_version(connection)),
    }


def conversation_share_turns(conversation: dict[str, Any], selected_ids: list[str]) -> list[dict[str, Any]]:
    selected = {str(value).strip() for value in selected_ids if str(value).strip()}
    turns = conversation.get("turns") if isinstance(conversation.get("turns"), list) else []
    result = []
    for turn in turns:
        if not isinstance(turn, dict) or str(turn.get("id") or "") not in selected:
            continue
        if turn.get("status") != "completed" or not isinstance(turn.get("result"), dict):
            continue
        result_payload = turn["result"].get("payload") if isinstance(turn["result"].get("payload"), dict) else {}
        mode = str(turn.get("mode") or turn["result"].get("mode") or "chat")
        if mode == "chat":
            content = {"type": "text", "text": str(result_payload.get("answer") or "")}
        elif mode == "search":
            content = {
                "type": "search",
                "items": [
                    {
                        "title": str(item.get("title") or "匹配结果"),
                        "meta": " · ".join(str(value) for value in [item.get("author"), item.get("year")] if value),
                        "text": str(item.get("quote") or item.get("snippet") or item.get("summary") or ""),
                    }
                    for item in result_payload.get("matches", [])
                    if isinstance(item, dict)
                ],
            }
        else:
            content = {
                "type": "chronicle",
                "items": [
                    {
                        "title": str(item.get("date") or item.get("year") or "史事"),
                        "text": str(item.get("summary") or item.get("event") or ""),
                    }
                    for item in result_payload.get("entries", [])
                    if isinstance(item, dict)
                ],
            }
        result.append({
            "id": str(turn["id"]),
            "mode": mode,
            "prompt": str(turn.get("prompt") or ""),
            "content": content,
        })
    return result


def conversation_share_metadata(connection: sqlite3.Connection, conversation_id: str) -> dict[str, Any] | None:
    row = connection.execute(
        "SELECT token, selected_turn_ids, active, updated_at FROM conversation_shares "
        "WHERE conversation_id = ? AND active = 1 AND deleted_at IS NULL",
        (conversation_id,),
    ).fetchone()
    if not row:
        return None
    return {
        "token": row["token"],
        "selectedTurnIds": json_load(row["selected_turn_ids"]),
        "active": True,
        "updatedAt": row["updated_at"],
    }


def require_owned_conversation(connection: sqlite3.Connection, conversation_id: str, user: dict[str, Any]) -> dict[str, Any]:
    row = connection.execute(
        "SELECT payload, owner_id FROM conversations WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
        (conversation_id, user["id"]),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="conversation not found")
    return {**json_load(row["payload"]), "ownerId": row["owner_id"]}


def require_owned_conversation_file(connection: sqlite3.Connection, attachment_id: str, user: dict[str, Any]) -> sqlite3.Row:
    row = connection.execute(
        "SELECT f.* FROM conversation_files AS f JOIN conversations AS c ON c.id = f.conversation_id "
        "WHERE f.id = ? AND f.deleted_at IS NULL AND c.deleted_at IS NULL AND c.owner_id = ?",
        (attachment_id, user["id"]),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="conversation attachment not found")
    return row


def get_conversation_for_share(connection: sqlite3.Connection, conversation_id: str) -> dict[str, Any]:
    row = connection.execute(
        "SELECT payload FROM conversations WHERE id = ? AND deleted_at IS NULL",
        (conversation_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="?????")
    return json_load(row["payload"])


def validate_share_selection(conversation: dict[str, Any], turn_ids: list[str]) -> list[str]:
    requested = {str(value).strip() for value in turn_ids if str(value).strip()}
    turns = conversation.get("turns") if isinstance(conversation.get("turns"), list) else []
    valid = [
        str(turn.get("id"))
        for turn in turns
        if isinstance(turn, dict) and str(turn.get("id") or "") in requested
        and turn.get("status") == "completed" and isinstance(turn.get("result"), dict)
    ]
    if not valid:
        raise HTTPException(status_code=400, detail="至少选择一轮已完成的对话")
    return valid

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


class ProcessingSubmission(BaseModel):
    mode: Literal["serial", "parallel"] = "serial"


def enqueue_document(connection, document_id: str, mode: str | None = None):
    existing = connection.execute("SELECT * FROM processing_jobs WHERE document_id=?", (document_id,)).fetchone()
    row = connection.execute("SELECT payload FROM documents WHERE id=? AND deleted_at IS NULL", (document_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="文献不存在")
    document = json_load(row["payload"])
    if existing:
        return document
    source = connection.execute("SELECT * FROM document_files WHERE document_id=? AND role='source' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1", (document_id,)).fetchone()
    if not source:
        raise HTTPException(status_code=409, detail="原件尚未归档")
    selected = mode or document.get("processingMode") or "serial"
    if not isinstance(selected, str) or selected not in {"serial", "parallel"}:
        raise HTTPException(status_code=422, detail="处理方式必须是串行或并行")
    source_path = (FILE_STORAGE_DIR / source["storage_path"]).resolve()
    if not source_path.is_relative_to(FILE_STORAGE_DIR) or not source_path.is_file():
        raise HTTPException(status_code=409, detail="归档原件不存在或路径无效")
    stamp = now_iso()
    result = connection.execute("""INSERT INTO processing_jobs(document_id,mode,source_path,checkpoint,created_at,updated_at)
        VALUES(?,?,?,?,?,?)""", (document_id, selected, source["storage_path"], json_dump({"registrationStep": "metadata_candidate"}), stamp, stamp))
    document["processingMode"] = selected
    document["registration"] = {"status": "running", "stage": "metadata", "metadata": "pending", "error": "", "completedAt": ""}
    apply_asset_to_document(document, public_asset(source))
    document["processingTask"] = {**(document.get("processingTask") or {}), "backendManaged": True,
        "remoteTaskId": f"document-{result.lastrowid}", "status": "登记中", "mode": selected,
        "queueSequence": result.lastrowid, "revision": 1, "metadataSnapshot": processing_scheduler.metadata(document), "activeStages": {}, "submittedAt": stamp, "finishedAt": "", "message": "原件已归档，后端准备登记",
        "totalPages": 0, "completedPages": 0, "finalizedPages": 0, "failedPages": []}
    document.update(status="登记中", updatedAt=stamp)
    connection.execute("UPDATE documents SET payload=?,updated_at=?,version=version+1 WHERE id=?", (json_dump(document), stamp, document_id))
    return document


def require_owned_document(connection, document_id: str, user):
    row = connection.execute("SELECT owner_id FROM documents WHERE id=? AND deleted_at IS NULL", (document_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="文献不存在")
    if row["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="只有创建者可以修改文献")


def public_processing_document(connection, document_id, user):
    # 使用与初始化流程相同的可见性和资产投影。
    return next(doc for doc in active_payloads(connection, "documents", user) if doc["id"] == document_id)


@app.post("/api/documents/{document_id}/processing")
def submit_document_processing(document_id: str, payload: ProcessingSubmission, authorization: str | None = Header(default=None)):
    user = current_user(authorization)
    with database() as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        require_owned_document(connection, document_id, user)
        enqueue_document(connection, document_id, payload.mode)
        bump_sync_version(connection)
        return {"document": public_processing_document(connection, document_id, user)}


@app.delete("/api/documents/{document_id}/processing/failed-pages/{page_number}")
def remove_failed_processing_page(document_id: str, page_number: int, authorization: str | None = Header(default=None)):
    user = current_user(authorization)
    with database() as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        require_owned_document(connection, document_id, user)
        row = connection.execute("SELECT * FROM processing_jobs WHERE document_id=?", (document_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=409, detail="文献没有后端任务")
        document = json_load(connection.execute("SELECT payload FROM documents WHERE id=?", (document_id,)).fetchone()["payload"])
        page = next((p for p in document.get("pages", []) if p.get("pageNumber") == page_number), None)
        if not page or not page.get("failureStage"):
            raise HTTPException(status_code=409, detail="只能删除已标注的失败页")
        document["pages"] = [p for p in document["pages"] if p["pageNumber"] != page_number]
        task = document["processingTask"]
        task["failedPages"] = [p for p in task.get("failedPages", []) if p["pageNumber"] != page_number]
        checkpoint = json_load(row["checkpoint"])
        omitted = checkpoint.setdefault("omittedPages", [])
        if page_number not in omitted:
            omitted.append(page_number)
        # 此事务不会与页面结果提交发生竞争。只有失败且已终止的页面阶段可以删除，
        # 已归档原件保持不变。
        import sys
        processing_scheduler.save_job_state(sys.modules[__name__], connection, dict(row), document, checkpoint)
        return {"document": public_processing_document(connection, document_id, user)}


@app.delete("/api/documents/{document_id}/processing")
def cancel_document_processing(document_id: str, authorization: str | None = Header(default=None)):
    user = current_user(authorization)
    with database() as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT owner_id,payload,deleted_at FROM documents WHERE id=?", (document_id,)).fetchone()
        if not row:
            return {"status": "ok"}
        if row["owner_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="只有创建者可以停止文献任务")
        connection.execute("UPDATE processing_jobs SET status='cancelled',updated_at=? WHERE document_id=?", (now_iso(), document_id))
        if row["deleted_at"] is None:
            doc = json_load(row["payload"])
            task = doc.get("processingTask") or {}
            task.update(status="已取消", activeStages={}, finishedAt=now_iso(), revision=int(task.get("revision") or 0) + 1)
            doc.update(status="已取消", processingTask=task)
            connection.execute("UPDATE documents SET payload=?,updated_at=?,version=version+1 WHERE id=?", (json_dump(doc), now_iso(), document_id))
            bump_sync_version(connection)
        return {"status": "ok"}


@app.get("/api/documents/{document_id}/processing")
def document_processing_status(document_id: str, authorization: str | None = Header(default=None)):
    user = current_user(authorization)
    with database() as connection:
        row = connection.execute("SELECT owner_id,visibility FROM documents WHERE id=? AND deleted_at IS NULL", (document_id,)).fetchone()
        if not row or (row["owner_id"] != user["id"] and row["visibility"] != "public"):
            raise HTTPException(status_code=404, detail="文献不存在")
        return {"document": public_processing_document(connection, document_id, user)}


@app.post("/api/documents/{document_id}/processing/retry")
def retry_document_processing(document_id: str, authorization: str | None = Header(default=None)):
    user = current_user(authorization)
    with database() as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        require_owned_document(connection, document_id, user)
        row = connection.execute("SELECT * FROM processing_jobs WHERE document_id=?", (document_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=409, detail="原件尚未提交后端调度")
        if row["status"] == "failed":
            cp = json_load(row["checkpoint"])
            cp.update(attempts={}, retries={}, waiting={}, errors={})
            stamp = now_iso()
            connection.execute("UPDATE processing_jobs SET status='queued',retry_at=0,checkpoint=?,updated_at=? WHERE document_id=?", (json_dump(cp), stamp, document_id))
            document = json_load(connection.execute("SELECT payload FROM documents WHERE id=?", (document_id,)).fetchone()["payload"])
            document["processingTask"].update(status="登记中" if row["phase"] == "registration" else "排队中", finishedAt="", message="已申请重试失败阶段")
            if row["phase"] == "registration":
                document["registration"].update(status="running", error="")
            document.update(status=document["processingTask"]["status"], updatedAt=stamp)
            connection.execute("UPDATE documents SET payload=?,updated_at=?,version=version+1 WHERE id=?", (json_dump(document), stamp, document_id))
            bump_sync_version(connection)
        return {"document": public_processing_document(connection, document_id, user)}


_scheduler_worker = None


@app.on_event("startup")
def start_document_scheduler():
    global _scheduler_worker
    import sys
    if os.getenv("PROCESSING_SCHEDULER_ENABLED", "true").lower() not in {"0", "false", "no"}:
        with database():
            pass
        _scheduler_worker = processing_scheduler.Scheduler(sys.modules[__name__])
        _scheduler_worker.start()


@app.on_event("shutdown")
def stop_document_scheduler():
    if _scheduler_worker:
        _scheduler_worker.stop()


@app.post("/api/files/upload")
async def upload_file(
    document: UploadFile = File(...),
    documentId: str = Form(...),
    role: str = Form("source"),
    pageId: str = Form(""),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = current_user(authorization)
    document_id = documentId.strip()
    if not document_id:
        raise HTTPException(status_code=400, detail="documentId 不能为空")

    normalized_role = safe_part(role, "source")
    content = await document.read()
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")

    with database() as connection:
        existing = connection.execute(
            "SELECT owner_id FROM documents WHERE id = ?",
            (document_id,),
        ).fetchone()
    if not existing:
        raise HTTPException(status_code=409, detail="请先保存文献记录再上传原件")
    if existing["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="只有创建者可以修改文献")

    mime_type = document.content_type or mimetypes.guess_type(document.filename or "")[0] or "application/octet-stream"
    timestamp = now_iso()
    # 在写入新的孤立资产前拒绝替换。重新上传相同内容是幂等的，但不允许修改已提交原件。
    with database() as connection:
        submitted = connection.execute("SELECT source_path FROM processing_jobs WHERE document_id=?", (document_id,)).fetchone() if normalized_role == "source" else None
    if submitted:
        existing_path = Path(submitted["source_path"]).as_posix()
        expected_digest = hashlib.sha256(content).hexdigest()
        expected_path = relative_storage_path(document_id, normalized_role, expected_digest, mime_type, document.filename or "").as_posix()
        if existing_path != expected_path:
            raise HTTPException(status_code=409, detail="已提交的文献不能替换原件，请另行登记")

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
                connection.execute("BEGIN IMMEDIATE")
                require_owned_document(connection, document_id, user)
                file_record = upsert_file_record(
                    connection,
                    document_id=document_id,
                    page_id=pageId.strip(),
                    role=normalized_role,
                    asset=asset,
                    timestamp=timestamp,
                )
                archived_document = None
                if normalized_role == "source":
                    enqueue_document(connection, document_id)
                    archived_document = public_processing_document(connection, document_id, user)
                cursor = bump_sync_version(connection)
        return {"status": "ok", "file": file_record, "document": archived_document, "syncCursor": str(cursor)}
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"文件记录保存失败：{exc}") from exc


@app.post("/api/conversation-files/upload")
async def upload_conversation_file(
    attachment: UploadFile = File(...),
    conversationId: str = Form(...),
    attachmentId: str = Form(...),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = current_user(authorization)
    conversation_id = conversationId.strip()
    attachment_id = attachmentId.strip()
    if not conversation_id or not attachment_id:
        raise HTTPException(status_code=400, detail="conversationId 和 attachmentId 不能为空")

    with database() as connection:
        require_owned_conversation(connection, conversation_id, user)
        existing = connection.execute("SELECT conversation_id FROM conversation_files WHERE id = ?", (attachment_id,)).fetchone()
        if existing and existing["conversation_id"] != conversation_id:
            raise HTTPException(status_code=404, detail="???????")

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
                require_owned_conversation(connection, conversation_id, user)
                existing = connection.execute("SELECT conversation_id FROM conversation_files WHERE id = ?", (attachment_id,)).fetchone()
                if existing and existing["conversation_id"] != conversation_id:
                    raise HTTPException(status_code=404, detail="conversation attachment not found")
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
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = current_user(authorization)
    timestamp = now_iso()
    with database() as connection:
        with connection:
            require_owned_conversation_file(connection, attachment_id, user)
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
def delete_conversation_file(attachment_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user = current_user(authorization)
    timestamp = now_iso()
    with database() as connection:
        with connection:
            require_owned_conversation_file(connection, attachment_id, user)
            connection.execute(
                "UPDATE conversation_files SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                (timestamp, timestamp, attachment_id),
            )
            cursor = bump_sync_version(connection)
    return {"status": "ok", "attachmentId": attachment_id, "syncCursor": str(cursor)}


@app.post("/api/conversation-shares")
def create_conversation_share(
    payload: ConversationSharePayload,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = current_user(authorization)
    conversation_id = str(payload.conversationId or "").strip()
    timestamp = now_iso()
    with database() as connection:
        conversation = require_owned_conversation(connection, conversation_id, user)
        selected_ids = validate_share_selection(conversation, payload.turnIds)
        existing = connection.execute(
            "SELECT id, token FROM conversation_shares WHERE conversation_id = ? AND active = 1 AND deleted_at IS NULL",
            (conversation_id,),
        ).fetchone()
        share_id = existing["id"] if existing else secrets.token_hex(12)
        token = existing["token"] if existing else secrets.token_urlsafe(24)
        with connection:
            if existing:
                connection.execute(
                    "UPDATE conversation_shares SET selected_turn_ids = ?, content = ?, updated_at = ? WHERE id = ?",
                    (json_dump(selected_ids), json_dump({"title": conversation.get("title") or "分享的对话", "turns": conversation_share_turns(conversation, selected_ids)}), timestamp, share_id),
                )
            else:
                connection.execute(
                    "INSERT INTO conversation_shares(id, token, conversation_id, selected_turn_ids, content, active, created_at, updated_at) "
                    "VALUES(?, ?, ?, ?, ?, 1, ?, ?)",
                    (share_id, token, conversation_id, json_dump(selected_ids), json_dump({"title": conversation.get("title") or "分享的对话", "turns": conversation_share_turns(conversation, selected_ids)}), timestamp, timestamp),
                )
            bump_sync_version(connection)
    return {"shareId": share_id, "token": token, "selectedTurnIds": selected_ids, "updatedAt": timestamp}


@app.put("/api/conversation-shares/{token}")
def update_conversation_share(
    token: str,
    payload: ConversationSharePayload,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = current_user(authorization)
    timestamp = now_iso()
    with database() as connection:
        row = connection.execute(
            "SELECT id, conversation_id FROM conversation_shares WHERE token = ? AND active = 1 AND deleted_at IS NULL",
            (token,),
        ).fetchone()
        if not row or row["conversation_id"] != str(payload.conversationId or "").strip():
            raise HTTPException(status_code=404, detail="分享链接不存在或已失效")
        conversation = require_owned_conversation(connection, row["conversation_id"], user)
        selected_ids = validate_share_selection(conversation, payload.turnIds)
        with connection:
            connection.execute(
                "UPDATE conversation_shares SET selected_turn_ids = ?, content = ?, updated_at = ? WHERE id = ?",
                (json_dump(selected_ids), json_dump({"title": conversation.get("title") or "分享的对话", "turns": conversation_share_turns(conversation, selected_ids)}), timestamp, row["id"]),
            )
            bump_sync_version(connection)
    return {"shareId": row["id"], "token": token, "selectedTurnIds": selected_ids, "updatedAt": timestamp}


@app.delete("/api/conversation-shares/{token}")
def delete_conversation_share(token: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user = current_user(authorization)
    timestamp = now_iso()
    with database() as connection:
        with connection:
            row = connection.execute(
                "SELECT conversation_id FROM conversation_shares WHERE token = ? AND active = 1 AND deleted_at IS NULL",
                (token,),
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="share link not found or expired")
            require_owned_conversation(connection, row["conversation_id"], user)
            cursor = connection.execute(
                "UPDATE conversation_shares SET active = 0, deleted_at = ?, updated_at = ? "
                "WHERE token = ? AND active = 1 AND deleted_at IS NULL",
                (timestamp, timestamp, token),
            )
            if cursor.rowcount:
                bump_sync_version(connection)
    if not cursor.rowcount:
        raise HTTPException(status_code=404, detail="分享链接不存在或已失效")
    return {"status": "ok", "token": token, "updatedAt": timestamp}


@app.get("/api/conversation-shares/{token}")
def get_conversation_share(token: str) -> dict[str, Any]:
    with database() as connection:
        row = connection.execute(
            "SELECT conversation_id, selected_turn_ids, content FROM conversation_shares "
            "WHERE token = ? AND active = 1 AND deleted_at IS NULL",
            (token,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="分享链接不存在或已失效")
        conversation = get_conversation_for_share(connection, row["conversation_id"])
        snapshot = json_load(row["content"]) if row["content"] else {}
        if not isinstance(snapshot, dict):
            snapshot = {}
        return {
            "title": str(snapshot.get("title") or conversation.get("title") or "分享的对话"),
            "turns": snapshot.get("turns") if isinstance(snapshot.get("turns"), list) else conversation_share_turns(conversation, json_load(row["selected_turn_ids"])),
        }

@app.post("/api/auth/register")
def register(credentials: Credentials) -> dict[str, Any]:
    username = credentials.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="账号不能为空")
    if len(username) < 2:
        raise HTTPException(status_code=400, detail="账号至少需要2个字符")
    if len(credentials.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少需要6个字符")
    with database() as connection:
        try:
            user = insert_user(connection, username, credentials.password, False)
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="账号已存在") from exc
    token = create_session(user)
    return {"token": token, "user": user}

@app.post("/api/auth/login")
def login(credentials: Credentials) -> dict[str, Any]:
    with database() as connection:
        row = connection.execute("SELECT id,username,is_admin FROM users WHERE username=? AND password_hash=?", (credentials.username.strip(), hash_password(credentials.password))).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="账号或密码错误")
    user = {"id": row["id"], "username": row["username"], "isAdmin": bool(row["is_admin"])}
    token = create_session(user)
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
    require_admin(user)
    with database() as connection:
        return [{"id": r["id"], "username": r["username"], "isAdmin": bool(r["is_admin"]), "createdAt": r["created_at"]} for r in connection.execute("SELECT id,username,is_admin,created_at FROM users ORDER BY created_at ASC, id ASC").fetchall()]

@app.post("/api/admin/users")
def create_user(payload: UserCreate, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    admin = current_user(authorization)
    require_admin(admin)
    try:
        with database() as connection:
            return insert_user(connection, payload.username.strip(), payload.password, payload.isAdmin)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="账号已存在") from exc

@app.delete("/api/admin/users/{user_id}")
def delete_user(user_id: int, authorization: str | None = Header(default=None)) -> dict[str, str]:
    user = current_user(authorization)
    require_admin(user)
    if user_id == user["id"]: raise HTTPException(status_code=400, detail="不能删除当前管理员")
    with database() as connection:
        row = connection.execute("SELECT id, is_admin FROM users WHERE id=?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="用户不存在")
        if row["is_admin"]:
            ensure_admin_remains(connection)
        with connection:
            connection.execute("DELETE FROM users WHERE id=?", (user_id,))
    purge_sessions_for(user_id)
    return {"status": "ok"}

@app.patch("/api/admin/users/{user_id}")
def set_user_admin(user_id: int, payload: UserAdminUpdate, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user = current_user(authorization)
    require_admin(user)
    with database() as connection:
        row = connection.execute("SELECT id, username, is_admin FROM users WHERE id=?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="用户不存在")
        if row["id"] == user["id"]:
            raise HTTPException(status_code=400, detail="不能修改当前账户的管理员状态")
        if row["is_admin"] and not payload.isAdmin:
            ensure_admin_remains(connection)
        with connection:
            connection.execute("UPDATE users SET is_admin=? WHERE id=?", (int(payload.isAdmin), user_id))
    purge_sessions_for(user_id)
    return {"id": row["id"], "username": row["username"], "isAdmin": payload.isAdmin}


def require_visible_document_page(
    connection: sqlite3.Connection,
    user: dict[str, Any],
    document_id: str,
    page_id: str,
) -> None:
    row = connection.execute(
        """
        SELECT p.id
        FROM document_pages AS p
        JOIN documents AS d ON d.id = p.document_id
        WHERE d.id = ?
          AND p.id = ?
          AND d.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND (d.visibility = 'public' OR d.owner_id = ?)
        """,
        (document_id, page_id, user["id"]),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="文献页不存在或不可见")


@app.get("/api/documents/{document_id}/pages/{page_id}/annotation")
def get_page_annotation(
    document_id: str,
    page_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    user = current_user(authorization)
    with database() as connection:
        require_visible_document_page(connection, user, document_id, page_id)
        row = connection.execute(
            "SELECT content, updated_at FROM page_annotations WHERE user_id = ? AND page_id = ?",
            (user["id"], page_id),
        ).fetchone()
    return {
        "content": row["content"] if row else "",
        "updatedAt": row["updated_at"] if row else "",
    }


@app.put("/api/documents/{document_id}/pages/{page_id}/annotation")
def put_page_annotation(
    document_id: str,
    page_id: str,
    payload: PageAnnotationUpdate,
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    user = current_user(authorization)
    timestamp = now_iso()
    with database() as connection:
        require_visible_document_page(connection, user, document_id, page_id)
        with connection:
            if payload.content:
                connection.execute(
                    """
                    INSERT INTO page_annotations(user_id, document_id, page_id, content, updated_at)
                    VALUES(?, ?, ?, ?, ?)
                    ON CONFLICT(user_id, page_id) DO UPDATE SET
                        document_id = excluded.document_id,
                        content = excluded.content,
                        updated_at = excluded.updated_at
                    """,
                    (user["id"], document_id, page_id, payload.content, timestamp),
                )
            else:
                connection.execute(
                    "DELETE FROM page_annotations WHERE user_id = ? AND page_id = ?",
                    (user["id"], page_id),
                )
    return {"status": "ok", "content": payload.content, "updatedAt": timestamp}

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
    if payload.schemaVersion != SCHEMA_VERSION:
        raise HTTPException(status_code=409, detail="data schema changed; refresh the page")
    timestamp = now_iso()
    try:
        with database() as connection:
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                upsert_documents(connection, payload.documents, timestamp, user)
                upsert_conversations(connection, payload.conversations, timestamp, user)
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
                    user,
                )
                cursor = bump_sync_version(connection)
                snapshot = build_snapshot(connection, user)
        snapshot.update({"status": "ok", "syncCursor": str(cursor), "updatedAt": timestamp})
        return snapshot
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"数据库保存失败：{exc}") from exc
