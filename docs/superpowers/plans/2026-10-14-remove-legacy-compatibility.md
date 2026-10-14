# Remove Legacy Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除项目中针对旧数据库结构、旧处理检查点、旧 LLM 请求字段和旧前端快照/进度格式的兼容分支，使运行时只接受当前 schema 7 和当前处理数据结构。

**Architecture:** 保留当前 schema 的建表语句、当前后端调度流程和当前前端数据模型，只移除迁移、字段回退和旧格式转换路径。启动时对已存在数据库的 schema 版本执行严格校验；版本不匹配时直接报错，由部署方重建或替换数据库。前后端继续使用现有 schemaVersion 校验，当前接口和最新数据字段保持不变。

**Tech Stack:** Python 3.10、FastAPI、SQLite、JavaScript 浏览器脚本、Node.js 语法检查。

**Spec:** 用户要求："去除对旧分支的兼容，所有功能只保持最新实现，对旧数据等的兼容不需要"。

## Global Constraints

- 只支持当前数据 schema 版本 `7`；旧数据库、旧备份和旧 JSON 导入数据不再自动迁移或转换。
- 保留当前公开 API 路径、当前请求字段和当前响应字段；删除兼容字段时同步更新当前调用方。
- 不删除当前业务仍使用的正常容错，例如网络失败后的提示、资源不存在时的错误处理和最新数据中可选字段的默认值。
- 不改变当前用户可见功能、最新处理流程、权限逻辑和文件存储布局。
- 对不匹配的旧状态采用明确失败，避免静默丢弃或隐式转换。

## Review Focus

- 旧数据库缺少最新列时，启动应明确失败，而不是执行 `ALTER TABLE`、删表重建或部分运行。
- 当前 schema 7 的全新数据库必须完整创建所有表、索引、管理员初始化和调度表。
- 当前处理任务的 checkpoint 必须直接进入最新阶段流程，不能把旧 `cover` 阶段映射到 `metadata_candidate`。
- 最新 LLM finalize 请求只使用 `ocrText`、`normalizedText` 和 `punctuationDraftText`，旧 `cleanText` / `punctuatedText` 请求不应再被接受或参与回退。
- 前端收到当前快照时，conversation turns 和 processing stage progress 必须保持原有显示、同步和失败处理行为。

---

### Task 1: Make database initialization latest-schema-only

**Files:**
- Modify: `service/data.py:12,187-407,1253-1257`
- Test/verify: temporary SQLite database via `DATA_DB_PATH` and an intentionally incompatible schema fixture

**Interfaces:**
- Preserve `ensure_schema(connection)`, `connect()`, `get_schema_version(connection)` and the existing `SCHEMA_VERSION = 7` value.
- Preserve the current `CREATE TABLE`, index definitions, initial administrator creation, `processing_scheduler.ensure_schema(connection)`, and health response shape.

- [ ] Remove `_ensure_users_sso_columns()` and the call sites that add `sso_account_id` or `deleted_at` with `ALTER TABLE`.
- [ ] Remove the `documents` column inspection and destructive old-table drop branch at the start of `ensure_schema()`.
- [ ] Remove the `conversation_shares` column inspection and `ALTER TABLE ... ADD COLUMN content` branch; the current `CREATE TABLE conversation_shares` definition already includes `content`.
- [ ] Remove the `schema_row`/`conversation_columns` migration block that drops and recreates `conversations`, deletes conversation assets, and bumps sync state for schema versions below 7.
- [ ] Replace schema version initialization with strict current-version handling: insert `schema_version = 7` for a new database, accept an existing value only when it equals `SCHEMA_VERSION`, and raise a clear runtime error for any other existing value.
- [ ] Make `get_schema_version()` require the current `app_meta.schema_version` row rather than silently defaulting when the row is absent.
- [ ] Remove `shutil` if it becomes unused after the migration block is removed.
- [ ] Verify a fresh database creates the latest tables and reports schema version 7; verify an old/missing-column database fails clearly without altering or dropping its tables.

