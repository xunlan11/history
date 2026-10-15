import sqlite3

import pytest

from service.retrieval_chunks import chunk_source, select_page_source
from service.retrieval_store import ensure_schema


def test_source_policy_and_whitespace():
    page = {"id": "p", "ocrText": "原文", "cleanText": "校对", "punctuatedText": "标点。"}
    assert select_page_source(page, "primary").text == "标点。"
    assert select_page_source(page, "processed").text == "校对"
    assert select_page_source({"id": "p", "ocrText": "原文"}, "processed") is None
    assert select_page_source({"id": "p", "cleanText": "  ", "ocrText": "原文"}, "primary").text == "原文"


@pytest.mark.parametrize("text", ["第一段。\n\n第二段。", "𠀀军饷。" * 400, "军" * 2001, "甲\n乙\n丙。" * 400])
def test_chunks_preserve_exact_offsets(text):
    source = select_page_source({"id": "p", "punctuatedText": text}, "primary", "d")
    chunks = chunk_source(source)
    covered = set()
    for chunk in chunks:
        assert chunk.text == text[chunk.start:chunk.end]
        assert 0 < len(chunk.text) <= 800
        covered.update(range(chunk.start, chunk.end))
    assert covered == set(range(len(text)))
    assert [c.chunkId for c in chunks] == [c.chunkId for c in chunk_source(source)]


def test_semantic_schema_is_idempotent():
    connection = sqlite3.connect(":memory:")
    ensure_schema(connection)
    ensure_schema(connection)
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"semantic_models", "semantic_sources", "semantic_chunks", "semantic_vectors", "semantic_jobs"} <= tables
