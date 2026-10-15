import pytest

from service.evidence import BudgetConfig, EvidenceError, fit_prompt_budget, validate_result_citations


EVIDENCE = [{"chunkId": "c", "documentId": "d", "pageId": "p", "sourceType": "document-page", "sourceLayer": "punctuatedText", "sourceHash": "hash", "start": 0, "end": 7, "text": "筹集饷银以供军需。"}]


def test_unknown_or_fabricated_quote_rejected():
    result = validate_result_citations({"matches": [{"chunkId": "bad", "quote": "筹集"}, {"chunkId": "c", "quote": "不在原文"}]}, EVIDENCE, 'search')
    assert result['matches'] == []
    assert result['warnings']


def test_identity_restored_from_evidence():
    result = validate_result_citations({"matches": [{"chunkId": "c", "quote": "筹集饷银", "documentId": "fabricated"}]}, EVIDENCE, 'search')
    assert result['matches'][0]['documentId'] == 'd'
    assert result['matches'][0]['start'] == 0


def test_unbacked_claim_is_removed():
    result = validate_result_citations({"claims": [{"text": "虚构", "sources": []}, {"text": "筹饷供军需", "sources": [{"chunkId": "c", "quote": "筹集饷银"}]}]}, EVIDENCE, 'chat')
    assert '虚构' not in result['answer']
    assert result['sources'][0]['chunkId'] == 'c'


def test_note_cannot_establish_chronicle_event():
    evidence = [EVIDENCE[0] | {"sourceLayer": "notes"}]
    result = validate_result_citations({"entries": [{"summary": "事件", "sources": [{"chunkId": "c", "quote": "筹集"}]}]}, evidence, 'chronicle')
    assert result['entries'] == []


def test_budget_includes_history_and_attachments():
    evidence = EVIDENCE + [{"chunkId": "a", "sourceType": "conversation-file", "text": "附件" * 3000}]
    result = fit_prompt_budget("军需", "chat", evidence, [{"prompt": "旧问题" * 5000}], BudgetConfig())
    assert result.history == []
    assert result.evidence == EVIDENCE
    assert result.input_tokens <= 4096 - 1024 - 256


def test_fixed_prompt_over_budget_fails():
    with pytest.raises(EvidenceError, match="固定提示词"):
        fit_prompt_budget("军" * 2000, "chat", EVIDENCE, [], BudgetConfig(context_tokens=2000))


def test_chronicle_date_must_appear_in_cited_evidence():
    result = validate_result_citations({"entries": [{"dateOriginal": "民国五年", "summary": "日期编造", "sources": [{"chunkId": "c", "quote": "筹集"}]}]}, EVIDENCE, 'chronicle')
    assert result['entries'] == []
