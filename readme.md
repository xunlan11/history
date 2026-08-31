## 虚拟环境（根目录）

uv：
```bash
winget install astral-sh.uv # Windows
curl -LsSf https://astral.sh/uv/install.sh | sh # Linux / macOS
cd history
uv sync
```

## 服务

四个服务，由systemd托管。

## 前端页面

- `html/index.html`：首页、书库问答、检索与编年。
- `html/documents.html`：文献库、文献登记、排序与删除。
- `html/reader.html?document=...&page=...`：文献原图和整理文本浏览。
- `html/workspace.html?document=...&page=...`：逐页 OCR 与文字整理工作台。

文献 ID、页 ID 和返回来源通过 URL 参数传递，因此子页面刷新后仍能恢复当前文献和页码。

### 数据库

使用SQLite。

### OCR

使用PaddleOCR。

接口（如不在同一主机则改为实际地址）：
```
http://127.0.0.1:8765/ocr
http://127.0.0.1:8765/ocr/stream
```

文献统一通过 `/ocr/stream` 提交。OCR 服务按页码连续识别，前端把已识别页面加入大模型整理队列；大模型同样按页码顺序处理。两条队列可以同时推进，OCR 不等待大模型，只要求每页必须先完成 OCR 才能进入该页的大模型整理。后一页整理时会携带最近两页已完成的整理文本作为上下文。

### 大模型

通过Ollama调用qwen3:8b。

接口（如不在同一主机则改为实际地址）：
```
http://127.0.0.1:8865/llm
http://127.0.0.1:8865/health
```

Ollama：
```bash
winget install Ollama.Ollama # Windows
curl -fsSL https://ollama.com/install.sh | sh # Linux
ollama serve # 新终端
ollama pull qwen3:8b # 新终端
```

默认配置为（[service/llm.py#L16-L19](./service/llm.py#L16-L19)）

## 数据库

项目不提供旧数据结构兼容或自动迁移。当前结构版本为 `schema_version = 3`；旧数据库会拒绝启动，请直接重新初始化 `storage/app.db`。浏览器缓存也只读取 `.schema3` 存储键，不读取旧键。

备份恢复和 JSON 导入同样要求 `schemaVersion` 与当前版本完全一致，不转换旧格式。

```bash
uv run python scripts/storage_admin.py backup # 生成完整备份包
uv run python scripts/storage_admin.py check # 校验数据库和文件资产
uv run python scripts/storage_admin.py vacuum # 压缩和优化数据库
uv run python scripts/storage_admin.py export-json storage/export.json # 导出
uv run python scripts/storage_admin.py import-json storage/export.json # 导入
uv run python scripts/storage_admin.py restore storage/backups/history-backup-YYYYMMDD-HHMMSS.zip --yes # 先停止数据服务，再从完整备份包恢复
```
