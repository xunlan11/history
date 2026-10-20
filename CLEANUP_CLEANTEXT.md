# cleanText 移除后的旧数据清理说明

日期：2026-10-20

执行方：数据端。本文是执行交接文件，本次代码修改没有执行以下清理。

## 清理目标与范围

直接清空全部历史业务数据，部署新代码后重新上传文献。不迁移 `cleanText`，不保留旧字段兼容，不把旧文本转换为新正文。

清理范围包括所有用户的文献（公开、私有、下载副本及软删除记录）、页面、原件及页面图片、处理任务、阅读定位索引、语义索引、备注/批注、阅读进度、对话、对话附件、分享记录和书架目录。

保留数据库表结构、`app_meta.schema_version`、账户 `users` 和角色 `roles`，便于继续登录。这里的“全部旧数据”指历史业务数据；不涉及外部 SSO 身份库或其他应用的数据。

新页面只保留以下文本层：

| 字段 | 含义 |
| --- | --- |
| `ocrText` | OCR 原始录文 |
| `normalizedText` | OpenCC 简体文本 |
| `punctuationDraftText` | 标点草稿 |
| `punctuatedText` | 校对成功后生成的最终正文 |

`cleanText` 不再读写、返回或建立索引。校对失败时不把简体文本或标点草稿写入最终正文，最终正文留空，失败状态和中间文本照常保留。阅读界面原有的 OCR 展示功能独立于最终正文存储。

## 执行顺序

1. 确认实际部署的数据库和资产目录，核对下表；不要仅凭仓库默认路径操作。多套部署若各自有数据库，逐库处理；共享目录不得整目录清空。
2. 进入维护窗口，阻断旧前端的读写，停止数据服务、文献调度器、语义工作器、OCR 服务及其他会写入同一数据库/资产目录的进程。
3. 备份数据库和文件资产，再执行数据库清理。
4. 清理属于本应用的旧文件和 OCR 缓存。
5. 部署本次前后端代码，完成所有客户端缓存清理，再恢复访问。
6. 执行验收，重新上传一篇文献确认完整流程。

| 内容 | 配置与默认位置 |
| --- | --- |
| SQLite 数据库 | `DATA_DB_PATH`，默认 `<项目根目录>/storage/app.db` |
| 数据存储目录 | `DATA_STORAGE_DIR`，默认数据库所在目录 |
| 文献与对话资产目录 | `DATA_FILE_STORAGE_DIR`，默认 `<数据存储目录>/files` |
| OCR 缓存目录 | `OCR_STORAGE_DIR`，默认 `<项目根目录>/ocr-storage` |

先在项目根目录、使用与运行服务相同的环境变量执行备份：

```bash
uv run python scripts/storage.py backup
```

默认生成 `<数据存储目录>/backups/history-backup-YYYYMMDD-HHMMSS.zip`，包含 SQLite 快照和数据端文件资产。另行保存本次部署所需配置，以及需要留存的 OCR 缓存。备份放在清理目录之外；本次清理不要删除整个 `storage` 目录。

## 数据库清理

连接上一步确认的数据库，在外键检查开启的连接中执行下面的事务。数据库应已经具有当前版本的完整表结构。任一语句失败时停止并回滚，不要跳过错误继续提交。

这会物理删除所有历史业务记录，包括软删除记录。无需遍历 JSON 删除字段，也无需保留历史引用定位：对话与分享随旧数据一起删除。

```sql
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- 派生索引：先删除向量，再删除其引用的分块。
DELETE FROM semantic_vectors;
DELETE FROM semantic_jobs;
DELETE FROM semantic_sources;
DELETE FROM semantic_chunks;
DELETE FROM semantic_models;

-- 后台任务与阅读相关数据。
DELETE FROM processing_jobs;
DELETE FROM page_reader_indexes;
DELETE FROM page_annotations;
DELETE FROM reading_progress;

-- 对话、附件和分享。
DELETE FROM conversation_shares;
DELETE FROM conversation_files;
DELETE FROM conversations;

-- 文件记录、页面和文献。
DELETE FROM document_files;
DELETE FROM document_pages;
DELETE FROM documents;

-- 清除各用户的书架目录和排序。
DELETE FROM app_meta WHERE key GLOB 'shelf.user-*';

-- 保持同步游标单调递增，不归零。
UPDATE app_meta
SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
WHERE key = 'sync_version';

COMMIT;
```

