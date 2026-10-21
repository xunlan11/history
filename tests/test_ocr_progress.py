import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import fitz
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from service import ocr, ocr_upstream, scheduler, task_progress


@pytest.fixture(autouse=True)
def isolated_progress(monkeypatch):
    monkeypatch.setattr(task_progress, "_ENTRIES", {})


def test_page_api_reports_real_counts_while_request_is_running(monkeypatch, tmp_path):
    entered, finish = threading.Event(), threading.Event()
    def recognize(path, page_number=None, mode="formal", on_progress=None):
        on_progress(dict(stage="文字识别", percent=67, completed=8, total=24,
                         unit="文字区域", basis="pipeline_steps", status="running"))
        entered.set()
        assert finish.wait(5)
        return {"blocks": [], "lines": []}
    monkeypatch.setattr(ocr_upstream, "recognize_page_image", recognize)
    path = tmp_path / "page.png"
    Image.new("RGB", (100, 100), "white").save(path)
    with TestClient(ocr.app) as client, ThreadPoolExecutor() as executor:
        future = executor.submit(client.post, "/ocr", files={"image": ("p.png", path.read_bytes(), "image/png")},
                                 data={"pageNumber": "3", "progressKey": "body-attempt"})
        try:
            assert entered.wait(5)
            event = client.get("/ocr/progress/body-attempt").json()
            assert event["percent"] == 67
            assert (event["completed"], event["total"], event["unit"]) == (8, 24, "文字区域")
            assert event["status"] == "running"
        finally:
            finish.set()
        response = future.result(timeout=5)
        assert response.status_code == 200, response.text
        assert response.json()["pageNumber"] == 3
        assert client.get("/ocr/progress/body-attempt").json()["percent"] == 100


def test_failed_retry_resets_previous_finished_progress(monkeypatch, tmp_path):
    task_progress.set_progress("retry", 100, status="completed", completed=99)
    def recognize(*args, **kwargs):
        assert task_progress.read_progress("retry")["percent"] == 0
        raise ocr_upstream.OcrUpstreamUnavailable("offline")
    monkeypatch.setattr(ocr_upstream, "recognize_page_image", recognize)
    path = tmp_path / "page.png"
    Image.new("RGB", (10, 10)).save(path)
    with TestClient(ocr.app) as client:
        response = client.post("/ocr", files={"image": ("p.png", path.read_bytes())}, data={"progressKey": "retry"})
        assert response.status_code == 503
        event = client.get("/ocr/progress/retry").json()
        assert event["percent"] == 0
        assert event["status"] == "failed"
        assert "completed" not in event


def test_registration_scanned_pages_include_page_internal_counts(monkeypatch, tmp_path):
    path = tmp_path / "mixed.pdf"
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((60, 60), "Existing text layer")
        pdf.new_page()
        pdf.new_page()
        pdf.save(path)
    calls, events = [], []
    def recognize(path, page_number=None, quick_read=False, on_progress=None):
        calls.append(page_number)
        assert quick_read
        on_progress(dict(stage="文字识别", percent=50, completed=2, total=4, unit="文字区域", status="running"))
        on_progress(dict(stage="已完成", percent=100, status="completed"))
        return {"text": f"scanned {page_number}"}
    monkeypatch.setattr(ocr, "recognize_image", recognize)
    result = ocr.build_metadata_candidate(path, events.append)
    assert calls == [2, 3]
    assert result["pagesRead"] == 3
    assert "Existing text layer" in result["text"]
    event = next(e for e in events if e.get("pageNumber") == 2 and e.get("completed") == 2)
    assert event["percent"] == 50  # (one finished page + half of page 2) / three pages
    assert event["pagePercent"] == 50
    assert event["pageTotal"] == 3
    assert [e["percent"] for e in events] == sorted(e["percent"] for e in events)
    assert events[-1]["percent"] == 100


def test_registration_image_forwards_counts(monkeypatch, tmp_path):
    events = []
    def recognize(path, **kwargs):
        kwargs["on_progress"](dict(stage="文字识别", percent=60, completed=8, total=16, unit="文字区域"))
        return {"text": "candidate"}
    monkeypatch.setattr(ocr, "recognize_image", recognize)
    assert ocr.build_metadata_candidate(tmp_path / "image.png", events.append)["text"] == "candidate"
    assert events[0]["percent"] == 60
    assert events[0]["pageNumber"] == events[0]["pageTotal"] == 1
    assert events[0]["completed"] == 8


