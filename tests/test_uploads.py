import asyncio
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from service import data, uploads


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(data, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setattr(data, "STORAGE_DIR", tmp_path)
    monkeypatch.setattr(data, "FILE_STORAGE_DIR", tmp_path / "files")
    monkeypatch.setattr(data, "current_user", lambda: {"id": 1, "username": "owner"})
    monkeypatch.setenv("INITIAL_ADMIN_USERNAME", "owner")
    monkeypatch.setenv("INITIAL_ADMIN_PASSWORD", "test-password")
    with data.database() as connection, connection:
        pass
    client = TestClient(data.app)
    yield client
    client.close()


def begin(client, upload_id="upload-test", content=b"pdf-content"):
    response = client.post("/api/uploads", json={"id": upload_id, "fileName": "book.pdf", "size": len(content), "mimeType": "application/pdf"})
    assert response.status_code == 200, response.text
    return response


def ready(client, upload_id="upload-test", content=b"pdf-content"):
    begin(client, upload_id, content)
    response = client.post(f"/api/uploads/{upload_id}/file", files={"document": ("book.pdf", content, "application/pdf")})
    assert response.status_code == 200, response.text
    return response


def count(table):
    with data.database() as connection:
        return connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def test_upload_does_not_create_document_or_processing_job(api):
    ready(api)
    assert api.get("/api/uploads/upload-test").json()["status"] == "ready"
    assert count("documents") == count("document_files") == count("processing_jobs") == 0
    assert list(uploads.upload_root().glob("*.part"))


def test_incomplete_upload_never_enables_registration(api):
    begin(api, content=b"123456")
    response = api.post("/api/uploads/upload-test/file", files={"document": ("book.pdf", b"123")})
    assert response.status_code == 422
    assert api.post("/api/uploads/upload-test/register", json={"uploadIds": ["upload-test"], }).status_code == 409
    assert count("documents") == 0
    assert not list(uploads.upload_root().glob("*.part"))


def test_registration_is_atomic_and_idempotent(api):
    ready(api)
    response = api.post("/api/uploads/upload-test/register", json={"uploadIds": ["upload-test"], "title": "历史文献", "processingMode": "serial"})
    assert response.status_code == 200, response.text
    document = response.json()["document"]
    assert document["title"] == "历史文献"
    assert document["processingTask"]["backendManaged"]
    assert document["processingMode"] == "serial"
    assert count("documents") == count("document_files") == count("processing_jobs") == 1
    assert not list(uploads.upload_root().glob("*.part"))
    again = api.post("/api/uploads/upload-test/register", json={"uploadIds": ["upload-test"], "title": "do not overwrite"})
    assert again.status_code == 200
    assert again.json()["document"]["title"] == "历史文献"
    assert count("documents") == count("processing_jobs") == 1
    status = api.get("/api/uploads/upload-test").json()
    assert status["status"] == "registered"
    assert status["document"]["id"] == document["id"]


def test_cancel_after_registration_preserves_original(api):
    ready(api)
    assert api.post("/api/uploads/upload-test/register", json={"uploadIds": ["upload-test"], }).status_code == 200
    assert api.delete("/api/uploads/upload-test").json()["status"] == "registered"
    with data.database() as connection:
        path = connection.execute("SELECT storage_path FROM document_files").fetchone()[0]
    assert (data.FILE_STORAGE_DIR / path).read_bytes() == b"pdf-content"
    assert count("processing_jobs") == 1


def test_cancel_before_initialization_blocks_late_requests(api):
    assert api.delete("/api/uploads/late-upload").status_code == 200
    response = api.post("/api/uploads", json={"id": "late-upload", "fileName": "book.pdf", "size": 3})
    assert response.status_code == 409
    assert api.post("/api/uploads/late-upload/file", files={"document": ("book.pdf", b"123")}).status_code == 409
    assert count("documents") == 0


def test_cancel_ready_upload_removes_file_and_blocks_registration(api):
    ready(api)
    assert api.delete("/api/uploads/upload-test").json()["status"] == "cancelled"
    assert not list(uploads.upload_root().glob("*.part"))
    assert api.post("/api/uploads/upload-test/register", json={"uploadIds": ["upload-test"], }).status_code == 409
    assert count("documents") == 0


def test_cancel_during_file_read_discards_late_file(api):
    begin(api, content=b"123")
    class Incoming:
        received = False
        async def read(self, size):
            if self.received:
                return b""
            self.received = True
            uploads.cancel_upload("upload-test")
            return b"123"
    with pytest.raises(HTTPException) as exc:
        asyncio.run(uploads.upload_file("upload-test", Incoming()))
    assert exc.value.status_code == 409
    assert not list(uploads.upload_root().glob("*.part"))
    assert count("documents") == 0


def test_registration_failure_rolls_back_and_allows_retry(api):
    ready(api)
    response = api.post("/api/uploads/upload-test/register", json={"uploadIds": ["upload-test"], "processingMode": "invalid"})
    assert response.status_code == 422
    assert count("documents") == count("document_files") == count("processing_jobs") == 0
    assert api.get("/api/uploads/upload-test").json()["status"] == "ready"
    assert not list(data.FILE_STORAGE_DIR.rglob("*.pdf"))
    assert api.post("/api/uploads/upload-test/register", json={"uploadIds": ["upload-test"], }).status_code == 200


def test_expired_upload_cleanup_does_not_touch_registered_original(api):
    ready(api, "expired")
    ready(api, "registered")
    assert api.post("/api/uploads/registered/register", json={"uploadIds": ["registered"], }).status_code == 200
    with data.database() as connection, connection:
        connection.execute("UPDATE pending_uploads SET updated_at=?", (time.time() - uploads.UPLOAD_TTL_SECONDS - 1,))
    uploads.cleanup_expired()
    assert api.get("/api/uploads/expired").status_code == 404
    assert api.get("/api/uploads/registered").json()["status"] == "registered"
    assert count("documents") == 1
    assert not list(uploads.upload_root().glob("*.part"))


def test_upload_endpoints_enforce_ownership(api, monkeypatch):
    ready(api)
    monkeypatch.setattr(data, "current_user", lambda: {"id": 2, "username": "other"})
    for method, suffix in [("get", ""), ("delete", ""), ("post", "/register")]:
        response = getattr(api, method)("/api/uploads/upload-test" + suffix, **({"json": {"uploadIds": ["upload-test"]}} if method == "post" else {}))
        assert response.status_code == 403
    assert api.post("/api/uploads/upload-test/file", files={"document": ("book.pdf", b"pdf-content")}).status_code == 403


def test_concurrent_registration_and_cancellation_have_one_outcome(api):
    ready(api)
    with ThreadPoolExecutor(max_workers=2) as pool:
        registration = pool.submit(uploads.register_upload, "upload-test", uploads.Registration(uploadIds=["upload-test"]))
        cancellation = pool.submit(uploads.cancel_upload, "upload-test")
        cancellation.result()
        try:
            registration.result()
        except HTTPException as exc:
            assert exc.status_code == 409
    status = api.get("/api/uploads/upload-test").json()["status"]
    if status == "registered":
        assert count("documents") == count("processing_jobs") == 1
        with data.database() as connection:
            path = connection.execute("SELECT storage_path FROM document_files").fetchone()[0]
        assert (data.FILE_STORAGE_DIR / path).is_file()
    else:
        assert status == "cancelled"
        assert count("documents") == count("processing_jobs") == 0


def test_registration_cannot_reuse_an_existing_document_id(api):
    ready(api)
    with data.database() as connection, connection:
        data.upsert_documents(connection, [{"id": "upload-test", "title": "existing", "pages": []}], "now", {"id": 1, "username": "owner"})
    response = api.post("/api/uploads/upload-test/register", json={"uploadIds": ["upload-test"], "title": "replacement"})
    assert response.status_code == 409
    assert count("processing_jobs") == count("document_files") == 0
    with data.database() as connection:
        original = data.json_load(connection.execute("SELECT payload FROM documents").fetchone()[0])
    assert original["title"] == "existing"


def pdf_bytes(*pages):
    import pymupdf as fitz
    with fitz.open() as document:
        for text in pages:
            document.new_page().insert_text((72, 72), text)
        return document.tobytes()


def stage(api, upload_id, content, name="book.pdf", mime="application/pdf"):
    response = api.post("/api/uploads", json={"id": upload_id, "fileName": name, "size": len(content), "mimeType": mime})
    assert response.status_code == 200, response.text
    response = api.post(f"/api/uploads/{upload_id}/file", files={"document": (name, content, mime)})
    assert response.status_code == 200, response.text


def original_pdf():
    import pymupdf as fitz
    with data.database() as connection:
        row = connection.execute("SELECT storage_path FROM document_files WHERE role='source'").fetchone()
    return fitz.open(data.FILE_STORAGE_DIR / row[0])


def test_multiple_pdfs_merge_in_submitted_order_into_one_registered_document(api):
    stage(api, "first", pdf_bytes("A1", "A2"), "first.pdf")
    stage(api, "second", pdf_bytes("B1", "B2"), "second.pdf")
    response = api.post("/api/uploads/merged-book/register", json={"uploadIds": ["second", "first"], "title": "合并文献"})
    assert response.status_code == 200, response.text
    document = response.json()["document"]
    assert document["id"] == "merged-book"
    assert document["title"] == "合并文献"
    assert document["fileName"] == "second_合并.pdf"
    assert count("documents") == count("processing_jobs") == count("document_files") == 1
    with original_pdf() as pdf:
        assert [page.get_text().strip() for page in pdf] == ["B1", "B2", "A1", "A2"]
    assert not list(uploads.upload_root().glob("*.part"))
    for upload_id in ["first", "second"]:
        state = api.get(f"/api/uploads/{upload_id}").json()
        assert state["status"] == "registered"
        assert state["document"]["id"] == "merged-book"
        assert api.delete(f"/api/uploads/{upload_id}").json()["status"] == "registered"
    assert api.get("/api/uploads/registrations/merged-book").json()["document"]["id"] == "merged-book"
    again = api.post("/api/uploads/merged-book/register", json={"uploadIds": ["first", "second"]})
    assert again.status_code == 200
    assert count("processing_jobs") == 1
    with original_pdf() as pdf:
        assert pdf[0].get_text().strip() == "B1"


def test_pdf_and_image_merge_without_separator_pages(api):
    import io
    from PIL import Image
    image = io.BytesIO()
    Image.new("RGB", (100, 60), "red").save(image, format="PNG")
    stage(api, "before", pdf_bytes("BEFORE"))
    stage(api, "image", image.getvalue(), "scan.png", "image/png")
    stage(api, "after", pdf_bytes("AFTER"))
    response = api.post("/api/uploads/mixed/register", json={"uploadIds": ["before", "image", "after"]})
    assert response.status_code == 200, response.text
    with original_pdf() as pdf:
        assert len(pdf) == 3
        assert pdf[0].get_text().strip() == "BEFORE"
        assert pdf[1].get_images()
        assert pdf[2].get_text().strip() == "AFTER"


def test_invalid_file_merge_keeps_other_uploads_for_correction(api):
    stage(api, "good", pdf_bytes("VALID"), "good.pdf")
    stage(api, "bad", b"not a pdf", "bad.pdf")
    response = api.post("/api/uploads/failed-merge/register", json={"uploadIds": ["good", "bad"]})
    assert response.status_code == 422
    assert "bad.pdf" in response.json()["detail"]
    assert count("documents") == count("processing_jobs") == 0
    assert api.get("/api/uploads/good").json()["status"] == "ready"
    assert api.get("/api/uploads/bad").json()["status"] == "ready"
    assert len(list(uploads.upload_root().glob("*.part"))) == 2
    assert api.delete("/api/uploads/bad").status_code == 200
    assert api.post("/api/uploads/failed-merge/register", json={"uploadIds": ["good"]}).status_code == 200


def test_cancel_during_merge_prevents_registration(api, monkeypatch):
    stage(api, "one", pdf_bytes("ONE"))
    stage(api, "two", pdf_bytes("TWO"))
    merge = uploads.merge_sources
    def cancel_after_merge(rows, output):
        merge(rows, output)
        uploads.cancel_upload("two")
    monkeypatch.setattr(uploads, "merge_sources", cancel_after_merge)
    response = api.post("/api/uploads/cancelled-merge/register", json={"uploadIds": ["one", "two"]})
    assert response.status_code == 409
    assert count("documents") == count("processing_jobs") == 0
    assert api.get("/api/uploads/one").json()["status"] == "ready"
    assert api.get("/api/uploads/two").json()["status"] == "cancelled"
    assert len(list(uploads.upload_root().glob("*.part"))) == 1


def test_registration_requires_all_files_ready_and_owned(api, monkeypatch):
    stage(api, "ready", pdf_bytes("READY"))
    begin(api, "unfinished")
    response = api.post("/api/uploads/batch/register", json={"uploadIds": ["ready", "unfinished"]})
    assert response.status_code == 409
    assert api.post("/api/uploads/batch/register", json={"uploadIds": ["ready", "ready"]}).status_code == 422
    assert api.post("/api/uploads/batch/register", json={"uploadIds": []}).status_code == 422
    monkeypatch.setattr(data, "current_user", lambda: {"id": 2, "username": "other"})
    assert api.post("/api/uploads/batch/register", json={"uploadIds": ["ready"]}).status_code == 403
    assert count("documents") == 0


def test_concurrent_multi_file_registration_creates_only_one_job(api):
    stage(api, "one", pdf_bytes("ONE"))
    stage(api, "two", pdf_bytes("TWO"))
    def submit():
        return uploads.register_upload("batch", uploads.Registration(uploadIds=["one", "two"]))
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: submit(), range(2)))
    assert [result["document"]["id"] for result in results] == ["batch", "batch"]
    assert count("documents") == count("processing_jobs") == 1
    assert not list(uploads.upload_root().glob("*.part"))


