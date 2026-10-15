"""Offline-capable index administration. Never starts an HTTP service.

status/rebuild/retry only access the selected SQLite database. run/evaluate
explicitly use the configured embedding endpoint, and belong on the data host.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def dump(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def index_scope(connection, document_id):
    return (" WHERE page_id IN (SELECT id FROM document_pages WHERE document_id=?)", (document_id,)) if document_id else ("", ())


def status(data, args):
    with data.database() as connection:
        where, params = index_scope(connection, args.document)
        sources = connection.execute("SELECT count(DISTINCT page_id) FROM semantic_sources" + where, params).fetchone()[0]
        chunks = connection.execute("SELECT count(*) FROM semantic_chunks" + where, params).fetchone()[0]
        jobs = dict(connection.execute("SELECT status,count(*) FROM semantic_jobs" + where + " GROUP BY status", params))
        models = [json.loads(r[0]) for r in connection.execute("SELECT payload FROM semantic_models ORDER BY created_at")]
    dump({"schemaVersion": data.SCHEMA_VERSION, "pages": sources, "chunks": chunks, "jobs": jobs, "models": models})


def rebuild(data, args):
    with data.database() as connection, connection:
        where, params = index_scope(connection, args.document)
        connection.execute("DELETE FROM semantic_vectors WHERE chunk_id IN (SELECT chunk_id FROM semantic_chunks" + where + ")", params)
        connection.execute("DELETE FROM semantic_jobs" + where, params)
    dump({"ok": True, "message": "已清除选定范围的派生向量；后台扫描将重建，正文未修改"})


def retry(data, args):
    with data.database() as connection, connection:
        where, params = index_scope(connection, args.document)
        cursor = connection.execute("UPDATE semantic_jobs SET status='pending',attempts=0,retry_at=0,error=''" + where + (" AND " if where else " WHERE ") + "status IN ('failed','waiting')", params)
    dump({"ok": True, "resetJobs": cursor.rowcount})


def run(data, args):
    from service.embedding import EmbeddingClient
    from service.retrieval_worker import SemanticWorker
    worker = SemanticWorker(data.database, EmbeddingClient(), pause_when_processing=True)
    worker.scan(worker.client.describe())
    processed = 0
    while worker.run_once():
        processed += 1
        if args.once:
            break
    dump({"processedJobs": processed})


def evaluate(data, args):
    from service.embedding import EmbeddingClient
    from service.retrieval import retrieve
    from service.retrieval_types import RetrievalRequest
    cases = json.loads(Path(args.cases).read_text(encoding="utf-8-sig"))
    if isinstance(cases, dict):
        cases = cases["cases"]
    client = EmbeddingClient()
    # Fails explicitly when the real embedding service is unavailable; do not
    # silently label a literal-vs-literal comparison as a semantic evaluation.
    identity = client.describe()
    report = {"model": identity.to_dict(), "cases": [], "note": "输入语料必须已经录入并完成索引；合成样例不代表历史事实或生产效果"}
    totals = {"literal": [], "hybrid": []}
    for case in cases:
        expected = set(case["expectedPageIds"])
        item = {"id": case["id"], "expectedPageIds": sorted(expected)}
        for name, enabled in (("literal", False), ("hybrid", True)):
            request = RetrievalRequest(query=case["query"], mode="search", documentIds=case.get("documentIds"), limit=10)
            started = time.perf_counter()
            with data.database() as connection:
                result = retrieve(connection, {"id": args.user_id}, request, client, enabled=enabled)
            if enabled and result["coverage"]["indexedPages"] < result["coverage"]["totalPages"]:
                raise RuntimeError("当前模型的语义索引尚未完成，不能将字面降级结果当作语义评测")
            if expected and result["coverage"]["totalPages"] == 0:
                raise RuntimeError("标注的文献范围不存在、不可见或没有可用正文")
            pages = list(dict.fromkeys(h["pageId"] for h in result["hits"]))
            recall = len(expected.intersection(pages)) / len(expected) if expected else None
            mrr = next((1 / (i + 1) for i, p in enumerate(pages) if p in expected), 0.0) if expected else None
            metric = {"recallAt10": recall, "mrrAt10": mrr, "noEvidenceCorrect": not pages if not expected else None,
                      "latencyMs": round((time.perf_counter() - started) * 1000, 2), "retrievalMode": result["retrievalMode"],
                      "returnedPageIds": pages, "warnings": result["warnings"]}
            totals[name].append(metric)
            item[name] = metric
        report["cases"].append(item)
    report["summary"] = {}
    for name, metrics in totals.items():
        positive = [m for m in metrics if m["recallAt10"] is not None]
        negative = [m for m in metrics if m["noEvidenceCorrect"] is not None]
        report["summary"][name] = {"recallAt10": statistics.mean(m["recallAt10"] for m in positive) if positive else None,
          "mrrAt10": statistics.mean(m["mrrAt10"] for m in positive) if positive else None,
          "noEvidenceAccuracy": statistics.mean(m["noEvidenceCorrect"] for m in negative) if negative else None}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    dump({"output": str(output), "summary": report["summary"]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "rebuild", "retry"):
        item = sub.add_parser(name)
        item.add_argument("--document", help="只操作指定 documentId")
    item = sub.add_parser("run")
    item.add_argument("--once", action="store_true", help="最多处理一个任务")
    item = sub.add_parser("evaluate")
    item.add_argument("--cases", required=True)
    item.add_argument("--output", default="storage/retrieval-evaluation.json")
    item.add_argument("--user-id", type=int, required=True)
    args = parser.parse_args()
    from service import data
    try:
        globals()[args.command](data, args)
    except (ValueError, RuntimeError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