说明：`documents.payload.pages` 和 `document_pages.payload` 中的旧字段随整条记录删除；`conversations.payload` 中的请求、证据、历史回答和引用快照也随整条记录删除。不得从旧 JSON 导出或备份中重新导入这些业务数据。

如需回收 SQLite 空间，在上述事务提交后、服务仍停止时执行：

```bash
uv run python scripts/storage.py vacuum
```

## 文件与缓存清理

数据库删除不会自动删除磁盘文件。由数据端按实际目录执行以下操作：

- 清空本应用的 `DATA_FILE_STORAGE_DIR` 下旧文献原件、页面图片、封面和对话附件。保留或重新创建目录，并恢复服务账号所需权限。
- 清空本应用的 `OCR_STORAGE_DIR` 下旧任务目录、暂存上传、逐页图片和取消标记，避免旧 OCR 任务恢复。这里是本应用的 OCR 缓存目录，不是远端模型目录。
- 保留备份、部署配置、程序、模型文件及其他应用资产。目录共享时只删除明确归属于本应用的文件。
- 所有客户端清除本应用的 LocalStorage、IndexedDB 和旧页面资源缓存，并关闭旧标签页。LocalStorage 包含文献、对话、同步游标、未同步标记、书架与取消队列等；IndexedDB 的待上传库名为 `wenqu.pendingUploads`。
- history 和 literature 等入口如部署在不同 origin，分别清理。清理缓存后从新页面重新登录。不要打开旧离线页面或恢复旧待上传任务，避免把已删除数据重新同步回服务端。

发布时需要确保所有客户端都切换到新代码。本次不新增旧客户端兼容或缓存数据迁移逻辑。

## 验收

数据库仍处于维护窗口时，以下计数应全部为 0：

```sql
SELECT 'documents' AS table_name, COUNT(*) AS rows FROM documents
UNION ALL SELECT 'document_pages', COUNT(*) FROM document_pages
UNION ALL SELECT 'document_files', COUNT(*) FROM document_files
UNION ALL SELECT 'processing_jobs', COUNT(*) FROM processing_jobs
UNION ALL SELECT 'page_reader_indexes', COUNT(*) FROM page_reader_indexes
UNION ALL SELECT 'page_annotations', COUNT(*) FROM page_annotations
UNION ALL SELECT 'reading_progress', COUNT(*) FROM reading_progress
UNION ALL SELECT 'conversations', COUNT(*) FROM conversations
UNION ALL SELECT 'conversation_files', COUNT(*) FROM conversation_files
UNION ALL SELECT 'conversation_shares', COUNT(*) FROM conversation_shares
UNION ALL SELECT 'semantic_sources', COUNT(*) FROM semantic_sources
UNION ALL SELECT 'semantic_chunks', COUNT(*) FROM semantic_chunks
UNION ALL SELECT 'semantic_vectors', COUNT(*) FROM semantic_vectors
UNION ALL SELECT 'semantic_jobs', COUNT(*) FROM semantic_jobs
UNION ALL SELECT 'semantic_models', COUNT(*) FROM semantic_models
UNION ALL SELECT 'shelf', COUNT(*) FROM app_meta WHERE key GLOB 'shelf.user-*';

PRAGMA foreign_key_check;
PRAGMA integrity_check;
```

`foreign_key_check` 应无结果，`integrity_check` 应返回 `ok`。账户数量和 `schema_version` 应与清理前一致。执行资产完整性检查：

```bash
uv run python scripts/storage.py check
```

恢复服务后检查：

1. 登录后文献库、书架和对话为空，旧分享不可访问，旧后台任务没有重新运行。
2. 新上传文献完成 OCR、简繁转换、标点和校对，接口与页面数据中没有 `cleanText`。
3. 标点请求的 `sourceLayer` 为 `normalized`；元数据接口如指定简体输入来源，也使用 `normalized`，不再接受旧的 `clean` 来源名。
4. 校对成功时只有 `punctuatedText` 一份最终正文；校对失败时该字段为空，草稿只留在 `punctuationDraftText`。
5. 新检索及引用来源层只有 `ocrText`、`punctuatedText`、`notes`；阅读定位和语义索引按新数据重新生成。

## 回滚

如果需要恢复旧数据，先重新进入维护窗口并停止全部写入进程，再恢复与备份匹配的旧代码、数据库和文件资产：

```bash
uv run python scripts/storage.py restore /absolute/path/history-backup-YYYYMMDD-HHMMSS.zip --yes
```

恢复后再次清理客户端缓存并执行完整性检查。旧备份只用于整体回滚，不可导入新版本继续运行，否则会重新引入已移除字段。
