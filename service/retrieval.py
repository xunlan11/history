"""Page-local chunking, durable index storage, and permission-first retrieval.

Evidence offsets use Unicode code points, not UTF-16. Document tables remain
authoritative; semantic tables are derived projections.
"""
from __future__ import annotations

import hashlib
import heapq
import json
import logging
import os
import re
import sqlite3
import time
from collections import Counter

from service.embedding import EmbeddingError, semantic_enabled
from service.retrieval_types import CHUNKER_VERSION, Chunk, RetrievalRequest, SourceText, TextPolicy
from service.variant import to_simplified

logger = logging.getLogger(__name__)


# Source selection and lossless chunking.

def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def make_source(document_id: str, page_id: str, layer: str, text: str) -> SourceText:
    return SourceText(document_id, page_id, layer, text, text_hash(text))


def select_page_source(page: dict, policy: TextPolicy, document_id: str = "") -> SourceText | None:
    layers = ("cleanText", "punctuatedText") if policy == "processed" else ("punctuatedText", "cleanText", "ocrText")
    for layer in layers:
        text = page.get(layer)
        if isinstance(text, str) and text.strip():
            return make_source(document_id, str(page.get("id", "")), layer, text)
    return None


def page_sources(document_id: str, page: dict) -> dict[str, SourceText]:
    return {layer: make_source(document_id, str(page["id"]), layer, text)
            for layer in ("ocrText", "cleanText", "punctuatedText", "notes")
            if isinstance(text := page.get(layer), str) and text.strip()}


