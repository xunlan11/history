import copy
import json
import sqlite3
from types import SimpleNamespace

import numpy as np
import pytest
from pydantic import ValidationError

from service import retrieval
from service.retrieval_types import (
    EvidenceLocator, EvidenceValidationRequest, RetrievalRequest,
    parse_visual_source_layer, visual_source_layer,
)


@pytest.fixture
def db():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript("""
        CREATE TABLE users(id TEXT PRIMARY KEY, deleted_at TEXT);
        CREATE TABLE documents(id TEXT PRIMARY KEY, owner_id TEXT, visibility TEXT,
                               deleted_at TEXT, payload TEXT, sort_order INTEGER);
        CREATE TABLE document_pages(id TEXT PRIMARY KEY, document_id TEXT,
                                    page_number INTEGER, deleted_at TEXT, payload TEXT);
        INSERT INTO users VALUES('u', NULL), ('other', NULL);
    """)
    retrieval.ensure_schema(connection)
    yield connection
    connection.close()


def visual_page(**layers):
    return {"id": "p", **layers, "visuals": [{
        "id": "figure:一/%", "kind": "table", "renderMode": "html",
        "captions": [{"id": "caption:1/%", "text": "😀军队驻扎。"}],
        "tableModel": {"rows": 1, "columns": 1, "cells": [
            {"id": "cell:1/%", "row": 0, "column": 0, "text": "  军队到达。\n"},
        ]},
        "code": "RAW_TABLE_CODE_ONLY", "html": "RAW_TABLE_HTML_ONLY",
    }]}


def add_page(db, page, *, page_id="p", document_id="d", owner="u", visibility="private"):
    page = copy.deepcopy(page)
    page["id"] = page_id
    db.execute("INSERT OR IGNORE INTO documents VALUES(?,?,?,NULL,?,0)",
               (document_id, owner, visibility, json.dumps({"title": "测试史料"})))
    db.execute("INSERT INTO document_pages VALUES(?,?,1,NULL,?)",
               (page_id, document_id, json.dumps(page, ensure_ascii=False)))
    retrieval.reconcile_page(db, document_id, page, "now")
    return page


def replace_page(db, page, *, reconcile=False):
    db.execute("UPDATE document_pages SET payload=? WHERE id=?",
               (json.dumps(page, ensure_ascii=False), page["id"]))
    if reconcile:
        retrieval.reconcile_page(db, "d", page, "later")


class Embeddings:
    identity = SimpleNamespace(fingerprint="test-model", dimensions=2)

    def describe(self):
        return self.identity

    def embed_query(self, query):
        return [1.0, 0.0]


def query(db, *, text="军队", mode="chat", policy="primary", user="u", client=None, enabled=False, document_ids=None):
    request = RetrievalRequest(query=text, mode=mode, textPolicy=policy,
                               documentIds=["d"] if document_ids is None else document_ids)
    return retrieval.retrieve(db, {"id": user}, request, client or Embeddings(), enabled=enabled)


def test_page_sources_keep_local_text_and_exclude_raw_table_code():
    page = visual_page(ocrText="原始正文", punctuatedText="整理正文", notes="笔记", cleanText="旧正文")
    sources = retrieval.page_sources("d", page)
    assert set(sources) == {"ocrText", "punctuatedText", "notes",
        visual_source_layer("visual_caption", "figure:一/%", "caption:1/%"),
        visual_source_layer("table_cell", "figure:一/%", "cell:1/%")}
    assert {source.text for source in sources.values()} == {
        "原始正文", "整理正文", "笔记", "😀军队驻扎。", "  军队到达。\n"}
    for source in sources.values():
        assert source.sourceHash == retrieval.text_hash(source.text)
        assert (source.documentId, source.pageId) == ("d", "p")


@pytest.mark.parametrize("kind", ["visual_caption", "table_cell"])
def test_visual_identity_encoding_is_collision_free_and_round_trips(kind):
    pairs = [("a:b", "c"), ("a", "b:c"), ("a%3Ab", "c"), ("图/😀 %", "标题:一/二%")]
    layers = [visual_source_layer(kind, *pair) for pair in pairs]
    assert len(set(layers)) == len(pairs)
    key = "captionId" if kind == "visual_caption" else "cellId"
    for layer, (visual_id, item_id) in zip(layers, pairs):
        assert parse_visual_source_layer(layer) == {"visualId": visual_id, key: item_id}
        assert EvidenceLocator(chunkId="c", documentId="d", pageId="p",
                               sourceLayer=layer, sourceHash="hash").sourceLayer == layer


