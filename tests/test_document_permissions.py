import json
import tempfile
import unittest
from pathlib import Path

from service import data


class DocumentPermissionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = data.DB_PATH
        self.original_file_dir = data.FILE_STORAGE_DIR
        root = Path(self.temp_dir.name)
        data.DB_PATH = root / "app.db"
        data.FILE_STORAGE_DIR = root / "files"
        data.FILE_STORAGE_DIR.mkdir()

        self.connection = data.connect()
        with self.connection:
            owner_cursor = self.connection.execute(
                "INSERT INTO users(username,password_hash,is_admin,created_at) VALUES(?,?,0,?)",
                ("owner", "hash", data.now_iso()),
            )
            viewer_cursor = self.connection.execute(
                "INSERT INTO users(username,password_hash,is_admin,created_at) VALUES(?,?,0,?)",
                ("viewer", "hash", data.now_iso()),
            )
        self.owner = {"id": owner_cursor.lastrowid, "username": "owner", "isAdmin": False}
        self.viewer = {"id": viewer_cursor.lastrowid, "username": "viewer", "isAdmin": False}
        self.document = {
            "id": "document-1",
            "title": "Original",
            "visibility": "public",
            "pages": [{"id": "page-1", "pageNumber": 1, "punctuatedText": "Original page"}],
        }
        with self.connection:
            data.upsert_documents(self.connection, [self.document], data.now_iso(), self.owner)

    def tearDown(self):
        self.connection.close()
        data.DB_PATH = self.original_db_path
        data.FILE_STORAGE_DIR = self.original_file_dir
        self.temp_dir.cleanup()

    def test_public_document_is_read_only_for_non_owner(self):
        viewer_document = data.build_snapshot(self.connection, self.viewer)["documents"][0]
        self.assertFalse(viewer_document["canEdit"])
        self.assertIsNone(viewer_document["ownerId"])
        self.assertEqual(viewer_document["creator"]["username"], "owner")

        changed = {
            **viewer_document,
            "title": "Changed by viewer",
            "pages": [{"id": "page-1", "pageNumber": 1, "punctuatedText": "Changed by viewer"}],
        }
        with self.connection:
            data.upsert_documents(self.connection, [changed], data.now_iso(), self.viewer)
            data.soft_delete_entities(
                self.connection,
                "documents",
                [self.document["id"]],
                data.now_iso(),
                self.viewer,
            )

        document_row = self.connection.execute(
            "SELECT payload, deleted_at FROM documents WHERE id = ?",
            (self.document["id"],),
        ).fetchone()
        page_row = self.connection.execute(
            "SELECT payload, deleted_at FROM document_pages WHERE id = ?",
            ("page-1",),
        ).fetchone()
        self.assertEqual(json.loads(document_row["payload"])["title"], "Original")
        self.assertEqual(json.loads(page_row["payload"])["punctuatedText"], "Original page")
        self.assertIsNone(document_row["deleted_at"])
        self.assertIsNone(page_row["deleted_at"])

    def test_owner_can_update_document(self):
        owner_document = data.build_snapshot(self.connection, self.owner)["documents"][0]
        self.assertTrue(owner_document["canEdit"])
        self.assertEqual(owner_document["ownerId"], self.owner["id"])

        owner_document["title"] = "Changed by owner"
        with self.connection:
            data.upsert_documents(self.connection, [owner_document], data.now_iso(), self.owner)

        row = self.connection.execute(
            "SELECT payload FROM documents WHERE id = ?",
            (self.document["id"],),
        ).fetchone()
        stored = json.loads(row["payload"])
        self.assertEqual(stored["title"], "Changed by owner")
        self.assertNotIn("canEdit", stored)
        self.assertNotIn("ownerId", stored)

    def test_page_annotations_are_private_per_user(self):
        data.SESSIONS["owner-token"] = self.owner
        data.SESSIONS["viewer-token"] = self.viewer
        try:
            data.put_page_annotation(
                self.document["id"],
                "page-1",
                data.PageAnnotationUpdate(content="创建者的笺注"),
                "Bearer owner-token",
            )
            data.put_page_annotation(
                self.document["id"],
                "page-1",
                data.PageAnnotationUpdate(content="阅读者的笺注"),
                "Bearer viewer-token",
            )

            owner_annotation = data.get_page_annotation(
                self.document["id"], "page-1", "Bearer owner-token"
            )
            viewer_annotation = data.get_page_annotation(
                self.document["id"], "page-1", "Bearer viewer-token"
            )
        finally:
            data.SESSIONS.pop("owner-token", None)
            data.SESSIONS.pop("viewer-token", None)

        self.assertEqual(owner_annotation["content"], "创建者的笺注")
        self.assertEqual(viewer_annotation["content"], "阅读者的笺注")
        rows = self.connection.execute(
            "SELECT user_id, content FROM page_annotations WHERE page_id = ? ORDER BY user_id",
            ("page-1",),
        ).fetchall()
        self.assertEqual(len(rows), 2)

    def test_annotation_requires_document_visibility(self):
        with self.connection:
            self.connection.execute(
                "UPDATE documents SET visibility = 'private' WHERE id = ?",
                (self.document["id"],),
            )
        data.SESSIONS["viewer-token"] = self.viewer
        try:
            with self.assertRaises(data.HTTPException) as context:
                data.put_page_annotation(
                    self.document["id"],
                    "page-1",
                    data.PageAnnotationUpdate(content="不可写入"),
                    "Bearer viewer-token",
                )
        finally:
            data.SESSIONS.pop("viewer-token", None)

        self.assertEqual(context.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