### Task 2: Remove old processing checkpoint and LLM request branches

**Files:**
- Modify: `service/scheduler.py:69-78,272`
- Modify: `service/llm.py:65-72,328-335`
- Test/verify: current registration and body-processing smoke path, plus request-model validation for removed fields

**Interfaces:**
- Preserve `Scheduler._load()` return shape `(job, document, checkpoint)`.
- Preserve `FinalizePageRequest` current fields `ocrText`, `normalizedText`, `punctuationDraftText`, `previousPages`, and all current response fields.

- [ ] Delete `upgrade_checkpoint()` and have `Scheduler._load()` load the current checkpoint JSON directly.
- [ ] Remove conversion of `registrationStep` values `cover_candidate` / `cover` and removal of `coverCandidate` / `cover` checkpoint fields.
- [ ] Keep current checkpoint defaults at the point where the current registration and processing stages create or update them; do not add a compatibility normalizer in another location.
- [ ] Remove `cleanText` and `punctuatedText` from `FinalizePageRequest`.
- [ ] Change `finalize_page()` input selection to use only `normalizedText` or `ocrText` for the normalized source, and only `punctuationDraftText` for the punctuation draft.
- [ ] Confirm the scheduler already sends only the current request fields and that proofreading still returns and stores `cleanText` / `punctuatedText` as output fields.
- [ ] Verify an old request containing only removed input fields is rejected by request validation, while the current scheduler request continues to complete.

### Task 3: Remove old front-end snapshot and progress fallbacks

**Files:**
- Modify: `js/core.js:13-19,289-299,538-596`
- Modify: `js/processing.js:251-282`
- Test/verify: `node --check js/*.js` and a static reference scan for removed compatibility symbols

**Interfaces:**
- Preserve current `DATA_SCHEMA_VERSION = 7`, `applyServerState()`, conversation turn shape, `renderStreamProgress()`, and all current storage keys used by the latest implementation.

- [ ] Remove cleanup of obsolete `conversations.schema4` and `deletedConversations.schema4` localStorage keys; the latest implementation should only read and write its current schema keys.
- [ ] Change `normalizeConversationTurns(values, legacyResult, conversationId)` to accept only current turns and the conversation ID.
- [ ] Remove `normalizeConversationResult(legacyResult)` fallback creation of a synthetic `conversationId + "-legacy"` turn.
- [ ] Update `normalizeConversations()` to call the new current-only signature while retaining current `item.result` and per-turn result handling used by the active conversation UI.
- [ ] Remove `legacyProgress` construction in `renderStreamProgress()` and read `task.stageProgress` directly; use an empty current-stage entry only for a missing stage key in an otherwise current task.
- [ ] Preserve current network-error behavior and current page-progress rendering; only remove conversion from old `completedPages` / `finalizedPages` fields.
- [ ] Run syntax validation for every JavaScript file and confirm removed symbols have no remaining references.

### Task 4: Repository-wide compatibility audit and final verification

**Files:**
- Review all source files under `service/`, `scripts/`, `js/`, `html/`, and `deploy/`
- Modify only files with a confirmed old-branch compatibility path found during the audit

- [ ] Search for explicit compatibility markers and review each hit: `legacy`, `兼容旧`, `upgrade`, `migration`, `ALTER TABLE`, `schema <`, `fallback` tied to old field names, and old-version storage keys.
- [ ] Keep protocol identifiers that are part of the current implementation, such as the current SSO token prefix, current schema checks, current network error handling, and historical-content language such as “旧称” in prompts.
- [ ] Run `git diff --check` and inspect the complete diff for accidental changes to current API behavior.
- [ ] Run `node --check` on all JavaScript files.
- [ ] If a Python interpreter is available, compile/import the changed Python modules and run the fresh-database and incompatible-database checks from Tasks 1 and 2; otherwise report that limitation explicitly.
- [ ] Confirm only intended files changed and leave unrelated pre-existing working-tree modifications untouched.

