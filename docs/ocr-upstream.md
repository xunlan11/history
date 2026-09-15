# OCR 识别接口契约（数据端 ↔ 服务端）

> 术语：**数据端** = 部署本服务、只做存储与任务编排的服务器；**服务端** = 数据处理
> 服务器，跑 PaddleOCR / PaddleX，负责识别与版面。代码与环境变量里的 `UPSTREAM`
> 指的就是服务端。

## 1. 分工

| 角色 | 位置 | 职责 |
| --- | --- | --- |
| 数据端（`service/ocr.py`） | 本服务器 | 接收上传、PDF 拆页、任务编排、结果落盘、对外接口 |
| 服务端（数据处理服务器） | 其他设备 | 单页识别、版面结构、阅读顺序、表格/图片区域 |

数据端**不加载任何识别模型**，也**不再有自研的图像预处理与版面分析**。所有版面信息
（分块、角色、坐标、阅读顺序）都由服务端返回，数据端在 `service/ocr_upstream.py` 里
归一化后直接下发。

Nginx 前缀由 `root/nginx/conf.d/{history,literature}.conf` 剥离，前端固定访问
`/<site>/api/ocr/...`。

## 2. 数据端配置

systemd unit 中追加（示例：服务端在 `10.0.0.5:8080`）：

```ini
Environment=OCR_UPSTREAM_URL=http://10.0.0.5:8080
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OCR_UPSTREAM_URL` | 空 | 服务端基地址。**不设置即视为未部署**，识别接口一律返回 503 |
| `OCR_UPSTREAM_STYLE` | `auto` | `paddlex` / `native` / `auto`（auto：先按风格 A 调用，收到 404/405 再按风格 B） |
| `OCR_UPSTREAM_TOKEN` | 空 | 非空时按 `Authorization: Bearer <token>` 发送 |
| `OCR_UPSTREAM_TIMEOUT` | `180` | 单页识别超时（秒） |
| `OCR_UPSTREAM_HEALTH_TIMEOUT` | `5` | `/health` 探活超时（秒） |
| `OCR_UPSTREAM_HEALTH_PATH` | `/health` | 探活路径，设为 `none` 可跳过探活 |
| `OCR_UPSTREAM_GEOMETRY_FIX` | 关 | `1` 时让服务端做整页方向分类与去扭曲（见第 5 节） |

改动后：

```bash
sudo -n systemctl restart history-ocr.service literature-ocr.service
curl -s http://127.0.0.1:8765/health | python3 -m json.tool
```

## 3. 服务端契约

### 3.0 通用约定

- 全部为 `POST`，请求体 `application/json; charset=utf-8`，响应为 JSON 对象。
- 图片以 **base64**（不带 `data:` 前缀）放在请求体里。
- 服务端返回非 2xx 即视为失败；数据端把服务端状态码与响应摘要转成 503 下发。
- 超时由数据端的 `OCR_UPSTREAM_TIMEOUT` 控制，服务端应尽量避免长于该值的单页耗时。
- 坐标一律是**像素**、**左上原点**、`[x1, y1, x2, y2]`。

### 3.1 风格 A：PaddleX / PaddleOCR 官方 serving（推荐）

服务端设备：

```bash
# 仅在服务端设备执行；数据端不需要这些依赖
pip install "paddlex[ocr]"
paddlex --serve --pipeline PP-StructureV3 --host 0.0.0.0 --port 8080 --device gpu:0
```

数据端调用 `POST {OCR_UPSTREAM_URL}/layout-parsing`：

```json
{
  "file": "<base64 图片>",
  "fileType": 1,
  "filename": "page-1.png",
  "pageNumber": 1,
  "useLayoutDetection": true,
  "useTableRecognition": true,
  "useDocOrientationClassify": false,
  "useDocUnwarping": false,
  "useTextlineOrientation": true,
  "useFormulaRecognition": false,
  "useSealRecognition": false,
  "useChartRecognition": false,
  "visualize": false
}
```

`quickRead=true`（对话临时文件快速读取）时，数据端会把
`useLayoutDetection / useTableRecognition / useTextlineOrientation` 置为 `false`，
只取整页文本，换取即时性。