@pytest.mark.parametrize("layer", ["cleanText", "visual_caption", "visual_caption::c",
    "visual_caption:v:", "visual_caption:a:b:c", "table_cell:v:%", "table_cell:v:%FF",
    "visual_caption:a%3ab:c", "table_cell:v:未编码", "unknown:v:c"])
def test_evidence_locator_rejects_unknown_or_noncanonical_visual_layers(layer):
    assert parse_visual_source_layer(layer) is None
    with pytest.raises(ValidationError):
        EvidenceLocator(chunkId="c", documentId="d", pageId="p", sourceLayer=layer, sourceHash="hash")


@pytest.mark.parametrize("mode", ["search", "chat", "reader", "chronicle"])
@pytest.mark.parametrize("policy", ["primary", "processed", "reader"])
def test_visuals_are_retrieved_without_any_body(db, mode, policy):
    page = add_page(db, visual_page(notes="军队笔记。"))
    hits = query(db, mode=mode, policy=policy)["hits"]
    assert len(hits) == 2
    sources = retrieval.page_sources("d", page)
    for hit in hits:
        source = sources[hit["sourceLayer"]]
        assert hit["visualId"] == "figure:一/%"
        assert hit["text"] == source.text[hit["start"]:hit["end"]]
        assert hit["sourceHash"] == source.sourceHash
        if mode != "chronicle":
            assert source.text[hit["matchStart"]:hit["matchEnd"]] == "军队"
        assert (hit.get("captionId"), hit.get("cellId")) in {
            ("caption:1/%", None), (None, "cell:1/%")}
    validated = retrieval.validate_evidence(db, {"id": "u"},
        EvidenceValidationRequest(evidence=hits).evidence)
    assert set(validated["allowedChunkIds"]) == {hit["chunkId"] for hit in hits}
    assert all(not item["historical"] for item in validated["sources"])
    assert validated["warnings"] == []


@pytest.mark.parametrize("mode", ["search", "chat", "reader"])
@pytest.mark.parametrize("policy", ["primary", "processed", "reader"])
def test_duplicate_captions_and_cells_stay_independent_of_selected_body(db, mode, policy):
    page = visual_page(punctuatedText="😀军队驻扎。", ocrText="😀军队驻扎。")
    visual = page["visuals"][0]
    visual["captions"].append({"id": "duplicate", "text": visual["captions"][0]["text"]})
    visual["tableModel"]["cells"][0]["text"] = visual["captions"][0]["text"]
    add_page(db, page)
    hits = query(db, mode=mode, policy=policy)["hits"]
    assert len(hits) == 4
    assert len({hit["chunkId"] for hit in hits}) == 4
    assert len({hit["sourceLayer"] for hit in hits}) == 4
    assert len([hit for hit in hits if hit["sourceLayer"] == "punctuatedText"]) == 1
    assert all(hit["sourceLayer"] != "ocrText" for hit in hits)
    assert {hit["matchStart"] for hit in hits} == {1}


@pytest.mark.parametrize("policy,body_expected", [("primary", True), ("processed", False), ("reader", False)])
def test_visuals_do_not_change_ocr_fallback_policy(db, policy, body_expected):
    page = add_page(db, visual_page(ocrText="军队原始正文。", punctuatedText="  ", notes="军队笔记。"))
    hits = query(db, policy=policy)["hits"]
    assert len(hits) == (4 if body_expected else 2)
    assert ("ocrText" in {hit["sourceLayer"] for hit in hits}) is body_expected
    assert (retrieval.select_page_source(page, policy, "d") is not None) is body_expected


def test_raw_visual_code_and_metadata_are_not_searchable(db):
    add_page(db, visual_page())
    for text in ("RAW_TABLE_CODE_ONLY", "RAW_TABLE_HTML_ONLY", "tableModel", "caption:1/%"):
        assert query(db, text=text)["hits"] == []
    indexed = "\n".join(row["text"] for row in db.execute("SELECT text FROM semantic_chunks"))
    assert "RAW_TABLE" not in indexed


