import json

from conftest import put_document
from service import llm
from service.retrieval import retrieve
from service.retrieval_types import RetrievalRequest
from service.retrieval_worker import SemanticWorker


def test_library_to_all_modes_to_revision_and_deletion(db, embed, monkeypatch):
    put_document(db, text="民国二年六月，筹集饷银以供军需。")
    worker = SemanticWorker(db.database, embed, pause_when_processing=False)
    worker.run_once()
    with db.database() as connection:
        result = retrieve(connection, {"id":1}, RetrievalRequest(query="经费", mode='chronicle'), embed, enabled=True)
    evidence = result['hits']
    hit = evidence[0]
    cited = {"chunkId": hit['chunkId'], "quote": "筹集饷银以供军需"}
    model_outputs = iter([
        {"matches": [cited, {"chunkId": "fake", "quote": "编造"}]},
        {"claims": [{"text": "材料记载筹饷供军需", "sources": [cited]}]},
        {"entries": [{"dateOriginal": "民国二年六月", "eraName": "民国", "eraYear": 2, "month": 6, "summary": "筹饷", "sources": [cited]}]},
    ])
    calls = []
    def generate(messages, **kwargs):
        calls.append(kwargs)
        return json.dumps(next(model_outputs), ensure_ascii=False)
    monkeypatch.setattr(llm, 'call_chat_completion', generate)
    monkeypatch.setenv('LLM_CONTEXT_TOKENS', '8192')
    search = llm.search(llm.SearchRequest(query='经费', evidence=evidence))
    assert search['ready'] and len(search['matches']) == 1
    chat = llm.chat(llm.ChatRequest(prompt='经费', evidence=evidence))
    assert chat['sources'][0]['pageId'] == hit['pageId']
    chronicle = llm.chronicle(llm.ChronicleRequest(topic='经费', evidence=evidence))
    assert chronicle['entries'][0]['dateGregorian'].startswith('1913')
    assert calls[0]['context_tokens'] == 8192
    assert calls[0]['output_tokens'] == 1024
    # An edit removes the previous projection atomically; the next index scan repairs it.
    put_document(db, text="校改后的筹饷记录")
    with db.database() as connection:
        assert connection.execute('SELECT count(*) FROM semantic_vectors').fetchone()[0] == 0
    worker.scan(embed.describe())
    worker.run_once()
    with db.database() as connection, connection:
        db.soft_delete_entities(connection, 'documents', ['d1'], 'later', {"id":1})
    with db.database() as connection:
        assert retrieve(connection, {"id":1}, RetrievalRequest(query='经费'), embed, enabled=True)['hits'] == []


def test_no_evidence_never_calls_model(monkeypatch):
    monkeypatch.setattr(llm, 'call_chat_completion', lambda *a, **k: (_ for _ in ()).throw(AssertionError('network/model must not be called')))
    result = llm.chat(llm.ChatRequest(prompt='经费'))
    assert result['ready']
    assert result['answer'] == '当前材料不足以确认。'
