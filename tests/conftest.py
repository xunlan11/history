import json
import sqlite3
from contextlib import contextmanager

import pytest

from service.embedding import ModelIdentity


class FakeEmbedding:
    timeout = 1
    calls = 0
    callback = None

    def describe(self):
        return ModelIdentity("test", "digest-v1", 2)

    def embed_documents(self, texts):
        self.calls += len(texts)
        if self.callback:
            self.callback()
        return [self.vector(text) for text in texts]

    def embed_query(self, text):
        return self.vector(text)

    @staticmethod
    def vector(text):
        return [1.0, 0.0] if any(word in text for word in ("饷", "银", "筹", "经费", "资金")) else [0.0, 1.0]


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("PROCESSING_SCHEDULER_ENABLED", "false")
    monkeypatch.setenv("SEMANTIC_SEARCH_ENABLED", "false")
    monkeypatch.setenv("INITIAL_ADMIN_USERNAME", "test-admin")
    monkeypatch.setenv("INITIAL_ADMIN_PASSWORD", "test-only-password")
    from service import data
    monkeypatch.setattr(data, "DB_PATH", tmp_path / "test.db")
    with data.database() as connection:
        pass
    return data


@pytest.fixture
def embed():
    return FakeEmbedding()


def put_document(db, document_id="d1", text="筹集饷银，以供军需。", owner=1, visibility="private", **layers):
    document = {"id": document_id, "title": document_id, "visibility": visibility,
                "pages": [{"id": document_id + "p1", "pageNumber": 1, "punctuatedText": text, **layers}]}
    with db.database() as connection, connection:
        if owner != 1:
            connection.execute("INSERT OR IGNORE INTO users(id,username,password_hash,is_admin,created_at) VALUES(?,?,?,0,'now')", (owner, f"user{owner}", "test"))
        db.upsert_documents(connection, [document], "now", {"id": owner})
    return document

@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    import urllib.request
    def forbidden(*args, **kwargs):
        raise AssertionError("Offline test attempted an unmocked network request")
    monkeypatch.setattr(urllib.request, "urlopen", forbidden)