def test_encrypted_pdf_reports_the_file_and_leaves_no_registration(api):
    import pymupdf as fitz
    with fitz.open(stream=pdf_bytes("SECRET"), filetype="pdf") as pdf:
        encrypted = pdf.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="password")
    stage(api, "encrypted", encrypted, "encrypted.pdf")
    stage(api, "good", pdf_bytes("GOOD"), "good.pdf")
    response = api.post("/api/uploads/batch/register", json={"uploadIds": ["good", "encrypted"]})
    assert response.status_code == 422
    assert "encrypted.pdf" in response.json()["detail"]
    assert "加密" in response.json()["detail"]
    assert count("documents") == 0
    assert len(list(uploads.upload_root().glob("*.part"))) == 2


def test_late_duplicate_merge_returns_already_registered_batch(api, monkeypatch):
    stage(api, "one", pdf_bytes("ONE"))
    stage(api, "two", pdf_bytes("TWO"))
    merge = uploads.merge_sources
    nested = False
    def register_before_merge(rows, output):
        nonlocal nested
        if not nested:
            nested = True
            uploads.register_upload("batch", uploads.Registration(uploadIds=["one", "two"]))
        merge(rows, output)
    monkeypatch.setattr(uploads, "merge_sources", register_before_merge)
    response = api.post("/api/uploads/batch/register", json={"uploadIds": ["one", "two"]})
    assert response.status_code == 200, response.text
    assert count("documents") == count("processing_jobs") == 1
    assert not list(uploads.upload_root().glob("*.part"))
