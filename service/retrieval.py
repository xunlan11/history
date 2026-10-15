"""Permission-first hybrid retrieval with lossless evidence anchors."""
from __future__ import annotations

import heapq
import json
import logging
import os
import re
from collections import Counter

from service.embedding import EmbeddingError, semantic_enabled
from service.retrieval_chunks import chunk_source, page_sources, select_page_source
from service.retrieval_types import RetrievalRequest
from service.variant import to_simplified

logger = logging.getLogger(__name__)


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
            from service.retrieval_chunks import text_hash
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
            from service.retrieval_chunks import text_hash
            text = json.loads(row["payload"]).get(item["sourceLayer"], "")
            current_hash = text_hash(text if isinstance(text, str) else "")
            allowed.append(item["chunkId"])
            states.append({"chunkId": item["chunkId"], "sourceHash": current_hash, "historical": current_hash != item["sourceHash"]})
    warnings = ["部分来源已删除或不可见，已从本次材料中移除"] if len(allowed) < len(evidence) else []
    if any(s["historical"] for s in states):
        warnings.append("部分原文已更新，本次重试使用先前保存的材料快照")
    return {"allowedChunkIds": allowed, "sources": states, "warnings": warnings}