def test_text_layer_registration_does_not_invoke_ocr(monkeypatch, tmp_path):
    path = tmp_path / "text.pdf"
    with fitz.open() as pdf:
        for index in range(4):
            pdf.new_page().insert_text((60, 60), f"Text page {index + 1}")
        pdf.save(path)
    monkeypatch.setattr(ocr, "recognize_image", lambda *a, **kw: pytest.fail("text PDF must not invoke OCR"))
    events = []
    result = ocr.build_metadata_candidate(path, events.append)
    assert result["pagesRead"] == 3 and result["totalPages"] == 4
    assert [e["percent"] for e in events if e["stage"] == "候选页读取完成"] == [33, 66, 100]


class PollStop:
    def __init__(self):
        self.stopped = False
    def wait(self, timeout):
        return self.stopped
    def is_set(self):
        return self.stopped
    def set(self):
        self.stopped = True


def test_old_model_progress_endpoint_falls_back_without_repeating_inference(monkeypatch):
    calls = []
    def request(url, payload, **kwargs):
        calls.append(url)
        raise ocr_upstream.OcrUpstreamHttpError("not found", status=404)
    monkeypatch.setattr(ocr_upstream, "_request_json", request)
    ocr_upstream._watch_model_progress("http://model", "new-attempt", lambda e: pytest.fail("no real progress"), PollStop())
    assert calls == ["http://model/layout-parsing/progress/new-attempt"]


def test_model_poll_response_is_ignored_after_stop(monkeypatch):
    stop = PollStop()
    def request(*args, **kwargs):
        stop.set()
        return 200, {"percent": 80, "updatedAt": 1}
    monkeypatch.setattr(ocr_upstream, "_request_json", request)
    ocr_upstream._watch_model_progress("http://model", "attempt", lambda e: pytest.fail("late callback"), stop)


def test_every_model_inference_uses_a_new_progress_key(monkeypatch):
    keys = []
    def request(url, payload, **kwargs):
        keys.append(kwargs["headers"]["X-OCR-Progress-Key"])
        return 200, {}
    monkeypatch.setattr(ocr_upstream, "_request_json", request)
    for _ in range(2):
        ocr_upstream._call_paddlex("http://model", "image", "p.png", 1, "quick", on_progress=lambda event: None)
    assert len(set(keys)) == 2


@pytest.mark.parametrize("registration", [False, True])
def test_scheduler_polls_both_ocr_paths_and_preserves_counts(registration):
    stop = PollStop()
    class Services:
        def ocr_progress(self, key):
            assert key == "unique-attempt"
            # Stop after setter has run, at the next loop iteration.
            stop.wait = lambda timeout: True
            return {"percent": 65, "updatedAt": 1, "stage": "文字识别", "completed": 8, "total": 32}
    worker = scheduler.Scheduler(SimpleNamespace(), Services())
    try:
        stage = "metadata_candidate" if registration else "ocr"
        worker._watch_progress("doc", stage, 0 if registration else 2, registration, "ocr", stop, "unique-attempt")
        event = worker.registration_snapshot("doc") if registration else worker.progress_snapshot("doc")["ocr"]
        assert event["percent"] == 65
        assert (event["detail"]["completed"], event["detail"]["total"]) == (8, 32)
        if registration:
            assert event["stage"] == "metadata_candidate"
    finally:
        worker.executor.shutdown()


def test_stopped_watcher_cannot_repopulate_cleared_progress():
    worker = scheduler.Scheduler(SimpleNamespace(), object())
    stop = threading.Event()
    stop.set()
    try:
        worker._set_page_progress("doc", "ocr", 1, 99, stop=stop)
        worker._set_registration_progress("doc", "metadata_candidate", 99, stop=stop)
        assert worker.progress_snapshot("doc") == {}
        assert worker.registration_snapshot("doc") == {}
    finally:
        worker.executor.shutdown()


def test_http_adapter_submits_progress_keys_for_both_ocr_operations(tmp_path):
    calls = []
    services = scheduler.HttpServices()
    services._form = lambda route, field, path, fields: calls.append((route, fields)) or {}
    job = {"source_path": str(tmp_path / "source.pdf"), "asset_root": str(tmp_path), "ocr_progress_key": "attempt-id"}
    doc = {"id": "doc", "pages": [{"pageNumber": 2, "imageFile": {"path": "page.png"}}]}
    services.execute("ocr", job, doc, {}, 2)
    services.execute("metadata_candidate", job, doc, {})
    assert calls == [("/ocr", {"pageNumber": 2, "progressKey": "attempt-id"}),
                     ("/ocr/metadata-candidate", {"progressKey": "attempt-id"})]


def test_abandoned_unfinished_progress_expires_by_absolute_age():
    task_progress.set_progress("stuck", 30, status="running")
    task_progress._ENTRIES["stuck"]["updatedAt"] -= task_progress.PROGRESS_MAX_AGE_SECONDS + 1
    assert task_progress.read_progress("stuck")["updatedAt"] == 0
    task_progress.set_progress("live", 30, status="running")
    assert task_progress.read_progress("live")["percent"] == 30
