# Reader Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remember each authenticated user's last page separately for each document, without displaying the record.

**Architecture:** SQLite progress records use `(user_id, document_id)` as their primary key and stay outside shared document payloads. The reader restores progress before rendering, then saves page changes with authenticated requests and a scoped local fallback.

**Tech Stack:** Existing FastAPI, SQLite, JavaScript, Python unittest, Node test runner.

**Spec:** User request in this session.

## Global Constraints

- No visible UI additions or shared document payload changes.
- Use current authentication and visibility rules; add no application dependencies.
- Implement directly in this session under the user's request.

## Review Focus

- Two users on one public document keep independent positions.
- One user on two documents keeps independent positions.
- Private/deleted documents and invalid pages are rejected.
- Normal opening restores progress; explicit page links take precedence; removed pages fall back to a valid page.
- Rapid navigation, repeated renders, and failed saves retain the latest position without account leakage.

## Task 1: Storage and API

**Files:** `service/data.py`, `tests/test_reading_progress.py`.
**Interfaces:** GET `/api/documents/{document_id}/reading-progress` returns `{pageId, pageNumber, updatedAt}`; PUT accepts `{pageId}` and derives the user from authentication.

- [ ] Add regression coverage for user/document isolation, visibility, invalid pages, and persistence.
- [ ] Add the table with user/document cascading foreign keys and authenticated GET/PUT handlers.
- [ ] Run `python -m unittest discover -s tests -p test_reading_progress.py`.

## Task 2: Reader integration

**Files:** `js/reader.js`, `js/documents.js`, `js/main.js`, `tests/reader-progress.test.js`.
**Interfaces:** `initializeReaderProgress()` restores before first render; `recordReaderProgress(item, page)` saves only actual reader views.

- [ ] Cover restoration, explicit links, fallback, scoped caching, duplicate renders, and queued requests.
- [ ] Remove automatic page parameters from ordinary opening and restore progress before rendering.
- [ ] Save with serialized keepalive requests and scoped cache; retry on pagehide and online.
- [ ] Run Node tests and JavaScript syntax checks, then inspect the diff.
