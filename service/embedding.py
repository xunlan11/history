"""Ollama embeddings, separate from generation configuration and credentials."""
from __future__ import annotations

import hashlib
import json
import math
import os
import socket
import threading
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass

from service.retrieval_types import CHUNKER_VERSION


DEFAULT_EMBEDDING_MODEL = "qwen3-embedding:0.6b-q8_0"
DEFAULT_QUERY_PREFIX = (
    "Instruct: Given a question about historical documents, retrieve relevant passages "
    "that answer the question\nQuery: "
)


class EmbeddingError(RuntimeError):
    pass


class EmbeddingUnavailable(EmbeddingError):
    pass


@dataclass(frozen=True)
class ModelIdentity:
    model: str
    digest: str
    dimensions: int
    documentPrefix: str = ""
    queryPrefix: str = ""
    provider: str = "ollama"
    chunkerVersion: str = CHUNKER_VERSION

    @property
    def fingerprint(self) -> str:
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def to_dict(self) -> dict:
        return asdict(self) | {"fingerprint": self.fingerprint}


def normalize_vector(values, dimensions: int | None = None) -> list[float]:
    if not isinstance(values, list) or not values or any(isinstance(x, bool) or not isinstance(x, (int, float)) for x in values):
        raise EmbeddingError("嵌入结果不是非空数值向量")
    if dimensions is not None and len(values) != dimensions:
        raise EmbeddingError("嵌入维数与当前模型指纹不符")
    if not all(math.isfinite(x) for x in values):
        raise EmbeddingError("嵌入结果含非有限数值")
    length = math.hypot(*values)
    if not math.isfinite(length) or length <= 0:
        raise EmbeddingError("嵌入结果为零向量或非法范数")
    return [x / length for x in values]


class EmbeddingClient:
    def __init__(self, base: str | None = None, model: str | None = None, timeout: float | None = None):
        self.base = (base if base is not None else os.getenv("EMBEDDING_API_BASE", "http://127.0.0.1:11436")).rstrip("/").removesuffix("/v1")
        self.model = model if model is not None else os.getenv("EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)
        self.timeout = timeout or float(os.getenv("EMBEDDING_TIMEOUT_SECONDS", "60"))
        self.document_prefix = os.getenv("EMBEDDING_DOCUMENT_PREFIX", "")
        self.query_prefix = os.getenv(
            "EMBEDDING_QUERY_PREFIX",
            DEFAULT_QUERY_PREFIX if self.model == DEFAULT_EMBEDDING_MODEL else "",
        )
        self._identity: ModelIdentity | None = None
        self._lock = threading.Lock()

    def _request(self, route: str, payload: dict | None = None):
        if not self.model:
            raise EmbeddingUnavailable("尚未配置 EMBEDDING_MODEL，已使用字面检索")
        headers = {"Content-Type": "application/json"}
        if key := os.getenv("EMBEDDING_API_KEY"):
            headers["Authorization"] = "Bearer " + key
        request = urllib.request.Request(self.base + route, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            kind = EmbeddingUnavailable if exc.code in (404, 408, 429, 500, 502, 503, 504) else EmbeddingError
            raise kind(f"嵌入服务返回 HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
            raise EmbeddingUnavailable("嵌入服务暂不可用") from exc
        except (ValueError, UnicodeError) as exc:
            raise EmbeddingError("嵌入服务未返回有效 JSON") from exc
        if not isinstance(result, dict):
            raise EmbeddingError("嵌入服务返回格式错误")
        if result.get("error"):
            raise EmbeddingError("嵌入服务拒绝输入，请检查模型和长度限制")
        return result

    def _embed(self, texts: list[str], dimensions: int | None = None) -> list[list[float]]:
        if not texts:
            return []
        result = self._request("/api/embed", {"model": self.model, "input": texts, "truncate": False})
        vectors = result.get("embeddings")
        if not isinstance(vectors, list) or len(vectors) != len(texts):
            raise EmbeddingError("嵌入返回数量与输入不一致")
        normalized = [normalize_vector(v, dimensions) for v in vectors]
        if len({len(v) for v in normalized}) != 1:
            raise EmbeddingError("同一批嵌入维数不一致")
        return normalized

    def describe(self) -> ModelIdentity:
        with self._lock:
            tags = self._request("/api/tags")
            if not isinstance(tags.get("models"), list):
                raise EmbeddingError("嵌入服务的模型列表格式无效")
            names = {self.model, self.model + ":latest"} if ":" not in self.model else {self.model}
            model = next((m for m in tags.get("models", []) if isinstance(m, dict) and (m.get("name") in names or m.get("model") in names)), None)
            if not model or not model.get("digest"):
                raise EmbeddingUnavailable("嵌入模型未安装或缺少 digest")
            if self._identity and self._identity.digest == str(model["digest"]):
                return self._identity
            probe = self._embed([self.query_prefix + "向量维数探测"])[0]
            self._identity = ModelIdentity(self.model, str(model["digest"]), len(probe), self.document_prefix, self.query_prefix)
            return self._identity

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        identity = self.describe()
        return self._embed([self.document_prefix + text for text in texts], identity.dimensions)

    def embed_query(self, text: str) -> list[float]:
        identity = self.describe()
        return self._embed([self.query_prefix + text], identity.dimensions)[0]


def probe_embedding_health() -> dict:
    """Check configuration and installed model without loading it or embedding text."""
    client = EmbeddingClient(timeout=3)
    result = {
        "status": "ok", "ready": False, "healthState": "not_ready",
        "provider": "ollama", "model": client.model,
    }
    if not semantic_enabled():
        return result | {"message": "嵌入服务尚未启用。"}
    if not client.model or not client.base:
        return result | {"message": "尚未配置嵌入服务地址或模型。"}
    try:
        tags = client._request("/api/tags")
        if not isinstance(tags.get("models"), list):
            raise EmbeddingError("嵌入服务的模型列表格式无效")
        names = {client.model, client.model + ":latest"} if ":" not in client.model else {client.model}
        model = next((m for m in tags["models"] if isinstance(m, dict)
                      and (m.get("name") in names or m.get("model") in names)), None)
        if not model or not model.get("digest"):
            return result | {"message": "嵌入模型未安装或缺少 digest。"}
        return result | {
            "ready": True, "healthState": "connected",
            "message": f"嵌入服务已连接，当前模型 {client.model}。",
        }
    except EmbeddingUnavailable as exc:
        return result | {"healthState": "unreachable", "message": str(exc)}
    except EmbeddingError as exc:
        return result | {"message": str(exc)}


def semantic_enabled() -> bool:
    return os.getenv("SEMANTIC_SEARCH_ENABLED", "false").lower() in {"1", "true", "yes"}
