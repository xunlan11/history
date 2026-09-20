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

识别（OCR）与大模型都在服务端跑，数据端只负责存储、PDF 拆页与任务编排。现网数据端在
腾讯云（`wenqu.art`）、服务端在内网，两者不互通，由服务端建 SSH 反向隧道把服务端的
`8080`/`11434` 反绑到数据端回环 `18080`/`11435`，所以数据端只需这样配：

```
OCR_UPSTREAM_URL=http://127.0.0.1:18080   # 服务端 PaddleX；不设即「识别未部署」，识别接口 503
OCR_UPSTREAM_STYLE=paddlex
OCR_UPSTREAM_TIMEOUT=300
LLM_API_BASE=http://127.0.0.1:11435/v1    # 服务端 Ollama（OpenAI 兼容面）
LLM_MODEL=qwen3:8b
LLM_TIMEOUT_SECONDS=600
```

这些变量已写进本机 systemd unit，unit 版本化在 `deploy/data/`（服务端侧是
`deploy/service/`）；隧道怎么建、怎么排错见 [docs/service-deploy.md](./docs/service-deploy.md) 第 9.4/9.5 节。
同内网时可省掉隧道直连：`OCR_UPSTREAM_URL=http://10.134.194.183:8080`、
`LLM_API_BASE=http://10.134.194.183:11434/v1`。

> **数据端不跑任何模型服务**，本仓库只保留调用服务端的接口实现
> （`service/ocr_upstream.py` 走 HTTP、`service/llm.py` 走 Ollama OpenAI 兼容面）。
> 本机此前的本地 ollama（服务 / 4.9G 模型 / 二进制）与 `~/.paddlex` 模型缓存已于
> 2026-09-16 清理，依赖里也不再有 paddleocr / paddlepaddle / paddlex。
> 隧道未通时：OCR 接口 503、大模型 `/health` 报 `ready=false`，属预期。

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

跑 PaddleX PP-StructureV3（`8080`）与 Ollama + Qwen3-8B（`11434`）的机器，纯 CPU 即可，
**不落任何数据、不需要本仓库代码**，只需对数据端提供 HTTP 接口。

**完整部署手册见 [docs/service-deploy.md](./docs/service-deploy.md)**：从零部署并逐条验证过的命令
（Python/paddlepaddle 3.2.2 版本约束、模型与 Ollama 下载源、`systemctl --user` unit、
性能实测 7.5 s/页、已知坑与「哪些改动要动服务端」的边界表）。接口契约见
[docs/ocr-upstream.md](./docs/ocr-upstream.md)。