@pytest.mark.parametrize("visuals", [None, "bad", {}, [None, "bad", {}, {"id": ""},
    {"id": "v", "captions": [None, {}, {"id": "c", "text": 7}, {"id": "blank", "text": "  "}],
     "tableModel": {"cells": [None, {"text": "missing id"}]}}]])
def test_malformed_or_empty_visuals_do_not_create_sources(visuals):
    assert retrieval.page_sources("d", {"id": "p", "visuals": visuals}) == {}


def test_visual_chunks_are_retained_but_do_not_schedule_body_jobs(db):
    page = add_page(db, visual_page(punctuatedText="正文。"))
    source_layers = set(retrieval.page_sources("d", page))
    assert {row[0] for row in db.execute("SELECT source_layer FROM semantic_chunks")} == source_layers
    identity = SimpleNamespace(fingerprint="test-model", to_dict=lambda: {"fingerprint": "test-model"})
    retrieval.enqueue_model(db, identity)
    assert {row[0] for row in db.execute("SELECT source_layer FROM semantic_jobs")} == {"punctuatedText"}
    assert {row[0] for row in db.execute("SELECT source_layer FROM semantic_sources")} == {"punctuatedText"}
    # 即使已有辅助向量，也不能改变选定正文的契约。
    vector = np.asarray([0.8, 0.6], dtype="<f4").tobytes()
    for row in db.execute("SELECT chunk_id FROM semantic_chunks").fetchall():
        db.execute("INSERT INTO semantic_vectors VALUES(?,?,?,?)", (row[0], "test-model", 2, vector))
    result = query(db, text="毫不相干的问题", enabled=True)
    assert len(result["hits"]) == 1
    assert result["hits"][0]["sourceLayer"] == "punctuatedText"
    assert result["coverage"]["indexedPages"] == 1


def test_changed_and_removed_visual_sources_are_historical_and_never_fresh_hits(db):
    page = add_page(db, visual_page())
    old_hits = query(db)["hits"]
    for hit in old_hits:
        source = retrieval.get_evidence(db, {"id": "u"}, hit)
        assert source.text == retrieval.page_sources("d", page)[hit["sourceLayer"]].text
        assert source.sourceHash == hit["sourceHash"]
    page["visuals"][0]["captions"][0]["text"] = "海防图注。"
    page["visuals"][0]["tableModel"]["cells"] = []
    replace_page(db, page)  # 过期的语义投影不得提供旧证据。
    assert query(db)["hits"] == []
    validated = retrieval.validate_evidence(db, {"id": "u"}, old_hits)
    assert set(validated["allowedChunkIds"]) == {hit["chunkId"] for hit in old_hits}
    assert all(item["historical"] for item in validated["sources"])
    assert {item["sourceHash"] for item in validated["sources"]} == {
        retrieval.text_hash("海防图注。"), retrieval.text_hash("")}
    assert validated["warnings"]
    fresh = query(db, text="海防")["hits"]
    assert len(fresh) == 1 and fresh[0]["chunkId"] not in {hit["chunkId"] for hit in old_hits}


def test_reconcile_removes_stale_visual_chunks_and_vectors(db):
    page = add_page(db, visual_page())
    old_ids = {row[0] for row in db.execute("SELECT chunk_id FROM semantic_chunks")}
    for chunk_id in old_ids:
        db.execute("INSERT INTO semantic_vectors VALUES(?,?,?,?)", (chunk_id, "test-model", 2, b"old"))
    for source in retrieval.page_sources("d", page).values():
        db.execute("""INSERT INTO semantic_jobs(page_id,source_layer,source_hash,model_fingerprint)
                      VALUES(?,?,?,?)""", ("p", source.sourceLayer, source.sourceHash, "test-model"))
    page["visuals"][0]["captions"][0]["text"] = "新图注。"
    page["visuals"][0]["tableModel"]["cells"] = []
    replace_page(db, page, reconcile=True)
    chunks = db.execute("SELECT * FROM semantic_chunks").fetchall()
    assert len(chunks) == 1 and chunks[0]["text"] == "新图注。"
    assert chunks[0]["chunk_id"] not in old_ids
    assert db.execute("SELECT COUNT(*) FROM semantic_vectors").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM semantic_jobs").fetchone()[0] == 0
    page["visuals"] = []
    replace_page(db, page, reconcile=True)
    assert db.execute("SELECT COUNT(*) FROM semantic_chunks").fetchone()[0] == 0


