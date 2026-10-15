import pytest

from service.embedding import EmbeddingClient, EmbeddingError, ModelIdentity, normalize_vector


@pytest.mark.parametrize("values", [[], [0, 0], [float("nan"), 1], [float("inf")], [True, 1], ["1"]])
def test_invalid_vector_rejected(values):
    with pytest.raises(EmbeddingError):
        normalize_vector(values)


def test_batch_preserves_order_and_disables_truncation(monkeypatch):
    client = EmbeddingClient(model="test")
    identity = ModelIdentity("test", "digest", 2)
    monkeypatch.setattr(client, "describe", lambda: identity)
    calls = []
    def request(route, payload):
        calls.append(payload)
        return {"embeddings": [[3, 4], [0, 2]]}
    monkeypatch.setattr(client, "_request", request)
    assert client.embed_documents(["甲", "乙"]) == [[0.6, 0.8], [0, 1]]
    assert calls[0]["truncate"] is False


def test_dimension_change_rejected():
    with pytest.raises(EmbeddingError):
        normalize_vector([1, 2, 3], 2)


def test_model_fingerprint_includes_digest_and_templates():
    a = ModelIdentity("test", "a", 2)
    assert a.fingerprint != ModelIdentity("test", "b", 2).fingerprint
    assert a.fingerprint != ModelIdentity("test", "a", 2, queryPrefix="query: ").fingerprint


def test_selected_qwen_model_formats_queries_without_changing_documents(monkeypatch):
    for name in ("EMBEDDING_MODEL", "EMBEDDING_QUERY_PREFIX", "EMBEDDING_DOCUMENT_PREFIX"):
        monkeypatch.delenv(name, raising=False)
    client = EmbeddingClient()
    assert client.model == "qwen3-embedding:0.6b-q8_0"
    calls = []
    def request(route, payload=None):
        if route == "/api/tags":
            return {"models": [{"name": client.model, "digest": "qwen-digest"}]}
        calls.append(payload)
        return {"embeddings": [[3, 4] for _ in payload["input"]]}
    monkeypatch.setattr(client, "_request", request)
    client.embed_documents(["筹集饷银。"])
    client.embed_query("军费来源？")
    assert calls[-2]["input"] == ["筹集饷银。"]
    assert calls[-1]["input"] == [
        "Instruct: Given a question about historical documents, retrieve relevant passages "
        "that answer the question\nQuery: 军费来源？"
    ]
    assert client.describe().queryPrefix == client.query_prefix


def test_model_override_does_not_inherit_qwen_instructions(monkeypatch):
    monkeypatch.setenv("EMBEDDING_MODEL", "another-embedding:model")
    monkeypatch.delenv("EMBEDDING_QUERY_PREFIX", raising=False)
    assert EmbeddingClient().query_prefix == ""


def test_explicit_empty_query_prefix_disables_default(monkeypatch):
    monkeypatch.delenv("EMBEDDING_MODEL", raising=False)
    monkeypatch.setenv("EMBEDDING_QUERY_PREFIX", "")
    assert EmbeddingClient().query_prefix == ""


@pytest.mark.parametrize("enabled,model", [("false", "test"), ("true", "")])
def test_embedding_health_unconfigured_does_not_contact_upstream(monkeypatch, enabled, model):
    from service.embedding import probe_embedding_health
    monkeypatch.setenv("SEMANTIC_SEARCH_ENABLED", enabled)
    monkeypatch.setenv("EMBEDDING_MODEL", model)
    result = probe_embedding_health()
    assert result["ready"] is False
    assert result["healthState"] == "not_ready"


@pytest.mark.parametrize("tags,expected", [
    ({"models": [{"name": "test:latest", "digest": "digest"}]}, "connected"),
    ({"models": [{"name": "qwen3:8b", "digest": "generation-digest"}]}, "not_ready"),
    ({"models": [{"name": "test:latest"}]}, "not_ready"),
    ({"models": []}, "not_ready"),
    ({"models": "invalid"}, "not_ready"),
])
def test_embedding_health_checks_only_its_model_without_inference(monkeypatch, tags, expected):
    from service.embedding import probe_embedding_health
    monkeypatch.setenv("SEMANTIC_SEARCH_ENABLED", "true")
    monkeypatch.setenv("EMBEDDING_MODEL", "test")
    def request(self, route, payload=None):
        assert route == "/api/tags"
        assert payload is None
        assert self.timeout == 3
        return tags
    monkeypatch.setattr(EmbeddingClient, "_request", request)
    result = probe_embedding_health()
    assert result["healthState"] == expected
    assert result["ready"] is (expected == "connected")


@pytest.mark.parametrize("kind,expected", [("unavailable", "unreachable"), ("invalid", "not_ready")])
def test_embedding_health_classifies_upstream_errors(monkeypatch, kind, expected):
    from service.embedding import EmbeddingUnavailable, probe_embedding_health
    monkeypatch.setenv("SEMANTIC_SEARCH_ENABLED", "true")
    monkeypatch.setenv("EMBEDDING_MODEL", "test")
    def request(*args, **kwargs):
        raise EmbeddingUnavailable("offline") if kind == "unavailable" else EmbeddingError("invalid")
    monkeypatch.setattr(EmbeddingClient, "_request", request)
    result = probe_embedding_health()
    assert result["ready"] is False
    assert result["healthState"] == expected
