import time

from conftest import put_document
from service.embedding import EmbeddingError, EmbeddingUnavailable, ModelIdentity
from service.retrieval_worker import SemanticWorker


def test_unchanged_text_not_reembedded(db, embed):
    put_document(db)
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    assert worker.run_once()
    count = embed.calls
    put_document(db)
    worker.scan(embed.describe())
    assert not worker.run_once()
    assert embed.calls == count


def test_old_job_cannot_publish_after_edit(db, embed):
    put_document(db)
    embed.callback = lambda: put_document(db, text="校改后的筹饷正文")
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    assert worker.run_once()
    with db.database() as connection:
        assert connection.execute('SELECT count(*) FROM semantic_vectors').fetchone()[0] == 0


def test_expired_lease_reclaimed(db, embed):
    put_document(db)
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    worker.scan(embed.describe())
    with db.database() as connection, connection:
        connection.execute("UPDATE semantic_jobs SET status='running',lease_until=?,lease_token='old'", (time.time() - 1,))
    assert worker.run_once()
    with db.database() as connection:
        assert connection.execute('SELECT status FROM semantic_jobs').fetchone()[0] == 'ready'


def test_outage_does_not_consume_attempts(db, embed):
    put_document(db)
    def fail(texts):
        raise EmbeddingUnavailable('offline')
    embed.embed_documents = fail
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    assert worker.run_once()
    with db.database() as connection:
        row = connection.execute('SELECT status,attempts FROM semantic_jobs').fetchone()
        assert tuple(row) == ('waiting', 0)


def test_model_change_uses_new_fingerprint(db, embed):
    put_document(db)
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    worker.run_once()
    embed.describe = lambda: ModelIdentity('test', 'digest-v2', 2)
    worker.scan(embed.describe())
    worker.run_once()
    with db.database() as connection:
        assert connection.execute('SELECT count(DISTINCT model_fingerprint) FROM semantic_vectors').fetchone()[0] == 2


def test_equal_text_layers_share_embedding_computation(db, embed):
    text = '筹饷供军需'
    put_document(db, text=text, cleanText=text)
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    while worker.run_once():
        pass
    assert embed.calls == 1
    with db.database() as connection:
        assert connection.execute('SELECT count(*) FROM semantic_vectors').fetchone()[0] == 2


def test_invalid_results_fail_after_three_attempts(db, embed):
    put_document(db)
    def fail(texts):
        raise EmbeddingError('bad vector')
    embed.embed_documents = fail
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    for attempt in range(3):
        assert worker.run_once()
        with db.database() as connection, connection:
            connection.execute('UPDATE semantic_jobs SET retry_at=0')
    assert not worker.run_once()
    with db.database() as connection:
        row = connection.execute('SELECT status,attempts FROM semantic_jobs').fetchone()
        assert tuple(row) == ('failed', 3)


def test_live_lease_cannot_be_claimed_by_other_worker(db, embed):
    from service.retrieval_store import claim_job
    put_document(db)
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    worker.scan(embed.describe())
    with db.database() as connection:
        first = claim_job(connection, embed.describe().fingerprint, 300, 'one')
    with db.database() as connection:
        second = claim_job(connection, embed.describe().fingerprint, 300, 'two')
    assert first and second is None
