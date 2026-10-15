"""Lossless, page-local chunking. Offsets are Unicode code points, not UTF-16."""
from __future__ import annotations

import hashlib
import json
import re

from service.retrieval_types import CHUNKER_VERSION, Chunk, SourceText, TextPolicy


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
