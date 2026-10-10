from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

from service import data as data_service  # noqa: E402


def now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def database_size() -> int:
    return data_service.DB_PATH.stat().st_size if data_service.DB_PATH.exists() else 0


def ensure_schema_version(value: object, label: str) -> bool:
    if value == data_service.SCHEMA_VERSION:
        return True

    print(
        f"{label} schema {value} does not match current schema {data_service.SCHEMA_VERSION}.",
        file=sys.stderr,
    )
    return False


def backup_database(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source) as source_connection:
        with sqlite3.connect(target) as target_connection:
            source_connection.backup(target_connection)


def add_directory_to_zip(archive: zipfile.ZipFile, directory: Path, prefix: str) -> None:
    if not directory.exists():
        return

    for path in directory.rglob("*"):
        if path.is_file():
            archive.write(path, f"{prefix}/{path.relative_to(directory).as_posix()}")


def safe_extract(archive: zipfile.ZipFile, target: Path) -> None:
    target_root = target.resolve()
    for member in archive.infolist():
        destination = (target_root / member.filename).resolve()
        if target_root != destination and target_root not in destination.parents:
            raise RuntimeError(f"Unsafe archive path: {member.filename}")
    archive.extractall(target_root)


def command_backup(args: argparse.Namespace) -> int:
    db_path = data_service.DB_PATH
    if not db_path.exists():
        print(f"Database does not exist: {db_path}", file=sys.stderr)
        return 1

    output = Path(args.output or data_service.STORAGE_DIR / "backups" / f"history-backup-{now_stamp()}.zip").resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_dir:
        snapshot_db = Path(tmp_dir) / "app.db"
        backup_database(db_path, snapshot_db)
        manifest = {
            "createdAt": data_service.now_iso(),
            "database": str(db_path),
            "files": str(data_service.FILE_STORAGE_DIR),
            "schemaVersion": data_service.SCHEMA_VERSION,
        }

        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(snapshot_db, "database/app.db")
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            add_directory_to_zip(archive, data_service.FILE_STORAGE_DIR, "files")

    print(output)
    return 0


def command_restore(args: argparse.Namespace) -> int:
    archive_path = Path(args.archive).resolve()
    if not archive_path.exists():
        print(f"Backup archive does not exist: {archive_path}", file=sys.stderr)
        return 1

    if not args.yes:
        print("Restore overwrites the current database and files. Re-run with --yes after stopping services.", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        with zipfile.ZipFile(archive_path) as archive:
            if "manifest.json" not in archive.namelist():
                print("Archive is missing manifest.json", file=sys.stderr)
                return 1
            manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
            if not ensure_schema_version(manifest.get("schemaVersion"), "Backup"):
                return 1
            safe_extract(archive, tmp_path)

        restored_db = tmp_path / "database" / "app.db"
        restored_files = tmp_path / "files"
        if not restored_db.exists():
            print("Archive is missing database/app.db", file=sys.stderr)
            return 1

        data_service.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(restored_db, data_service.DB_PATH)

        if data_service.FILE_STORAGE_DIR.exists():
            shutil.rmtree(data_service.FILE_STORAGE_DIR)
        if restored_files.exists():
            shutil.copytree(restored_files, data_service.FILE_STORAGE_DIR)
        else:
            data_service.FILE_STORAGE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Restored {archive_path} -> {data_service.DB_PATH}")
    return 0


def command_check(_: argparse.Namespace) -> int:
    with data_service.database() as connection:
        report = data_service.storage_integrity_report(connection)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


def command_vacuum(_: argparse.Namespace) -> int:
    before = database_size()
    with data_service.database() as connection:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.execute("VACUUM")
        connection.execute("PRAGMA optimize")
    after = database_size()
    print(json.dumps({"database": str(data_service.DB_PATH), "beforeBytes": before, "afterBytes": after}, indent=2))
    return 0


def command_export_json(args: argparse.Namespace) -> int:
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with data_service.database() as connection:
        payload = data_service.build_snapshot(connection)
        payload["conversations"] = []
        for row in connection.execute("SELECT id, username, is_admin FROM users ORDER BY id").fetchall():
            user_snapshot = data_service.build_snapshot(connection, {"id": row["id"], "username": row["username"], "isAdmin": bool(row["is_admin"])})
            payload["conversations"].extend(user_snapshot["conversations"])
        payload["exportedAt"] = data_service.now_iso()

    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(output)
    return 0


def command_import_json(args: argparse.Namespace) -> int:
    input_path = Path(args.input).resolve()
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    if not ensure_schema_version(payload.get("schemaVersion"), "JSON"):
        return 1
    timestamp = data_service.now_iso()
    with data_service.database() as connection:
        with connection:
            grouped_documents = {}
            for document in payload.get("documents") or []:
                owner_id = int(document.get("ownerId") or 0)
                if owner_id:
                    grouped_documents.setdefault(owner_id, []).append(document)
            for owner_id, documents in grouped_documents.items():
                if connection.execute("SELECT 1 FROM users WHERE id = ?", (owner_id,)).fetchone():
                    data_service.upsert_documents(connection, documents, timestamp, {"id": owner_id})
            grouped_conversations = {}
            for conversation in payload.get("conversations") or []:
                owner_id = int(conversation.get("ownerId") or 0)
                if owner_id:
                    grouped_conversations.setdefault(owner_id, []).append(conversation)
            for owner_id, conversations in grouped_conversations.items():
                if connection.execute("SELECT 1 FROM users WHERE id = ?", (owner_id,)).fetchone():
                    data_service.upsert_conversations(connection, conversations, timestamp, {"id": owner_id})
            cursor = data_service.bump_sync_version(connection)

    print(json.dumps({"status": "ok", "syncCursor": str(cursor), "importedAt": timestamp}, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Storage maintenance for the history platform.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    backup = subparsers.add_parser("backup", help="Create a zip backup containing SQLite and stored files.")
    backup.add_argument("--output", help="Backup zip path. Defaults to storage/backups/history-backup-*.zip.")
    backup.set_defaults(func=command_backup)

    restore = subparsers.add_parser("restore", help="Restore a zip backup. Stop services first.")
    restore.add_argument("archive", help="Backup zip path.")
    restore.add_argument("--yes", action="store_true", help="Confirm overwriting the current database and files.")
    restore.set_defaults(func=command_restore)

    subparsers.add_parser("check", help="Run SQLite and file integrity checks.").set_defaults(func=command_check)

    subparsers.add_parser("vacuum", help="Checkpoint WAL, VACUUM, and optimize SQLite.").set_defaults(func=command_vacuum)

    export_json = subparsers.add_parser("export-json", help="Export active documents and conversations as JSON.")
    export_json.add_argument("output", help="Output JSON path.")
    export_json.set_defaults(func=command_export_json)

    import_json = subparsers.add_parser("import-json", help="Import documents and conversations from JSON.")
    import_json.add_argument("input", help="Input JSON path.")
    import_json.set_defaults(func=command_import_json)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
