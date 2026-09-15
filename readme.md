## 数据端

### 虚拟环境（根目录）

uv：
```bash
winget install astral-sh.uv # Windows
curl -LsSf https://astral.sh/uv/install.sh | sh # Linux / macOS
cd history
uv sync
```

### 指向服务端

```
OCR_UPSTREAM_URL=http://<服务端>:8080
LLM_API_BASE=http://<服务端>:11434/v1
```

### 对外接口

数据（SQLite）：
```
http://127.0.0.1:8665/health
http://127.0.0.1:18665/health
```

OCR：
```
http://127.0.0.1:8765/ocr
http://127.0.0.1:8765/ocr/stream
http://127.0.0.1:8765/health
```

大模型：
```
http://127.0.0.1:8865/llm
http://127.0.0.1:8865/health
```

### 数据库维护

```bash
uv run python scripts/storage_admin.py backup # 生成完整备份包
uv run python scripts/storage_admin.py check # 校验数据库和文件资产
uv run python scripts/storage_admin.py vacuum # 压缩和优化数据库
uv run python scripts/storage_admin.py export-json storage/export.json # 导出
uv run python scripts/storage_admin.py import-json storage/export.json # 导入
uv run python scripts/storage_admin.py restore storage/backups/history-backup-YYYYMMDD-HHMMSS.zip --yes # 先停止数据服务，再从完整备份包恢复
```

## 服务端

### OCR

```bash
pip install "paddlex[ocr]"
paddlex --serve --pipeline PP-StructureV3 --host 0.0.0.0 --port 8080 --device gpu:0
```

### 大模型

```bash
winget install Ollama.Ollama # Windows
curl -fsSL https://ollama.com/install.sh | sh # Linux
ollama serve # 新终端
ollama pull qwen3:8b # 新终端
```
