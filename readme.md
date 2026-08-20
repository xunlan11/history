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
http://127.0.0.1:8765/ocr/batch
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