响应按官方结构解析（只取第一页）：

```json
{
  "result": {
    "layoutParsingResults": [
      {
        "prunedResult": {
          "doc_preprocessor_res": {"output_img_shape": [2339, 1654]},
          "parsing_res_list": [
            {"block_label": "text", "block_content": "……", "block_bbox": [80, 240, 920, 700], "block_order": 3}
          ],
          "overall_ocr_res": {
            "rec_texts": ["一、部队集结"],
            "rec_scores": [0.95],
            "rec_polys": [[[80, 240], [400, 240], [400, 280], [80, 280]]]
          }
        },
        "markdown": {"text": "整页 Markdown（可选，数据端会原样透传给前端）"}
      }
    ]
  }
}
```

解析规则：

- `parsing_res_list` 存在 → 每个元素成为一个版面块（`block_label`/`block_content`/`block_bbox`/`block_order`）。
- 否则用 `layout_det_res.boxes` 建块，再把 `overall_ocr_res` 的文本行按**行中心点落在块内**挂到对应块。
- 两者都没有 → 退化为整页单个 `text` 块。
- 阅读顺序：优先 `block_order`，缺失时按数组顺序（PaddleX 已按阅读顺序输出）。

### 3.2 风格 B：native 最小契约

服务端自行实现时按此契约即可（可以是包一层别的 OCR、也可以是自研模型）：

```
POST {OCR_UPSTREAM_URL}/ocr
```

```json
{
  "image": "<base64>",
  "filename": "page-1.png",
  "pageNumber": 7,
  "mode": "formal"
}
```

`mode`：`formal`（正式文献，需要版面）或 `quick`（只取文字）。

响应：

```json
{
  "engine": "任意可读字符串，例如 paddleocr-pp-structurev3",
  "width": 1654,
  "height": 2339,
  "blocks": [
    {
      "type": "title",
      "bbox": [100, 120, 900, 200],
      "order": 2,
      "confidence": 0.98,
      "text": "作战计划",
      "lines": [
        {"text": "作战计划", "confidence": 0.98, "polygon": [[100, 120], [500, 120], [500, 200], [100, 200]]}
      ]
    }
  ],
  "warnings": ["可选的补充提示"]
}
```

宽松之处：

- `blocks[].bbox` 也接受 `{"x":…, "y":…, "width":…, "height":…}`。
- `text` 可省略，此时用 `lines[].text` 拼。
- 可以不返回 `blocks`，直接给顶层 `lines`（每项 `{text, confidence, polygon}`）或 `text`。
- `type` 建议用下表统一角色，未知取值原样保留不影响流程。

### 3.3 统一版面角色

| 角色 | 含义 | 是否进入正文 |
| --- | --- | --- |
| `title` | 标题（含篇名、小节标题） | 是 |
| `text` | 正文（含竖排文本区域） | 是 |
| `table` / `table_title` | 表格与表题 | 是（结构化文本原样保留） |
| `figure_title` | 图题 | 是 |
| `footnote` | 脚注 | 是 |
| `aside` | 眉批、夹注、旁注 | 是 |
| `formula` / `formula_number` | 公式与编号 | 是 |
| `figure` / `chart` / `seal` | 图片、图表、印章 | 否 |
| `header` / `footer` / `page_number` | 页眉、页脚、页码 | 否 |

服务端原始标签到上述角色的映射在 `service/ocr_upstream.py` 的 `BLOCK_TYPE_MAP`。
PaddleX 的 `doc_title`、`paragraph_title`、`vertical_text`、`vision_footnote`、
`number` 等都会自动归位。

## 4. 数据端对前端下发的结构

`POST /ocr` 与 `/ocr/stream` 的每一页都返回：

