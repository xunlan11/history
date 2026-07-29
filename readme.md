# 近代军史数智平台部署流程

## 1. 环境要求

- 静态 Web 服务
- Python 3.10+
- PaddleOCR 运行环境
- 可访问 OCR 服务端口 `8765`
- 可访问大模型统一接口端口 `8865`

## 2. 前端部署

部署以下文件和目录：

```text
index.html
styles.css
js/
```

确认 `js/config.js` 中 OCR 服务地址：

```text
http://127.0.0.1:8765/ocr
http://127.0.0.1:8765/ocr/batch
```

确认 `js/config.js` 中大模型统一接口地址：

```text
http://127.0.0.1:8865/llm
http://127.0.0.1:8865/health
```

如前端和 OCR 服务不在同一主机，改为实际 OCR 服务地址。
如前端和大模型服务不在同一主机，改为实际大模型服务地址。

## 3. OCR 服务部署

在项目根目录创建虚拟环境：

```text
python -m venv .venv
```

启用虚拟环境：

```text
.venv\Scripts\activate
```

安装依赖：

```text
pip install -r requirements.txt
```

启动 OCR 服务：

```text
uvicorn service.ocr:app --host 127.0.0.1 --port 8765
```

## 4. OCR 服务检查

访问：

```text
http://127.0.0.1:8765/health
```

返回：

```json
{
  "status": "ok"
}
```

## 5. 大模型统一接口部署

大模型统一接口与 OCR 服务共用根目录虚拟环境和根目录 `requirements.txt`。

本地默认使用 Ollama 运行 Qwen3-8B。先确认本机已安装并启动 Ollama，然后拉取模型：

```text
ollama pull qwen3:8b
```

启动大模型统一接口：

```text
uvicorn service.llm:app --host 127.0.0.1 --port 8865
```

默认配置为：

```text
LLM_PROVIDER=ollama
LLM_MODEL=qwen3:8b
LLM_API_BASE=http://127.0.0.1:11434/v1
```

如需改用其他本地模型或外部 OpenAI-compatible API，可在启动前设置以上环境变量。

## 6. 大模型统一接口检查

访问：

```text
http://127.0.0.1:8865/health
```

模型已连接时返回：

```json
{
  "status": "ok",
  "ready": true,
  "provider": "ollama",
  "model": "qwen3:8b"
}
```

如果 Ollama 未启动或本机尚未拉取 `qwen3:8b`，`ready` 会返回 `false`，网页左侧“大模型”状态会显示“待配置”。

## 7. OCR 数据目录

OCR 服务运行后生成：

```text
ocr-storage/
```

用途：

- 保存离线任务
- 保存上传源文件
- 保存 PDF 拆页图片
- 保存任务状态文件

## 8. 部署后检查

检查前端：

```text
index.html
```

检查 OCR 状态：

```text
网页左侧 OCR 状态显示为“已连接”
```

检查大模型接口状态：

```text
网页左侧大模型状态显示为“待配置”或“已连接”
```

检查在线识别：

```text
POST /ocr
```

检查离线整本处理：

```text
POST /ocr/batch
GET /ocr/batch/{taskId}
```

检查大模型统一接口：

```text
GET /llm/health
POST /llm/punctuate
POST /llm/proofread
POST /llm/extract-metadata
POST /llm/extract-events
POST /llm/chronicle
```

## 9. 版本检测与整站更新

版本服务用于首页左侧“版本”检测。它只轮询 Git 远程仓库是否有新提交；发现新版本时，页面显示“更新”按钮。点击后服务会在后台抓取整个项目，发布到新的 release 目录，检查成功后再切换 `current` 软链接。

启动版本服务：

```text
uvicorn service.version:app --host 127.0.0.1 --port 8965
```

推荐将静态 Web 服务根目录指向：

```text
.deploy/current
```

默认发布目录：

```text
.deploy/releases/
```

可选环境变量：

```text
VERSION_REMOTE=origin
VERSION_BRANCH=main
VERSION_RELEASES_DIR=/var/www/app/releases
VERSION_CURRENT_LINK=/var/www/app/current
VERSION_BUILD_COMMAND=npm run build
VERSION_HEALTH_PATH=index.html
```

如果当前没有新提交，首页显示“最新”；如果远程仓库有新提交，首页显示“更新”按钮。更新不会强制刷新正在使用中的浏览器页面，用户完成当前操作后再手动刷新即可进入新版本。