def test_reordering_and_render_changes_preserve_visual_source_identity(db):
    page = add_page(db, visual_page())
    old_hits = query(db)["hits"]
    visual = page["visuals"][0]
    visual["renderMode"] = "image"
    visual["tableModel"]["cells"][0].update(row=5, column=3)
    page["visuals"].insert(0, {"id": "unrelated", "kind": "image", "captions": []})
    replace_page(db, page, reconcile=True)
    assert query(db)["hits"] == old_hits
    assert all(not state["historical"] for state in
               retrieval.validate_evidence(db, {"id": "u"}, old_hits)["sources"])


def test_copied_pages_use_new_document_and_page_identity(db):
    page = add_page(db, visual_page())
    original = query(db)["hits"]
    copied_page = add_page(db, page, page_id="copied-page", document_id="copied-document")
    copied_page["id"] = "p"  # 数据库标识会覆盖过期的副本 payload ID。
    db.execute("UPDATE document_pages SET payload=? WHERE id='copied-page'", (json.dumps(copied_page),))
    copied = query(db, document_ids=["copied-document"])["hits"]
    assert len(copied) == len(original) == 2
    assert {hit["chunkId"] for hit in copied}.isdisjoint(hit["chunkId"] for hit in original)
    assert {hit["sourceLayer"] for hit in copied} == {hit["sourceLayer"] for hit in original}
    for hit in copied:
        source = retrieval.get_evidence(db, {"id": "u"}, hit)
        assert (source.documentId, source.pageId) == ("copied-document", "copied-page")
        assert source.sourceHash == hit["sourceHash"]
        assert retrieval.get_evidence(db, {"id": "u"}, hit | {"documentId": "d"}) is None


@pytest.mark.parametrize("change", [
    "UPDATE documents SET owner_id='other'",
    "UPDATE documents SET deleted_at='now'",
    "UPDATE document_pages SET deleted_at='now'",
    "UPDATE users SET deleted_at='now' WHERE id='u'",
])
def test_permissions_apply_to_retrieval_and_saved_visual_evidence(db, change):
    add_page(db, visual_page())
    hits = query(db)["hits"]
    assert len(hits) == 2
    db.execute(change)
    assert query(db)["hits"] == []
    assert retrieval.validate_evidence(db, {"id": "u"}, hits)["allowedChunkIds"] == []
    assert all(retrieval.get_evidence(db, {"id": "u"}, hit) is None for hit in hits)


def test_public_visual_sources_and_document_scope(db):
    add_page(db, visual_page(), owner="other", visibility="public")
    assert len(query(db)["hits"]) == 2
    assert query(db, document_ids=[])["hits"] == []
    assert query(db, document_ids=["missing"])["hits"] == []


@pytest.mark.parametrize("change", ["edit", "remove", "permission", "owner_deleted"])
def test_visual_evidence_is_rechecked_after_remote_embedding(db, change):
    page = add_page(db, visual_page())

    class ChangingEmbeddings(Embeddings):
        def embed_query(self, query):
            if change in {"edit", "remove"}:
                if change == "edit":
                    page["visuals"][0]["captions"][0]["text"] = "图注已变更。"
                    page["visuals"][0]["tableModel"]["cells"][0]["text"] = "表格已变更。"
                else:
                    page["visuals"] = []
                replace_page(db, page)
            elif change == "permission":
                db.execute("UPDATE documents SET owner_id='other'")
            else:
                db.execute("UPDATE users SET deleted_at='now' WHERE id='u'")
            return super().embed_query(query)

    result = query(db, client=ChangingEmbeddings(), enabled=True)
    assert result["hits"] == []
    assert result["warnings"]


