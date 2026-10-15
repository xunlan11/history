"""SQLite projections and leases. The document tables remain authoritative."""
from __future__ import annotations

import json
import sqlite3
import time

from service.retrieval_chunks import chunk_source, page_sources, select_page_source


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript("""
    CREATE TABLE IF NOT EXISTS semantic_models (
      fingerprint TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS semantic_sources (
      document_id TEXT NOT NULL, page_id TEXT NOT NULL, policy TEXT NOT NULL,
      source_layer TEXT NOT NULL, source_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(page_id, policy));
    CREATE TABLE IF NOT EXISTS semantic_chunks (
      chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, page_id TEXT NOT NULL,
      source_layer TEXT NOT NULL, source_hash TEXT NOT NULL, ordinal INTEGER NOT NULL,
      start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL,
      chunker_version TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS semantic_vectors (
      chunk_id TEXT NOT NULL REFERENCES semantic_chunks(chunk_id) ON DELETE CASCADE,
      model_fingerprint TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL,
      PRIMARY KEY(chunk_id, model_fingerprint));
    CREATE TABLE IF NOT EXISTS semantic_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, page_id TEXT NOT NULL, source_layer TEXT NOT NULL,
      source_hash TEXT NOT NULL, model_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      retry_at REAL NOT NULL DEFAULT 0, lease_until REAL NOT NULL DEFAULT 0,
      lease_token TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      UNIQUE(page_id, source_layer, source_hash, model_fingerprint));
    CREATE INDEX IF NOT EXISTS idx_semantic_chunks_source
      ON semantic_chunks(page_id, source_layer, source_hash);
    CREATE INDEX IF NOT EXISTS idx_semantic_vectors_model
      ON semantic_vectors(model_fingerprint, chunk_id);
    CREATE INDEX IF NOT EXISTS idx_semantic_jobs_ready
      ON semantic_jobs(status, retry_at, lease_until);
    """)


def reconcile_page(connection: sqlite3.Connection, document_id: str, page: dict, timestamp: str) -> None:
    from service.retrieval_types import CHUNKER_VERSION
    page_id = str(page["id"])
    sources = page_sources(document_id, page)
    existing = {(r["source_layer"], r["source_hash"]) for r in connection.execute(
        "SELECT DISTINCT source_layer, source_hash FROM semantic_chunks WHERE page_id=?", (page_id,))}
    desired = {(s.sourceLayer, s.sourceHash) for s in sources.values()}
    for layer, digest in existing - desired:
        connection.execute("DELETE FROM semantic_vectors WHERE chunk_id IN (SELECT chunk_id FROM semantic_chunks WHERE page_id=? AND source_layer=? AND source_hash=?)", (page_id, layer, digest))
        connection.execute("DELETE FROM semantic_chunks WHERE page_id=? AND source_layer=? AND source_hash=?", (page_id, layer, digest))
        connection.execute("DELETE FROM semantic_jobs WHERE page_id=? AND source_layer=? AND source_hash=?", (page_id, layer, digest))
    for source in sources.values():
        if (source.sourceLayer, source.sourceHash) not in existing:
            connection.executemany("INSERT OR IGNORE INTO semantic_chunks VALUES(?,?,?,?,?,?,?,?,?,?)", [
                (c.chunkId, c.documentId, c.pageId, c.sourceLayer, c.sourceHash,
                 c.ordinal, c.start, c.end, c.text, CHUNKER_VERSION) for c in chunk_source(source)])
    for policy in ("primary", "processed"):
        source = select_page_source(page, policy, document_id)
        if source:
            connection.execute("""INSERT INTO semantic_sources VALUES(?,?,?,?,?,?)
              ON CONFLICT(page_id,policy) DO UPDATE SET source_layer=excluded.source_layer,
              source_hash=excluded.source_hash,updated_at=excluded.updated_at""",
              (document_id, page_id, policy, source.sourceLayer, source.sourceHash, timestamp))
        else:
            connection.execute("DELETE FROM semantic_sources WHERE page_id=? AND policy=?", (page_id, policy))
    connection.execute("""DELETE FROM semantic_jobs WHERE page_id=? AND NOT EXISTS
      (SELECT 1 FROM semantic_sources s WHERE s.page_id=semantic_jobs.page_id
       AND s.source_layer=semantic_jobs.source_layer AND s.source_hash=semantic_jobs.source_hash)""", (page_id,))


def cleanup_deleted(connection: sqlite3.Connection) -> None:
    # Exclusion at query time is mandatory; this is only space reclamation.
    active = "SELECT p.id FROM document_pages p JOIN documents d ON d.id=p.document_id WHERE p.deleted_at IS NULL AND d.deleted_at IS NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id=d.owner_id AND u.deleted_at IS NULL)"
    connection.execute(f"DELETE FROM semantic_vectors WHERE chunk_id IN (SELECT chunk_id FROM semantic_chunks WHERE page_id NOT IN ({active}))")
    for table in ("semantic_chunks", "semantic_sources", "semantic_jobs"):
        connection.execute(f"DELETE FROM {table} WHERE page_id NOT IN ({active})")


def enqueue_model(connection: sqlite3.Connection, identity) -> None:
    connection.execute("INSERT OR IGNORE INTO semantic_models VALUES(?,?,?)", (identity.fingerprint, json.dumps(identity.to_dict()), time.time()))
    connection.execute("""INSERT OR IGNORE INTO semantic_jobs(page_id,source_layer,source_hash,model_fingerprint)
      SELECT DISTINCT s.page_id,s.source_layer,s.source_hash,? FROM semantic_sources s
      JOIN document_pages p ON p.id=s.page_id JOIN documents d ON d.id=p.document_id
      WHERE p.deleted_at IS NULL AND d.deleted_at IS NULL""", (identity.fingerprint,))


def claim_job(connection: sqlite3.Connection, fingerprint: str, lease_seconds: float, token: str) -> dict | None:
    now = time.time()
    connection.execute("BEGIN IMMEDIATE")
    row = connection.execute("""SELECT * FROM semantic_jobs WHERE model_fingerprint=? AND
      ((status IN ('pending','waiting') AND retry_at<=?) OR (status='running' AND lease_until<?))
      ORDER BY id LIMIT 1""", (fingerprint, now, now)).fetchone()
    if row is None:
        connection.commit()
        return None
    connection.execute("UPDATE semantic_jobs SET status='running',lease_until=?,lease_token=? WHERE id=?", (now + lease_seconds, token, row["id"]))
    connection.commit()
    return dict(row) | {"lease_token": token}
