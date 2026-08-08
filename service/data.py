from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


APP_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.getenv("DATA_DB_PATH", APP_DIR / "storage" / "app.db")).resolve()

app = FastAPI(title="近代军史数智平台数据服务")

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

        """
    )
    connection.execute(
        "INSERT OR IGNORE INTO app_meta(key, value) VALUES('sync_version', '0')"
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


def active_payloads(connection: sqlite3.Connection, table: Literal["documents", "conversations"]) -> list[dict[str, Any]]:
    rows = connection.execute(
        f"""
        SELECT payload
        FROM {table}
        WHERE deleted_at IS NULL
        ORDER BY sort_order ASC, updated_at DESC
        """
    ).fetchall()
    return [json_load(row["payload"]) for row in rows]


def upsert_documents(connection: sqlite3.Connection, documents: list[dict[str, Any]], timestamp: str) -> None:
    for sort_order, document in enumerate(documents):
        document_id = str(document.get("id") or "").strip()
        if not document_id:
            continue

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


def build_snapshot(connection: sqlite3.Connection) -> dict[str, Any]:
    return {
        "documents": active_payloads(connection, "documents"),
        "conversations": active_payloads(connection, "conversations"),
        "syncCursor": str(get_sync_version(connection)),
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
    return {
        "status": "ok",
        "database": str(DB_PATH),
        "documents": document_count,
        "pages": page_count,
    }


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
        return {"status": "ok", "syncCursor": str(cursor), "updatedAt": timestamp}
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"数据库保存失败：{exc}") from exc
