## 虚拟环境（项目根目录）

```bash
python --version
python -m venv .venv
.venv\Scripts\activate # Windows
source .venv/bin/activate # Linux
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## 服务

### 数据库
当前使用SQLite。

启动：
```bash
python -m uvicorn service.data:app --host 127.0.0.1 --port 8665
```

检查：
```
http://127.0.0.1:8665/health
```

### OCR
当前使用PaddleOCR。

接口（如不在同一主机则改为实际地址）：
```
http://127.0.0.1:8765/ocr
http://127.0.0.1:8765/ocr/batch
```

启动：
```bash
python -m uvicorn service.ocr:app --host 127.0.0.1 --port 8765
```

检查：
```
http://127.0.0.1:8765/health

```
```json
{
  "status": "ok"
}
```

### 大模型
当前通过Ollama调用qwen3:8b。

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

启动：
```bash
python -m uvicorn service.llm:app --host 127.0.0.1 --port 8865
```

默认配置为（[service/llm.py#L16-L19](./service/llm.py#L16-L19)）

检查：
```
http://127.0.0.1:8865/health
```
```json
{
  "status": "ok",
  "ready": true,
  "provider": "ollama",
  "model": "qwen3:8b"
}
```

### 版本

启动：
```bash
python -m uvicorn service.version:app --host 127.0.0.1 --port 8965
```

## 前端

启动：
```bash
python -m http.server 8065
```

访问：
```
http://127.0.0.1:8065/index.html
```