```json
{
  "pageNumber": 1,
  "imageName": "page-1.png",
  "imageUrl": "http://127.0.0.1:8765/files/tasks/task-xxx/pages/page-1.png",
  "text": "正文（已剔除页眉页脚页码与图片区域）",
  "confidence": 0.93,
  "engine": "remote:paddleocr-pp-structurev3",
  "readMode": "formal",
  "width": 1654,
  "height": 2339,
  "blocks": [{"type": "text", "label": "text", "bbox": [80, 240, 920, 700], "order": 3, "confidence": null, "text": "……", "lines": []}],
  "lines": [{"text": "…", "confidence": 0.95, "polygon": [...], "bbox": [...]}],
  "markdown": "整页 Markdown（服务端提供时）",
  "warnings": ["…"],
  "upstream": {"style": "paddlex", "url": "http://10.0.0.5:8080", "latencyMs": 1234}
}
```

不再返回旧版字段 `layout`（自研版面分析）与 `preprocessing` / `preprocessedImageUrl`
（自研图像预处理），也不再有预处理图副本。

`GET /health`：

```json
{
  "status": "ok",
  "service": "ocr",
  "storage": "/home/ubuntu/Codefield/history/ocr-storage",
  "ready": true,
  "upstream": {
    "configured": true, "url": "http://10.0.0.5:8080", "style": "paddlex",
    "geometryFix": false, "healthPath": "/health",
    "reachable": true, "latencyMs": 12, "detail": "HTTP 200"
  }
}
```

`ready` 为 `false` 时前端显示「识别能力未部署」。探活结果缓存 10 秒。

## 5. 错误码

服务端相关失败统一返回 **HTTP 503**，`detail` 结构：

```json
{"code": "ocr_upstream_unavailable", "message": "…", "upstreamStatus": 500}
```

| code | 含义 | 处理 |
| --- | --- | --- |
| `ocr_upstream_not_configured` | 未设置 `OCR_UPSTREAM_URL` | 在服务端设备部署后回填环境变量并重启服务 |
| `ocr_upstream_unavailable` | 连不上服务端 / 服务端 5xx / 超时 | 检查服务端服务与网络、必要时调大 `OCR_UPSTREAM_TIMEOUT` |
| `ocr_upstream_http_error` | 服务端 4xx | 多为路径或鉴权不匹配（检查 `OCR_UPSTREAM_STYLE`、`OCR_UPSTREAM_TOKEN`） |
| `ocr_upstream_protocol_error` | 服务端返回非 JSON 或字段缺失 | 对照第 3 节核对契约 |

## 6. 几何矫正与坐标一致性

默认**关闭**服务端的整页方向分类与去扭曲（`OCR_UPSTREAM_GEOMETRY_FIX` 未开），
这样 `blocks[].bbox` / `lines[].polygon` 与数据端保存的原图**逐像素对应**，将来做
原图高亮无需换算。

若某批扫描件必须矫正才能识别，设 `OCR_UPSTREAM_GEOMETRY_FIX=1`。此时服务端坐标基于
矫正后的图像，而数据端保存的仍是原图，坐标只能作参考（数据端不保存矫正图）。

## 7. 验证

```bash
# 1. 自检：连通性 + 契约 + 归一化结果
cd ~/Codefield/history
OCR_UPSTREAM_URL=http://10.0.0.5:8080 uv run python scripts/check_ocr_upstream.py

# 2. 单页接口
curl -s -F "image=@page-1.png" -F "pageNumber=1" http://127.0.0.1:8765/ocr | python3 -m json.tool

# 3. 整本流程
curl -s -F "document=@sample.pdf" -F "documentId=demo" http://127.0.0.1:8765/ocr/stream
curl -s http://127.0.0.1:8765/ocr/stream/task-xxxxxxxxxxxx | python3 -m json.tool
```

## 8. 注意事项

- 服务端是逐页串行调用的：一本 300 页的书会依次发 300 次请求，请按服务端吞吐量评估耗时。
  数据端任务进度会写进 `ocr-storage/tasks/<taskId>/task.json`，前端逐页增量取回。
- 数据端按 `OCR_STORAGE_DIR` 隔离存储（`/literature` 实例指向 `literature-data/ocr-storage`），
  PDF 拆页图与任务记录都留在数据端，服务端无需持久化。
- 服务端不可达时，排队任务会立即失败并在任务 `message` 中给出原因；前端「已连接/未部署」
  状态取自 `/health`。
