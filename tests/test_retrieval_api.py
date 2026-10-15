import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from conftest import put_document
from service.retrieval_types import EvidenceValidationRequest, RetrievalRequest


def test_query_endpoint_requires_login(db):
    token = db._current_user.set(None)
    try:
        with pytest.raises(HTTPException) as caught:
            db.query_retrieval(RetrievalRequest(query="军饷"))
        assert caught.value.status_code == 401
    finally:
        db._current_user.reset(token)


@pytest.mark.parametrize('kwargs', [{"query":"  "}, {"query":"字"*2001}, {"query":"问题","limit":41}, {"query":"问题","limit":0}])
def test_query_validation(kwargs):
    with pytest.raises(ValidationError):
        RetrievalRequest(**kwargs)


def test_query_and_validate_use_current_user(db, embed, monkeypatch):
    put_document(db, text="军饷")
    monkeypatch.setattr(db, '_embedding_client', embed)
    token = db._current_user.set({"id": 1})
    try:
        result = db.query_retrieval(RetrievalRequest(query="军饷"))
        evidence = [{key: hit[key] for key in ('chunkId','documentId','pageId','sourceLayer','sourceHash')} for hit in result['hits']]
        validated = db.validate_retrieval(EvidenceValidationRequest(evidence=evidence))
        assert validated['allowedChunkIds']
    finally:
        db._current_user.reset(token)


def test_cli_status_rebuild_retry_do_not_call_services(db, monkeypatch, capsys):
    from argparse import Namespace
    from scripts import semantic_index
    from conftest import put_document
    put_document(db)
    args = Namespace(document=None)
    semantic_index.status(db, args)
    semantic_index.retry(db, args)
    semantic_index.rebuild(db, args)
    assert 'schemaVersion' in capsys.readouterr().out
    with db.database() as connection:
        assert connection.execute('SELECT count(*) FROM document_pages').fetchone()[0] == 1


def test_evaluation_refuses_literal_fallback_as_semantic_result(db, embed, monkeypatch, tmp_path):
    import json
    from argparse import Namespace
    from scripts import semantic_index
    from service import embedding
    from service.retrieval_worker import SemanticWorker
    put_document(db)
    cases = tmp_path / 'cases.json'
    cases.write_text(json.dumps([{'id':'one','query':'经费','expectedPageIds':['d1p1']}]),encoding='utf-8')
    args = Namespace(cases=str(cases),output=str(tmp_path/'report.json'),user_id=1)
    monkeypatch.setattr(embedding,'EmbeddingClient',lambda: embed)
    with pytest.raises(RuntimeError,match='索引尚未完成'):
        semantic_index.evaluate(db,args)
    worker = SemanticWorker(db.database,embed,pause_when_processing=False)
    worker.run_once()
    semantic_index.evaluate(db,args)
    report=json.loads((tmp_path/'report.json').read_text(encoding='utf-8'))
    assert report['summary']['hybrid']['recallAt10'] == 1
    assert report['summary']['literal']['recallAt10'] == 0


def test_embedding_health_endpoint_is_independent_of_login_and_generation(db, monkeypatch):
    expected = {"status": "ok", "ready": False, "healthState": "not_ready"}
    monkeypatch.setattr(db, "probe_embedding_health", lambda: expected)
    token = db._current_user.set(None)
    try:
        assert db.embedding_health() == expected
        assert any(route.path == "/api/embedding/health" and "GET" in route.methods for route in db.app.routes)
    finally:
        db._current_user.reset(token)