def chunk_source(source: SourceText) -> list[Chunk]:
    text = source.text
    boundaries = [m.end() for m in re.finditer(r"\n\s*\n|[。！？!?；;](?:[”’」』])?", text)]
    chunks: list[Chunk] = []
    start = 0
    while start < len(text):
        upper = min(start + 800, len(text))
        if upper == len(text):
            end = upper
        else:
            candidates = [pos for pos in boundaries if start + 250 <= pos <= upper]
            end = min(candidates, key=lambda pos: abs(pos - (start + 500))) if candidates else upper
        identity = [source.documentId, source.pageId, source.sourceLayer, source.sourceHash, start, end, CHUNKER_VERSION]
        chunk_id = text_hash(json.dumps(identity, ensure_ascii=False, separators=(",", ":")))
        chunks.append(Chunk(chunk_id, source.documentId, source.pageId, source.sourceLayer,
                            source.sourceHash, start, end, text[start:end], len(chunks)))
        if end == len(text):
            break
        start = max(start + 1, end - min(80, (end - start) // 5))
    return chunks


# SQLite projections and durable indexing jobs.

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


# Permission-filtered retrieval and evidence validation.

def normalized(text: str) -> str:
    return re.sub(r"\s+", "", to_simplified(text).casefold())


def literal_score(text: str, query: str) -> float:
    text, query = normalized(text), normalized(query)
    if not query or not text:
        return 0.0
    exact = 5.0 if query in text else 0.0
    terms = set(re.findall(r"[a-z0-9]+|[\u3400-\u9fff]{1,2}", query))
    grams = {query[i:i + 2] for i in range(len(query) - 1)} if len(query) > 1 else {query}
    matched = sum(term in text for term in terms)
    overlap = sum(gram in text for gram in grams) / len(grams)
    return exact + overlap + (matched / max(1, len(terms))) * 0.2 if overlap else exact


def _scope(user: dict, document_ids: list[str] | None):
    sql = "p.deleted_at IS NULL AND d.deleted_at IS NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id=d.owner_id AND u.deleted_at IS NULL) AND (d.visibility='public' OR d.owner_id=?)"
    params: list = [user["id"]]
    if document_ids is not None:
        if not document_ids:
            return sql + " AND 0", params
        sql += " AND d.id IN (" + ",".join("?" for _ in document_ids) + ")"
        params.extend(document_ids)
    return sql, params


def _evidence(chunk, row, metadata):
    item = chunk.to_dict() if hasattr(chunk, "to_dict") else {
        "chunkId": chunk["chunk_id"], "documentId": chunk["document_id"], "pageId": chunk["page_id"],
        "sourceLayer": chunk["source_layer"], "sourceHash": chunk["source_hash"], "start": chunk["start"],
        "end": chunk["end"], "text": chunk["text"], "ordinal": chunk["ordinal"]}
    return item | {"sourceType": "document-page", "pageNumber": row["page_number"],
                   "title": metadata.get("title") or metadata.get("fileName") or "未命名文献",
                   "author": metadata.get("author", ""), "year": metadata.get("year", ""),
                   "publisher": metadata.get("publisher", "")}


def retrieve(connection, user: dict, request: RetrievalRequest, embedding_client, *, enabled: bool | None = None) -> dict:
    import numpy as np
    scope, params = _scope(user, request.documentIds)
    metadata_by_document = {}
    for row in connection.execute(f"""SELECT d.id,d.payload FROM documents d WHERE EXISTS
      (SELECT 1 FROM document_pages p WHERE p.document_id=d.id AND {scope})""", params):
        document = json.loads(row["payload"])
        metadata_by_document[row["id"]] = {key: document.get(key, "") for key in ("title", "fileName", "author", "year", "publisher", "tags")}
        del document
    rows = connection.execute(f"""SELECT p.id,p.document_id,p.page_number,p.payload
      FROM document_pages p JOIN documents d ON d.id=p.document_id WHERE {scope}
      ORDER BY d.sort_order,p.page_number,p.id""", params)
    candidates: dict[str, dict] = {}
    vector_sources = set()
    page_sources_expected = {}
    expected_counts = Counter()
    for row in rows:
        page, metadata = json.loads(row["payload"]), metadata_by_document[row["document_id"]]
        page["id"] = row["id"]
        primary = select_page_source(page, request.textPolicy, row["document_id"])
        if primary is None:
            continue
        page_sources_expected[row["id"]] = (primary.sourceLayer, primary.sourceHash)
        vector_sources.add((row["id"], primary.sourceLayer, primary.sourceHash))
        sources = page_sources(row["document_id"], page)
        if request.textPolicy == "processed":
            sources.pop("ocrText", None)
        metadata_text = "\n".join(str(metadata.get(k) or "") for k in ("title", "author", "year", "publisher", "tags", "fileName"))
        metadata_score = 0.3 * literal_score(metadata_text, request.query)
        for source in sources.values():
            stored = connection.execute("SELECT * FROM semantic_chunks WHERE page_id=? AND source_layer=? AND source_hash=? ORDER BY ordinal", (row["id"], source.sourceLayer, source.sourceHash)).fetchall()
            chunks = stored or chunk_source(source)
            for chunk in chunks:
                hit = _evidence(chunk, row, metadata)
                hit["literalScore"] = literal_score(hit["text"], request.query) + metadata_score
                candidates[hit["chunkId"]] = hit
                if hit["sourceLayer"] == primary.sourceLayer and hit["sourceHash"] == primary.sourceHash:
                    expected_counts[row["id"]] += 1
    warnings = []
    fingerprint = None
    vector_top = []
    indexed_counts = Counter()
    active = semantic_enabled() if enabled is None else enabled
    if candidates and active:
        try:
            identity = embedding_client.describe()
            fingerprint = identity.fingerprint
            query = np.asarray(embedding_client.embed_query(request.query), dtype=np.float32)
            if embedding_client.describe().fingerprint != fingerprint:
                raise EmbeddingError("嵌入模型已变化，暂时使用字面检索")
            if len(query) != identity.dimensions or not np.isfinite(query).all() or np.linalg.norm(query) == 0:
                raise EmbeddingError("查询嵌入维数或数值无效")
            query /= np.linalg.norm(query)
            minimum = float(os.getenv("SEMANTIC_MIN_COSINE", "0"))
            if not -1 <= minimum <= 1:
                raise EmbeddingError("SEMANTIC_MIN_COSINE 必须在 -1 到 1 之间")
            cursor = connection.execute(f"""SELECT c.chunk_id,c.page_id,c.source_layer,c.source_hash,v.vector,v.dimensions
              FROM semantic_vectors v JOIN semantic_chunks c ON c.chunk_id=v.chunk_id
              JOIN document_pages p ON p.id=c.page_id JOIN documents d ON d.id=p.document_id
              WHERE {scope} AND v.model_fingerprint=?""", params + [fingerprint])
            while batch := cursor.fetchmany(2048):
                valid = []
                for entry in batch:
                    if entry["chunk_id"] not in candidates or (entry["page_id"], entry["source_layer"], entry["source_hash"]) not in vector_sources:
                        continue
                    vector = np.frombuffer(entry["vector"], dtype="<f4")
                    if entry["dimensions"] != identity.dimensions or len(vector) != identity.dimensions or not np.isfinite(vector).all():
                        continue
                    valid.append((entry, vector))
                if not valid:
                    continue
                scores = np.stack([v for _, v in valid]) @ query
                for (entry, _), score in zip(valid, scores):
                    indexed_counts[entry["page_id"]] += 1
                    if float(score) <= minimum:
                        continue
                    item = (float(score), entry["chunk_id"])
                    if len(vector_top) < 60:
                        heapq.heappush(vector_top, item)
                    elif item > vector_top[0]:
                        heapq.heapreplace(vector_top, item)
        except (EmbeddingError, ValueError) as exc:
            vector_top.clear()
            logger.warning("Semantic retrieval unavailable: %s", exc)
            warnings.append("语义检索暂不可用，已使用字面检索")
    if not active:
        warnings.append("语义索引未启用，已使用字面检索")
    literal_top = sorted((h for h in candidates.values() if h["literalScore"] > 0), key=lambda h: (-h["literalScore"], h["chunkId"]))[:60]
    rankings = {}
    for kind, ids in (("literal", [h["chunkId"] for h in literal_top]), ("semantic", [cid for _, cid in sorted(vector_top, reverse=True)])):
        for rank, cid in enumerate(ids, 1):
            record = rankings.setdefault(cid, {"score": 0.0, "matchedBy": []})
            record["score"] += 1 / (60 + rank)
            record["matchedBy"].append(kind)
    limit = request.limit or {"search": 20, "chat": 12, "chronicle": 30}[request.mode]
    hits, per_page, seen_ranges = [], Counter(), set()
    for cid, rank in sorted(rankings.items(), key=lambda pair: (-pair[1]["score"], pair[0])):
        hit = candidates[cid]
        # Identical text in clean/punctuated layers must not take every slot.
        key = (hit["pageId"], normalized(hit["text"]))
        if key in seen_ranges or per_page[hit["pageId"]] >= 3:
            continue
        seen_ranges.add(key)
        per_page[hit["pageId"]] += 1
        hits.append({k: v for k, v in hit.items() if k != "literalScore"} | rank)
        if len(hits) >= limit:
            break
    if request.mode == "chronicle":
        # Reserve space for neighboring context without exceeding the hard limit.
        # Select one hit from each page before taking repeated-page hits.
        diversified, repeated, pages_seen = [], [], set()
        for hit in hits:
            if hit["pageId"] in pages_seen:
                repeated.append(hit)
            else:
                pages_seen.add(hit["pageId"])
                diversified.append(hit)
        hits = diversified + repeated
        selected = hits[:max(1, limit * 2 // 3)]
        selected_pages = Counter(h["pageId"] for h in selected)
        selected_ids = {h["chunkId"] for h in selected}
        for hit in list(selected):
            neighbors = [c for c in candidates.values() if c["pageId"] == hit["pageId"] and c["sourceLayer"] == hit["sourceLayer"] and abs(c["ordinal"] - hit["ordinal"]) == 1]
            for neighbor in neighbors:
                if len(selected) >= limit:
                    break
                if neighbor["chunkId"] not in selected_ids and selected_pages[neighbor["pageId"]] < 3:
                    selected_pages[neighbor["pageId"]] += 1
                    selected_ids.add(neighbor["chunkId"])
                    selected.append({k: v for k, v in neighbor.items() if k != "literalScore"} | {"score": hit["score"], "matchedBy": ["neighbor"]})
        for hit in hits:
            if len(selected) >= limit:
                break
            if hit["chunkId"] not in selected_ids and selected_pages[hit["pageId"]] < 3:
                selected.append(hit)
                selected_ids.add(hit["chunkId"])
                selected_pages[hit["pageId"]] += 1
        hits = selected
        warnings.append("基于本次召回材料生成，未穷尽全部史料")
    indexed = 0
    for page_id, (layer, digest) in page_sources_expected.items():
        expected = expected_counts[page_id]
        indexed += int(indexed_counts[page_id] == expected and expected > 0)
    failed_pages = set()
    if fingerprint:
        failed_pages = {r["page_id"] for r in connection.execute("SELECT DISTINCT page_id FROM semantic_jobs WHERE model_fingerprint=? AND status='failed'", (fingerprint,)) if r["page_id"] in page_sources_expected}
    total = len(page_sources_expected)
    if active and indexed < total:
        warnings.append(f"语义索引已完成 {indexed}/{total} 页；未完成页面仍参与字面检索")
    # Recheck after remote inference: an edit/delete/visibility change while
    # awaiting the model cannot turn fresh retrieval into stale evidence.
    current_hits = []
    for hit in hits:
        row = connection.execute("""SELECT p.payload FROM document_pages p JOIN documents d ON d.id=p.document_id
          WHERE p.id=? AND d.id=? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
          AND (d.visibility='public' OR d.owner_id=?)""", (hit["pageId"], hit["documentId"], user["id"])).fetchone()
        if row:
            current_text = json.loads(row["payload"]).get(hit["sourceLayer"], "")
            if isinstance(current_text, str) and text_hash(current_text) == hit["sourceHash"]:
                current_hits.append(hit)
    if len(current_hits) != len(hits):
        warnings.append("部分材料在检索时发生变更，已排除，请重新检索获取最新材料")
    hits = current_hits
    return {"hits": hits, "retrievalMode": "hybrid" if vector_top else "literal" if hits else "empty",
            "warnings": warnings, "modelFingerprint": fingerprint,
            "coverage": {"totalPages": total, "indexedPages": indexed, "pendingPages": max(0, total - indexed - len(failed_pages)), "failedPages": len(failed_pages)}}


def validate_evidence(connection, user: dict, evidence: list) -> dict:
    allowed, states = [], []
    for locator in evidence:
        item = locator.model_dump() if hasattr(locator, "model_dump") else locator
        row = connection.execute("""SELECT p.payload FROM document_pages p JOIN documents d ON d.id=p.document_id
          WHERE p.id=? AND d.id=? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
          AND (d.visibility='public' OR d.owner_id=?)""", (item["pageId"], item["documentId"], user["id"])).fetchone()
        if row:
            text = json.loads(row["payload"]).get(item["sourceLayer"], "")
            current_hash = text_hash(text if isinstance(text, str) else "")
            allowed.append(item["chunkId"])
            states.append({"chunkId": item["chunkId"], "sourceHash": current_hash, "historical": current_hash != item["sourceHash"]})
    warnings = ["部分来源已删除或不可见，已从本次材料中移除"] if len(allowed) < len(evidence) else []
    if any(s["historical"] for s in states):
        warnings.append("部分原文已更新，本次重试使用先前保存的材料快照")
    return {"allowedChunkIds": allowed, "sources": states, "warnings": warnings}
