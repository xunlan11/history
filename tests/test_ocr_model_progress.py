from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from service.ocr_model_progress import (CURRENT, SCOPE, InferenceProgress,
                                        ObservedPredictor, ProgressStore, instrument_pipeline)


def tracker(key="test"):
    store = ProgressStore()
    progress = InferenceProgress(store, key, {})
    progress.start(dict(use_doc_orientation_classify=False, use_doc_unwarping=False,
                        use_region_detection=False, use_textline_orientation=False,
                        use_table_recognition=False))
    return progress, store


def test_text_progress_is_emitted_only_after_each_real_yield():
    progress, store = tracker()
    events = []

    def recognize(images):
        for text in images:
            events.append(text)
            yield {"text": text}

    token = CURRENT.set(progress)
    scope = SCOPE.set("ocr")
    try:
        results = ObservedPredictor(recognize, "text_recognition")(["a", "b", "c"])
        first = next(results)
        assert first == {"text": "a"}
        assert events == ["a"]
        snapshot = store.read("test")
        assert (snapshot["completed"], snapshot["total"]) == (1, 3)
        assert snapshot["unit"] == "文字区域"
        assert 0 < snapshot["percent"] < 100
        assert list(results) == [{"text": "b"}, {"text": "c"}]
        assert store.read("test")["percent"] < 100
        progress.finish()
        assert store.read("test")["percent"] == 100
    finally:
        CURRENT.reset(token)
        SCOPE.reset(scope)


def test_failed_generator_never_completes():
    progress, store = tracker()
    def broken(images):
        yield {"text": "a"}
        raise RuntimeError("model failure")
    token = CURRENT.set(progress)
    scope = SCOPE.set("ocr")
    try:
        with pytest.raises(RuntimeError):
            list(ObservedPredictor(broken, "text_recognition")([1, 2]))
        progress.finish()
        assert store.read("test")["status"] == "failed"
        assert store.read("test")["percent"] < 100
    finally:
        CURRENT.reset(token)
        SCOPE.reset(scope)


def test_empty_page_finishes_skipped_text_steps_without_inventing_regions():
    progress, store = tracker()
    progress.update("layout_detection", 1, 1, "页", finished=True)
    progress.finish_ocr()
    snapshot = store.read("test")
    assert snapshot["completed"] == snapshot["total"] == 0
    assert snapshot["completedSteps"] == 3
    assert snapshot["percent"] < 100


def test_table_ocr_does_not_reset_main_text_counts():
    progress, store = tracker()
    progress.update("text_recognition", 10, 10, "文字区域", finished=True)
    before = store.read("test")
    token = CURRENT.set(progress)
    scope = SCOPE.set("table")
    try:
        assert list(ObservedPredictor(lambda images: iter(images), "text_recognition")([1, 2])) == [1, 2]
        assert store.read("test") == before
    finally:
        CURRENT.reset(token)
        SCOPE.reset(scope)


def test_context_isolation_across_worker_requests():
    def execute(key):
        progress, store = tracker(key)
        token = CURRENT.set(progress)
        try:
            assert CURRENT.get().key == key
            progress.update("layout_detection", 1, 1, finished=True)
            return store.read(key)
        finally:
            CURRENT.reset(token)
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(execute, ["a", "b"]))
    assert all(result["completedSteps"] == 1 for result in results)
    assert CURRENT.get() is None


def test_instrumentation_rejects_unknown_pipeline():
    with pytest.raises(RuntimeError, match="hooks"):
        instrument_pipeline(SimpleNamespace())


def test_store_expires_terminal_entries_but_keeps_active_work():
    store = ProgressStore(ttl=-1)
    store.write("running", status="running", percent=20)
    store.write("completed", status="completed", percent=100)
    assert store.read("running")["percent"] == 20
    assert store.read("completed")["updatedAt"] == 0


def test_store_expires_abandoned_running_entries_by_absolute_age():
    # 请求在写终态之前断掉时，条目不能永久占位。
    store = ProgressStore(max_age=-1)
    store.write("abandoned", status="running", percent=40)
    assert store.read("abandoned")["updatedAt"] == 0


def test_disabled_middleware_leaves_requests_untracked():
    import asyncio
    from service.ocr_model import ProgressMiddleware
    store = ProgressStore()
    async def app(scope, receive, send):
        assert CURRENT.get() is None
        await send({"type": "http.response.start", "status": 200})
        await send({"type": "http.response.body", "body": b"{}"})
    async def send(message): pass
    asyncio.run(ProgressMiddleware(app, store, {}, enabled=False)(dict(type="http", method="POST",
        path="/layout-parsing", headers=[(b"x-ocr-progress-key", b"off")]), None, send))
    assert store.read("off")["updatedAt"] == 0


def test_failed_queued_request_cannot_become_running_again():
    progress, store = tracker()
    progress.fail()
    progress.start({})
    progress.update("layout_detection", 1, 1, finished=True)
    progress.finish()
    assert store.read("test")["status"] == "failed"
    assert store.read("test")["percent"] < 100


def test_middleware_completes_only_after_successful_response_and_resets_context():
    import asyncio
    from service.ocr_model import ProgressMiddleware
    store = ProgressStore()
    async def app(scope, receive, send):
        progress = CURRENT.get()
        assert progress.key == "middleware"
        progress.start(dict(use_doc_orientation_classify=False, use_doc_unwarping=False))
        assert store.read("middleware")["percent"] < 100
        await send({"type": "http.response.start", "status": 200})
        assert store.read("middleware")["percent"] < 100
        await send({"type": "http.response.body", "body": b"{}"})
    async def run():
        messages = []
        async def send(message): messages.append(message)
        await ProgressMiddleware(app, store, {})(dict(type="http", method="POST", path="/layout-parsing",
            headers=[(b"x-ocr-progress-key",b"middleware")]), None, send)
        assert CURRENT.get() is None
        assert len(messages) == 2
    asyncio.run(run())
    assert store.read("middleware")["status"] == "completed"
    assert store.read("middleware")["percent"] == 100


@pytest.mark.parametrize("status", [422, 500])
def test_failed_http_response_never_reports_completion(status):
    import asyncio
    from service.ocr_model import ProgressMiddleware
    store = ProgressStore()
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": status})
        await send({"type": "http.response.body", "body": b"{}"})
    async def send(message): pass
    asyncio.run(ProgressMiddleware(app, store, {})(dict(type="http", method="POST", path="/layout-parsing",
        headers=[(b"x-ocr-progress-key",b"error")]), None, send))
    assert store.read("error")["status"] == "failed"
    assert store.read("error")["percent"] < 100
