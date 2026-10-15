"""Durable indexing worker; network calls never hold a SQLite transaction."""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid

from service.embedding import EmbeddingError, EmbeddingUnavailable, normalize_vector
from service import retrieval_store as store

logger = logging.getLogger(__name__)


class SemanticWorker:
    def __init__(self, connection_factory, embedding_client, *, pause_when_processing: bool = True):
        self.connection_factory = connection_factory
        self.client = embedding_client
        self.pause_when_processing = pause_when_processing
        self.interval = max(1, float(os.getenv("SEMANTIC_SCAN_INTERVAL_SECONDS", "30")))
        self.batch_size = max(1, min(64, int(os.getenv("EMBEDDING_BATCH_SIZE", "8"))))
        self._stop = threading.Event()
        self._thread = None
        self._last_scan = 0.0

    def scan(self, identity) -> None:
        after = ""
        while not self._stop.is_set():
            with self.connection_factory() as connection:
                rows = connection.execute("""SELECT p.id,p.document_id,p.payload FROM document_pages p
                  JOIN documents d ON d.id=p.document_id WHERE p.deleted_at IS NULL AND d.deleted_at IS NULL
                  AND p.id>? ORDER BY p.id LIMIT 100""", (after,)).fetchall()
                with connection:
                    for row in rows:
                        page = json.loads(row["payload"])
                        page["id"] = row["id"]
                        store.reconcile_page(connection, row["document_id"], page, str(time.time()))
            if not rows:
                break
            after = rows[-1]["id"]
        with self.connection_factory() as connection, connection:
            store.cleanup_deleted(connection)
            store.enqueue_model(connection, identity)
        self._last_scan = time.monotonic()

    def run_once(self) -> bool:
        import numpy as np
        if self.pause_when_processing:
            with self.connection_factory() as connection:
                if connection.execute("SELECT 1 FROM processing_jobs WHERE status IN ('queued','running') LIMIT 1").fetchone():
                    return False
        identity = self.client.describe()
        if time.monotonic() - self._last_scan >= self.interval:
            self.scan(identity)
        token = uuid.uuid4().hex
        lease = max(300, float(getattr(self.client, "timeout", 60)) * 2)
        with self.connection_factory() as connection:
            job = store.claim_job(connection, identity.fingerprint, lease, token)
            if not job:
                return False
            chunks = connection.execute("""SELECT c.* FROM semantic_chunks c
              JOIN document_pages p ON p.id=c.page_id JOIN documents d ON d.id=p.document_id
              WHERE c.page_id=? AND c.source_layer=? AND c.source_hash=?
              AND p.deleted_at IS NULL AND d.deleted_at IS NULL ORDER BY c.ordinal""",
              (job["page_id"], job["source_layer"], job["source_hash"])).fetchall()
        try:
            for offset in range(0, len(chunks), self.batch_size):
                if self._stop.is_set():
                    return False  # lease recovery resumes only missing vectors
                batch = chunks[offset:offset + self.batch_size]
                # Skip successfully published batches after a crash.
                with self.connection_factory() as connection:
                    batch = [c for c in batch if not connection.execute("SELECT 1 FROM semantic_vectors WHERE chunk_id=? AND model_fingerprint=?", (c["chunk_id"], identity.fingerprint)).fetchone()]
                if not batch:
                    continue
                # Identical clean/punctuated passages share computation even
                # though their source anchors remain distinct.
                by_text, missing = {}, []
                with self.connection_factory() as connection:
                    for chunk in batch:
                        text = chunk["text"]
                        if text in by_text or text in missing:
                            continue
                        cached = connection.execute("""SELECT v.vector,v.dimensions FROM semantic_vectors v
                          JOIN semantic_chunks c ON c.chunk_id=v.chunk_id
                          WHERE c.text=? AND v.model_fingerprint=? LIMIT 1""", (text, identity.fingerprint)).fetchone()
                        if cached and cached["dimensions"] == identity.dimensions:
                            by_text[text] = normalize_vector(np.frombuffer(cached["vector"], dtype="<f4").tolist(), identity.dimensions)
                        else:
                            missing.append(text)
                if missing:
                    generated = self.client.embed_documents(missing)
                    if len(generated) != len(missing):
                        raise EmbeddingError("嵌入返回数量不符")
                    by_text.update({text: normalize_vector(vector, identity.dimensions) for text, vector in zip(missing, generated)})
                vectors = [by_text[chunk["text"]] for chunk in batch]
                if self.client.describe().fingerprint != identity.fingerprint:
                    raise EmbeddingUnavailable("嵌入模型已变化，等待重建")
                with self.connection_factory() as connection, connection:
                    connection.execute("BEGIN IMMEDIATE")
                    owner = connection.execute("SELECT 1 FROM semantic_jobs WHERE id=? AND lease_token=? AND status='running'", (job["id"], token)).fetchone()
                    current = connection.execute("""SELECT 1 FROM semantic_sources s
                      JOIN document_pages p ON p.id=s.page_id JOIN documents d ON d.id=p.document_id
                      WHERE s.page_id=? AND s.source_layer=? AND s.source_hash=?
                      AND p.deleted_at IS NULL AND d.deleted_at IS NULL""", (job["page_id"], job["source_layer"], job["source_hash"])).fetchone()
                    if not owner or not current:
                        return True
                    for chunk, vector in zip(batch, vectors):
                        connection.execute("INSERT OR REPLACE INTO semantic_vectors VALUES(?,?,?,?)", (chunk["chunk_id"], identity.fingerprint, identity.dimensions, np.asarray(vector, dtype="<f4").tobytes()))
                    connection.execute("UPDATE semantic_jobs SET lease_until=? WHERE id=? AND lease_token=?", (time.time() + lease, job["id"], token))
            with self.connection_factory() as connection, connection:
                connection.execute("UPDATE semantic_jobs SET status='ready',error='',lease_until=0 WHERE id=? AND lease_token=?", (job["id"], token))
        except EmbeddingError as exc:
            with self.connection_factory() as connection, connection:
                unavailable = isinstance(exc, EmbeddingUnavailable)
                attempts = job["attempts"] + (0 if unavailable else 1)
                status = "waiting" if unavailable or attempts < 3 else "failed"
                connection.execute("""UPDATE semantic_jobs SET status=?,attempts=?,retry_at=?,lease_until=0,error=?
                  WHERE id=? AND lease_token=?""", (status, attempts, time.time() + self.interval, str(exc), job["id"], token))
        return True

    def _run(self):
        while not self._stop.is_set():
            try:
                did_work = self.run_once()
            except Exception:
                logger.exception("Semantic indexing paused; durable tasks will retry")
                did_work = False
            if not did_work:
                self._stop.wait(self.interval)

    def start(self):
        if not self._thread:
            self._thread = threading.Thread(target=self._run, name="semantic-index", daemon=True)
            self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
