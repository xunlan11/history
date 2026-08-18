## 虚拟环境（根目录）

uv：
```bash
winget install astral-sh.uv # Windows
curl -LsSf https://astral.sh/uv/install.sh | sh # Linux / macOS
cd history
uv sync
```

```bash
uv run python -m uvicorn service.data:app --host 127.0.0.1 --port 8665
```

## 服务

### 数据库
当前使用SQLite。

启动：
```bash
uv run python -m uvicorn service.data:app --host 127.0.0.1 --port 8665
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
uv run python -m uvicorn service.ocr:app --host 127.0.0.1 --port 8765
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
uv run python -m uvicorn service.llm:app --host 127.0.0.1 --port 8865
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
uv run python -m uvicorn service.version:app --host 127.0.0.1 --port 8965
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

## 生产部署（子路径 /history）

线上由 `~/Codefield/root` 统一分发：根网页在 `root/`，本项目的派发片段在
`root/nginx/conf.d/history.conf`。前端部署在 `/history` 子路径下：

- 前端静态文件由 nginx 直接从 `history/` 目录提供；
- API 走 `/history/api/data|ocr|llm|version/...` 转发到对应本地服务（8665/8765/8865/8965）；
- `js/config.js` 会根据页面路径自动切换「本地直连」和「/history 代理」。

OCR 服务返回的图片地址通过环境变量配置：

```bash
OCR_PUBLIC_BASE_URL=/history/api/ocr uv run python -m uvicorn service.ocr:app --host 127.0.0.1 --port 8765
```

其余服务按上文端口正常启动即可。新增/修改派发规则见 `root/README.md`。
