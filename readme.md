# 近代军史数智平台部署流程

## 1. 环境要求

- 静态 Web 服务
- Python 3.10+
- PaddleOCR 运行环境
- 可访问 OCR 服务端口 `8765`

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

如前端和 OCR 服务不在同一主机，改为实际 OCR 服务地址。

## 3. OCR 服务部署

进入 OCR 服务目录：

```text
cd ocr-service
```

创建虚拟环境：

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
uvicorn app:app --host 127.0.0.1 --port 8765
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

## 5. OCR 数据目录

OCR 服务运行后生成：

```text
ocr-service/storage/
```

用途：

- 保存离线任务
- 保存上传源文件
- 保存 PDF 拆页图片
- 保存任务状态文件

## 6. 部署后检查

检查前端：

```text
index.html
```

检查 OCR 状态：

```text
网页左侧 OCR 状态显示为“已连接”
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
