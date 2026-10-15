import pytest

from conftest import put_document
from service.retrieval import retrieve, validate_evidence
from service.retrieval_types import RetrievalRequest
from service.retrieval_worker import SemanticWorker


def query(db, embed, **kwargs):
    with db.database() as connection:
        return retrieve(connection, {"id": 1}, RetrievalRequest(query="如何解决军队经费", **kwargs), embed, enabled=True)


def test_schema9_initializes_and_8_is_rejected(db):
    with db.database() as connection:
        db.ensure_schema(connection)
        assert db.SCHEMA_VERSION == 9
        connection.execute("UPDATE app_meta SET value='8' WHERE key='schema_version'")
        connection.commit()
    with pytest.raises(RuntimeError, match="unsupported"):
        db.connect()


def test_scope_null_empty_selected_are_distinct(db, embed):
    put_document(db)
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    worker.run_once()
    assert query(db, embed, documentIds=[])['hits'] == []
    assert query(db, embed, documentIds=["unknown"])['hits'] == []
    assert query(db, embed)['hits'][0]['documentId'] == 'd1'


def test_private_and_deleted_pages_never_reach_candidates(db, embed):
    put_document(db, "private", owner=2)
    put_document(db, "public", owner=2, visibility="public")
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    while worker.run_once():
        pass
    result = query(db, embed)
    assert {h['documentId'] for h in result['hits']} == {'public'}
    with db.database() as connection, connection:
        connection.execute("UPDATE documents SET visibility='private' WHERE id='public'")
    assert query(db, embed)['hits'] == []


def test_processed_scope_excludes_raw_ocr(db, embed):
    put_document(db, text="", ocrText="筹集饷银")
    assert query(db, embed, textPolicy="processed")['hits'] == []


def test_unindexed_page_participates_in_literal_retrieval(db, embed):
    put_document(db, text="筹集军队经费")
    result = query(db, embed)
    assert result['hits']
    assert result['coverage']['pendingPages'] == 1
    assert result['retrievalMode'] == 'literal'


def test_snapshot_validates_permissions_and_changed_text(db, embed):
    put_document(db, text="筹集军队经费", visibility="public", owner=2)
    hit = query(db, embed)['hits'][0]
    put_document(db, text="新的军队经费", visibility="public", owner=2)
    with db.database() as connection:
        validated = validate_evidence(connection, {"id": 1}, [hit])
        assert validated['sources'][0]['historical']
    with db.database() as connection, connection:
        connection.execute("UPDATE documents SET visibility='private'")
        assert validate_evidence(connection, {"id": 1}, [hit])['allowedChunkIds'] == []


def test_semantic_query_without_literal_overlap(db, embed):
    put_document(db)
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    assert worker.run_once()
    result = query(db, embed)
    assert result['hits'][0]['matchedBy'] == ['semantic']
    assert result['coverage']['indexedPages'] == 1


def test_unrelated_semantic_vector_does_not_fill_results(db, embed):
    put_document(db)
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    worker.run_once()
    with db.database() as connection:
        result = retrieve(connection, {"id":1}, RetrievalRequest(query='海洋气候'), embed, enabled=True)
    assert result['hits'] == []


def test_visibility_change_during_inference_excludes_literal_and_semantic(db, embed):
    put_document(db, text='筹饷军队经费', owner=2, visibility='public')
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    worker.run_once()
    def change_access(text):
        with db.database() as connection, connection:
            connection.execute("UPDATE documents SET visibility='private'")
        return [1.0, 0.0]
    embed.embed_query = change_access
    assert query(db, embed)['hits'] == []
