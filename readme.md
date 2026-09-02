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

### 数据库

使用SQLite。

### OCR

使用PaddleOCR。

接口（如不在同一主机则改为实际地址）：
```
http://127.0.0.1:8765/ocr
http://127.0.0.1:8765/ocr/stream
```

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

```bash
uv run python scripts/storage_admin.py backup # 生成完整备份包
uv run python scripts/storage_admin.py check # 校验数据库和文件资产
uv run python scripts/storage_admin.py vacuum # 压缩和优化数据库
uv run python scripts/storage_admin.py export-json storage/export.json # 导出
uv run python scripts/storage_admin.py import-json storage/export.json # 导入
uv run python scripts/storage_admin.py restore storage/backups/history-backup-YYYYMMDD-HHMMSS.zip --yes # 先停止数据服务，再从完整备份包恢复
```