@pytest.mark.parametrize("document_id", ["d", "new-document"])
def test_copying_to_new_page_rebuilds_stored_and_literal_chunk_ids(db, document_id):
    page = add_page(db, visual_page())
    original = query(db)["hits"]
    add_page(db, page, page_id="new-page", document_id=document_id)
    all_hits = query(db, document_ids=[document_id])["hits"]
    copied = [hit for hit in all_hits if hit["pageId"] == "new-page"]
    assert len(copied) == 2
    assert {hit["chunkId"] for hit in copied}.isdisjoint(hit["chunkId"] for hit in original)
    for hit in copied:
        assert hit["documentId"] == document_id
        assert retrieval.get_evidence(db, {"id": "u"}, hit).pageId == "new-page"
    stored_ids = {row[0] for row in db.execute("SELECT chunk_id FROM semantic_chunks WHERE page_id='p'")}
    copied_ids = {row[0] for row in db.execute("SELECT chunk_id FROM semantic_chunks WHERE page_id='new-page'")}
    assert len(stored_ids) == len(copied_ids) == 2
    assert stored_ids.isdisjoint(copied_ids)


def test_identical_local_ids_in_different_visuals_remain_independent(db):
    page = visual_page()
    other_visual = copy.deepcopy(page["visuals"][0])
    other_visual["id"] = "different-visual"
    page["visuals"].append(other_visual)
    add_page(db, page)
    hits = query(db)["hits"]
    assert len(hits) == 4
    assert len({hit["chunkId"] for hit in hits}) == 4
    assert {hit["visualId"] for hit in hits} == {"figure:一/%", "different-visual"}
    page["visuals"][0]["captions"] = []
    replace_page(db, page, reconcile=True)
    remaining = query(db)["hits"]
    assert len(remaining) == 3
    assert sum(hit.get("captionId") == "caption:1/%" for hit in remaining) == 1


def test_long_visual_sources_keep_all_stored_chunks_and_local_unicode_offsets(db):
    page = visual_page()
    long_text = "😀" + "甲" * 790 + "军队驻扎边境。" + "乙" * 1000
    for item in [page["visuals"][0]["captions"][0], page["visuals"][0]["tableModel"]["cells"][0]]:
        item["text"] = long_text
    page = add_page(db, page)
    for source in retrieval.page_sources("d", page).values():
        chunks = db.execute("SELECT * FROM semantic_chunks WHERE source_layer=? ORDER BY ordinal",
                            (source.sourceLayer,)).fetchall()
        assert len(chunks) > 1
        assert chunks[0]["start"] == 0 and chunks[-1]["end"] == len(long_text)
        for chunk in chunks:
            assert chunk["text"] == long_text[chunk["start"]:chunk["end"]]
    hits = query(db)["hits"]
    assert len(hits) == 2
    assert {hit["matchStart"] for hit in hits} == {791}
    assert {hit["matchEnd"] for hit in hits} == {793}


def test_visual_ids_and_quote_offsets_survive_citation_validation(db):
    from service.evidence import validate_result_citations

    page = add_page(db, visual_page())
    hits = query(db)["hits"]
    result = validate_result_citations({"matches": [
        {"chunkId": hit["chunkId"], "quote": "军队"} for hit in hits
    ]}, hits, "search")
    assert len(result["matches"]) == 2
    sources = retrieval.page_sources("d", page)
    for citation in result["matches"]:
        assert citation["visualId"] == "figure:一/%"
        assert citation.get("captionId") == "caption:1/%" or citation.get("cellId") == "cell:1/%"
        source = sources[citation["sourceLayer"]]
        assert source.text[citation["start"]:citation["end"]] == citation["quote"]


@pytest.mark.parametrize("policy", ["processed", "reader"])
def test_visual_support_preserves_body_and_notes_policy_when_no_visuals_exist(db, policy):
    add_page(db, {"ocrText": "军队原始正文。", "notes": "军队笔记。"})
    assert query(db, policy=policy)["hits"] == []


def test_body_evidence_keeps_existing_whitespace_hash_semantics(db):
    page = add_page(db, {"punctuatedText": "正文。"})
    locator = {"chunkId": "saved-body", "documentId": "d", "pageId": "p",
               "sourceLayer": "punctuatedText", "sourceHash": retrieval.text_hash("正文。")}
    page["punctuatedText"] = "  "
    replace_page(db, page)
    assert retrieval.get_evidence(db, {"id": "u"}, locator).text == "  "
    validated = retrieval.validate_evidence(db, {"id": "u"}, [locator])
    assert validated["sources"] == [{"chunkId": "saved-body", "sourceHash": retrieval.text_hash("  "),
                                      "historical": True}]
