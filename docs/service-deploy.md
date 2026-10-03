# 服务端部署手册（OCR + 大模型）

> 术语沿用 [ocr-upstream.md](./ocr-upstream.md)：**服务端** = 本手册部署的机器，跑
> PaddleX 与 Ollama，只提供 HTTP 接口、不存数据；**数据端** = 跑本仓库 `service/`
> 的那台服务器，负责存储与任务编排。
>
> 本文是 2026-09-15 在 `nuc-05zt`（Ubuntu 20.04, i7-1165G7）上**从零部署并逐条验证过**
> 的命令。全程不需要 `sudo`，所有文件都在 `$HOME` 下。
>
> **两套都已验证的形态**：第 0–10 节是 `nuc-05zt` 的**全 CPU** 版（大模型 4.9 tok/s）；
> 第 11 节是 `zhs22` 的 **GPU 大模型 + CPU OCR 完整版**（大模型 28～31 tok/s）。
> 两者的资产快源（ModelScope）、模型清单与 `PP-Chart2Table_safetensors` 命名差异见第 11 节。

## 0. 部署结果

| 能力 | 监听 | 接口 | 数据端对接 |
| --- | --- | --- | --- |
| OCR（PP-StructureV3） | `0.0.0.0:8080` | `POST /layout-parsing`、`GET /health` | `OCR_UPSTREAM_URL=http://<本机 IP>:8080` |
| 大模型（Ollama + Qwen3-8B） | `0.0.0.0:11434` | `POST /v1/chat/completions`、`POST /api/chat`、`GET /v1/models` | `LLM_API_BASE=http://<本机 IP>:11434/v1` |

服务端**不需要**数据库、不需要 `service/` 代码，也不需要对外开放 8765/8865 端口。

### 目录与端口

```
~/history-service/                 # 服务端运行时根目录
├── venv-ocr/                      # Python 3.11.16 虚拟环境（paddlepaddle + paddlex）
├── PP-StructureV3-cpu.yaml        # OCR 管线配置（CPU 版）
├── models/                        # Ollama 模型仓库（qwen3:8b，5.2 GB）
├── logs/                          # ocr.log / llm.log
├── test-layout-parsing.py         # OCR 冒烟测试
└── test-llm.py                    # 大模型冒烟测试
~/.local/bin/ollama                # Ollama 0.12.9（tgz 解压到 ~/.local）
~/.local/lib/ollama/               # Ollama 运行时库（3 GB，含未使用的 CUDA 库）
~/.paddlex/official_models/        # PaddleX 官方模型（1.1 GB）
~/.config/systemd/user/history-{ocr,llm}.service
```

### 实测版本

| 组件 | 版本 | 备注 |
| --- | --- | --- |
| Python | 3.11.16 | uv 从 npmmirror 安装，未动系统 `python3.8` |
| paddlepaddle | **3.2.2** | CPU 版；**不要用 3.3.1**，见第 8 节 |
| paddlex | 3.7.2 | 含 `[ocr]`、`[serving]` 两个 extra |
| Ollama | 0.12.9 | 官方 linux-amd64 tgz |
| 模型 | `qwen3:8b`（Q4_K_M, 5.2 GB） | 与数据端 `LLM_MODEL` 默认值一致 |

### 实测性能（本机 4 核 8 线程）

| 项目 | 稳态耗时 |
| --- | --- |
| OCR 单页（约 1240×1754，正文页） | **约 7.5 s/页** |
| OCR 单页（含表格，触发表格结构化） | 约 14 s/页 |
| 大模型生成 | 约 **4.9 tok/s**（关闭思考后的纯生成） |

按 7.5 s/页估算，一本 300 页的书约 40 分钟；大模型按每页 300～500 token 估算，
单页整理约 60～110 s。CPU 部署的瓶颈在大模型，见第 7 节。

## 1. 机器前提与网络

- CPU 即可，无需显卡（本机 `nvidia-smi` 驱动不通，实测不影响）。
- 磁盘：约 12 GB（依赖 2 GB + PaddleX 模型 1.1 GB + Ollama 运行时 3 GB + 模型 5.2 GB）。
- 内存：31 GB。常驻约 10 GB（PaddleX 1～2 GB + Ollama 8B 模型约 6 GB）。
- **本机网络实测**（决定了后面所有下载源的选择）：

| 目标 | 结果 |
| --- | --- |
| `pypi.org` / `files.pythonhosted.org` | 可达但极慢（≤20 KB/s），不用 |
| `mirrors.aliyun.com` | 5.5 MB/s，用作 pip 主源 |
| `www.paddlepaddle.org.cn`（paddle 轮子索引） | 快，用作 paddlepaddle 源 |
| `paddle-model-ecology.bj.bcebos.com`（PaddleX 模型库） | 5 MB/s，可用 |
| `registry.ollama.ai`（Ollama 模型仓库） | 可达，6～7 MB/s |
| `registry.npmmirror.com`（Python 二进制） | 可达，uv 的 Python 镜像 |
| **`github.com`** | **不可达**（Ollama 安装脚本会失败，见第 5 节） |
| `ghproxy.imciel.com`（GitHub 代理） | 4.4 MB/s，用它下载 Ollama tgz |

## 2. 安装 Python 与 OCR 依赖

```bash
# 2.1 用 uv 装一个独立的 Python 3.11（默认源是 GitHub，必须换成 npmmirror）
export UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone
uv python install 3.11

# 2.2 建目录与虚拟环境
mkdir -p ~/history-service/logs
uv venv ~/history-service/venv-ocr --python 3.11 --seed

# 2.3 让这个环境走阿里云 PyPI 镜像（写入 ~/.config/pip/pip.conf）
~/history-service/venv-ocr/bin/pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/
~/history-service/venv-ocr/bin/pip config set global.timeout 120

# 2.4 paddlepaddle CPU 版（必须从百度官方索引取，PyPI 上没有 CPU 轮子）
uv pip install --python ~/history-service/venv-ocr/bin/python "paddlepaddle==3.2.2" \
  --default-index https://www.paddlepaddle.org.cn/packages/stable/cpu/ \
  --index https://mirrors.aliyun.com/pypi/simple/

# 2.5 PaddleX：ocr 管依赖 + serving 服务化依赖（fastapi/uvicorn）
uv pip install --python ~/history-service/venv-ocr/bin/python \
  --index https://mirrors.aliyun.com/pypi/simple/ "paddlex[ocr]" "paddlex[serving]"
```

安装后自检：

```bash
~/history-service/venv-ocr/bin/python -c "import paddle, paddlex; print(paddle.__version__, paddlex.__version__)"
# 3.2.2 3.7.2
```

## 3. OCR 管线配置

官方默认配置在 `site-packages/paddlex/configs/pipelines/PP-StructureV3.yaml`。
本部署**只改一项**：关掉公式识别子管线（`PP-FormulaNet_plus-L` 约 1 GB，且数据端
每次请求都传 `useFormulaRecognition=false`，本来就不会用）。

```bash
SP=~/history-service/venv-ocr/lib/python3.11/site-packages/paddlex
cp $SP/configs/pipelines/PP-StructureV3.yaml ~/history-service/PP-StructureV3-cpu.yaml
sed -i 's/^use_formula_recognition: True/use_formula_recognition: False/' \
  ~/history-service/PP-StructureV3-cpu.yaml
diff $SP/configs/pipelines/PP-StructureV3.yaml ~/history-service/PP-StructureV3-cpu.yaml
```

配置里几个关键开关（下表的作用都在**生效实现** `pipeline_v2.py` 上核对过，
不是 `pipeline.py`）：

| 开关 | 值 | 实际作用 |
| --- | --- | --- |
| `use_doc_preprocessor` | `False` | **单写这一行不生效**，原因见第 8 节第 6 条 |
| `use_doc_orientation_classify` / `use_doc_unwarping` | 未写（在 3.7.2 里等同 `True`） | 于是 DocPreprocessor 子管线仍会初始化（启动日志有 `Creating model: ('UVDoc', ...)`），这样数据端 `OCR_UPSTREAM_GEOMETRY_FIX=1` 才有的可用 |
| `use_formula_recognition` | `False` | 本次唯一的改动，省掉约 1 GB 的 `PP-FormulaNet_plus-L`；请求若传 `true` 会 500 |
| `use_table_recognition` | `True` | 数据端 `formal` 模式要表格结构化（加载表格分类/结构/单元格共 4 个模型） |
| `use_seal_recognition` | `False` | 请求若传 `true` 会 500（`the input params for model setting ...`） |
| `use_chart_recognition` | `False` | 请求若传 `true` 会 500（`AttributeError: ... no attribute 'chart_recognition_model'`）；数据端本来就传 false |
| `use_region_detection` | `True` | **确实生效**：加载 `PP-DocBlockLayout` 做文档块区域检测，影响分块与阅读顺序 |

请求模型（`serving/schemas/pp_structurev3.py`）里没声明的字段会被忽略——数据端发的
`filename` / `pageNumber` 就属于这类，不影响识别。

**逐页是否做几何矫正由请求参数决定，不由这几个配置键决定**：

- 数据端 `service/ocr_upstream.py` 每次都显式发这两个字段
  （`useDocOrientationClassify` / `useDocUnwarping` = `geometry_fix_enabled()`，默认 `false`），
  所以默认情况下每一页都不会矫正，`block_bbox` 与数据端原图逐像素对应。
  实测：显式传 false 时响应里是 `model_settings.use_doc_preprocessor = false`。
- 反例：请求里**不传**这两个字段时，服务端按 `True` 处理，会真的做方向分类 + 去扭曲
  （CPU 上很慢，且坐标相对原图偏移）。实测同上：不传时
  `model_settings.use_doc_preprocessor = true`。所以自研客户端务必显式传这两个字段。
- 想彻底不加载这套模型（省约 60 MB 内存、启动略快），在 YAML 顶部同时写三行即可：

  ```yaml
  use_doc_preprocessor: False
  use_doc_orientation_classify: False
  use_doc_unwarping: False
  ```

  代价：数据端 `OCR_UPSTREAM_GEOMETRY_FIX=1` 会变成 500（模型未初始化），
  需要恢复矫正能力时把配置改回来并重启。

配置副本已入库：`deploy/service/PP-StructureV3-cpu.yaml`。

## 4. 拉取 PaddleX 官方模型

> 本节的源与清单只适用于第 0–10 节的**全 CPU 精简版**。若采用第 11 节的形态
> （ModelScope 快源、完整版 15 个模型、图表模型要用 `PP-Chart2Table_safetensors`），
> 直接用第 11.2 节的 `fetch-assets.py`，**不要照抄下面的 curl 清单**。

默认模型源是 HuggingFace（本机不可达），必须改成百度 BOS：

```bash
export PADDLE_PDX_MODEL_SOURCE=bos      # 已写进 systemd unit
```

PaddleX 首次启动会自己下载，但内置下载器实测只有 0.3 MB/s。**推荐用 curl 预取**，
12 个模型合计约 1.1 GB，用 4 路并行 1 分钟即可：

```bash
cd /tmp && rm -rf mdl && mkdir mdl && cd mdl
for m in PP-DocLayout_plus-L PP-DocBlockLayout PP-OCRv5_server_det PP-OCRv5_server_rec \
         PP-LCNet_x1_0_textline_ori PP-LCNet_x1_0_doc_ori PP-LCNet_x1_0_table_cls \
         SLANeXt_wired SLANet_plus RT-DETR-L_wired_table_cell_det \
         RT-DETR-L_wireless_table_cell_det UVDoc; do
  curl -sL --retry 3 -o "$m.tar" \
    "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${m}_infer.tar" &
done
wait

# 解包：tar 内层是 <Model>_infer/，需要剥掉两层
for m in *.tar; do
  n="${m%.tar}"; n="${n%_infer}"
  mkdir -p ~/.paddlex/official_models/"$n"
  tar -xf "$m" -C ~/.paddlex/official_models/"$n" --strip-components=2
done
```

放好后启动日志会显示 `Model files already exist. Using cached files.`，不再联网。

## 5. 安装 Ollama（无 sudo）

GitHub 不可达，`curl -fsSL https://ollama.com/install.sh | sh` 会失败，改用官方
tgz + 代理：

```bash
# 5.1 下载（1.8 GB，实测 4.4 MB/s）
curl -L --retry 3 -o /tmp/ollama-linux-amd64.tgz \
  "https://ghproxy.imciel.com/https://github.com/ollama/ollama/releases/download/v0.12.9/ollama-linux-amd64.tgz"

# 5.2 解压到 ~/.local（得到 ~/.local/bin/ollama 与 ~/.local/lib/ollama）
tar -xzf /tmp/ollama-linux-amd64.tgz -C ~/.local
~/.local/bin/ollama --version     # ollama version is 0.12.9

# 5.3 拉模型（走 registry.ollama.ai，与 GitHub 无关；5.2 GB，约 6.5 MB/s）
OLLAMA_MODELS=$HOME/history-service/models ~/.local/bin/ollama pull qwen3:8b
```

> 若代理换域名，或想装其它版本，把 URL 里的版本号改掉即可；备选代理
> `gh.xxooo.cf`、`ghfast.top`（后者实测不稳定）。其他机器若 GitHub 可用，
> 直接用官方 `ollama.com/install.sh` 更省事。

## 6. 常驻与开机自启（systemd --user）

unit 文件已入库：`deploy/service/history-ocr.service`、`deploy/service/history-llm.service`。

> `deploy/service/` 下两类文件性质不同：
>
> | 文件 | 性质 |
> | --- | --- |
> | `history-ocr.service`、`history-llm.service` | **生效资产**（仓库里的版本化源头，systemd 读的是 `~/.config/systemd/user/` 副本） |
> | `PP-StructureV3-cpu.yaml` | **生效资产**（服务启动时读 `~/history-service/PP-StructureV3-cpu.yaml`，这里是同一份的副本） |
> | `test-layout-parsing.py`、`test-llm.py` | **仅验证用**，不参与服务运行 |
>
> 仓库副本与运行时副本是**互相独立的两个文件**（不是符号链接），所以改了仓库里的
> 配置/unit 之后**必须重新 `cp` 回去再重启**，否则服务行为不会变：
>
> ```bash
> cp ~/history/deploy/service/PP-StructureV3-cpu.yaml ~/history-service/
> cp ~/history/deploy/service/history-{ocr,llm}.service ~/.config/systemd/user/
> systemctl --user daemon-reload
> systemctl --user restart history-ocr.service history-llm.service
> ```

```bash
mkdir -p ~/.config/systemd/user
cp ~/history/deploy/service/history-{ocr,llm}.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now history-ocr.service history-llm.service

# 允许未登录/重启后自动拉起（本机实测免密成功；若提示需要鉴权，手动执行一次即可）
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger      # Linger=yes
```

两个 unit 里的关键环境变量：

| unit | 变量 | 值 | 作用 |
| --- | --- | --- | --- |
| `history-ocr` | `PADDLE_PDX_MODEL_SOURCE` | `bos` | 模型源（默认 huggingface 不可达） |
| `history-ocr` | `OMP_NUM_THREADS` | `8` | CPU 线程数 |
| `history-llm` | `OLLAMA_HOST` | `0.0.0.0:11434` | 对外监听 |
| `history-llm` | `OLLAMA_MODELS` | `%h/history-service/models` | 模型仓库位置 |
| `history-llm` | `OLLAMA_KEEP_ALIVE` | `24h` | 模型常驻内存，避免每次请求重新加载（CPU 上加载一次约 1 分钟） |

日常运维：

```bash
systemctl --user status history-ocr.service history-llm.service   # 状态
systemctl --user restart history-ocr.service                      # 重启（约 40 s 就绪）
systemctl --user stop history-llm.service                         # 停止
journalctl --user -u history-ocr.service -n 50                    # 或看日志文件
tail -f ~/history-service/logs/ocr.log ~/history-service/logs/llm.log
```

> OCR 启动要加载 12 个模型（约 40 s），`Restart=always` 保证崩溃后自动重启。
> 改完 unit 记得 `systemctl --user daemon-reload` 再 restart。

## 7. 验证

```bash
# 7.1 OCR 健康检查（数据端探活用的就是这个）
curl -s http://127.0.0.1:8080/health -o /dev/null -w "ocr health=%{http_code}\n"

# 7.2 OCR 契约冒烟（自动生成测试图，按数据端请求体调用 /layout-parsing）
~/history-service/venv-ocr/bin/python ~/history-service/test-layout-parsing.py
# 耗时 7.5s；返回字段 ['height', 'layout_det_res', 'overall_ocr_res', 'page_count',
#                      'parsing_res_list', 'width']
# 版面块 4 个： - text order=1 bbox=[77, 139, 203, 150] text='OCRUPSTREAM SELFTEST'

# 7.3 表格页（验证表格结构化分支）
~/history-service/venv-ocr/bin/python ~/history-service/test-layout-parsing.py /tmp/table-page.png
# 返回字段里会多出 table_res_list，table 块的 block_content 是 HTML 表格，markdown 同步生成

# 7.4 大模型（OpenAI 兼容面，数据端 /health 用的就是这个）
curl -s http://127.0.0.1:11434/v1/models
# {"object":"list","data":[{"id":"qwen3:8b", ...}]}
~/history-service/venv-ocr/bin/python ~/history-service/test-llm.py

# 7.5 纯生成速度（think=false，排除思考开销）
curl -s http://127.0.0.1:11434/api/chat -H 'Content-Type: application/json' \
  -d '{"model":"qwen3:8b","think":false,"stream":false,
       "messages":[{"role":"user","content":"把“第一军向徐州集结”加标点"}],
       "options":{"num_predict":64}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['message']['content'],
      round(d['eval_count']/(d['eval_duration']/1e9), 2), 'tok/s')"

# 7.6 从数据端机器上做最终联通性验证（走反向隧道，见第 9.5 节）
#     cd ~/Codefield/history && OCR_UPSTREAM_URL=http://127.0.0.1:18080 uv run python scripts/check_ocr_upstream.py
```

## 8. 已知坑

1. **paddlepaddle 3.3.1 在 CPU 上不可用**：`/layout-parsing` 直接 500——
   `NotImplementedError: (Unimplemented) ConvertPirAttribute2RuntimeAttribute not
   support [pir::ArrayAttribute<pir::DoubleAttribute>] (onednn_instruction.cc:116)`。
   降级到 `3.2.2` 且保留 oneDNN 后，单页从 24.5 s 降到 7.5 s。升级 paddlepaddle 前
   务必重跑 7.2。
2. **`/no_think` 不生效**：数据端 prompt 里的 `/no_think` 只对部分模板有效；Ollama
   0.12.9 上 Qwen3 仍会先输出一大段思考（实测一次 595 token，耗时 153 s）。原生
   `/api/chat` 传 `"think": false` 会降到 7 token / 1.4 s。**见第 9 节的数据端改法。**
3. Ollama 0.12.9 的 **OpenAI 面不认 `think` 字段**（会被忽略），要关思考得用
   `reasoning_effort: "none"`；数据端默认走原生 `/api/chat`，用 `think: false`。
4. `--device cpu` 下 Ollama 会自动探测 GPU；本机驱动异常时会自动退回 CPU 并打印
   警告，可忽略（真要彻底屏蔽可加 `Environment=CUDA_VISIBLE_DEVICES=`）。
5. 服务端不落任何数据，PDF 拆页、任务记录都在数据端；服务端只需保证
   `parsing_res_list` 的 `block_bbox` 是**原图像素坐标**（第 3 节讲的两个请求字段
   就是为此）。
6. **`use_doc_preprocessor: False` 在 paddlex 3.7.2 上不生效**：判定写在
   `inference/pipelines/layout_parsing/pipeline_v2.py`：

   ```python
   if (config.get("use_doc_preprocessor", True)
       or config.get("use_doc_orientation_classify", True)
       or config.get("use_doc_unwarping", True)):
       self.use_doc_preprocessor = True
   ```

   后两个键没写时默认 `True`，或运算结果仍然是 `True`，于是 DocPreprocessor 子管线
   照样初始化（启动日志里看得到 `Creating model: ('UVDoc', ...)`）。真正决定逐页
   行为的是**请求字段**，详见第 3 节。
7. **PaddleX 服务化是串行的**：`PADDLE_PDX_SERVING_SERIAL_PIPELINE_CALLS` 默认
   `True`，所有请求排同一个 worker 线程——并发调用只会排队（不会报错），单页耗时
   会随之拉长。CPU 机器上别指望靠并发提速，数据端保持逐页串行调用即可。
8. **`PP-Chart2Table` 在 paddlex 3.7.2 上要的是 `PP-Chart2Table_safetensors`**：
   模型名解析在 `inference/utils/official_models.py::_format_download_model_name()`，
   默认 safetensors 格式会把名字拼成 `<name>_safetensors`。只预取旧的 `PP-Chart2Table`
   （pdparams，1.4 GB）**不会被使用**：服务启动到图表子管线时会改去百度 BOS 以
   0.19 MB/s 重下 2.1 GB（实测卡在这一步 300 s 仍未就绪）。正确清单见第 11.2 节。

## 9. 数据端需要做什么

### 9.1 只是对接：改环境变量

在数据端（跑 `service/` 的机器）的 systemd unit 或启动环境里设置。数据端 unit
已版本化在 `deploy/data/*.service`：

```ini
Environment=OCR_UPSTREAM_URL=http://127.0.0.1:18080
Environment=OCR_UPSTREAM_STYLE=paddlex
Environment=OCR_UPSTREAM_TIMEOUT=300
Environment=LLM_API_BASE=http://127.0.0.1:11435/v1
Environment=LLM_MODEL=qwen3:8b
Environment=LLM_TIMEOUT_SECONDS=600
Environment=LLM_PROVIDER=ollama
```

> 这里的 `18080` / `11435` 是**服务端 8080 / 11434 经 SSH 反向隧道反绑到数据端回环**
> 的端口（现网数据端在腾讯云、服务端在内网，无法直连，见第 9.4、9.5 节）。
> 两台机器同内网时可直接写 `http://10.134.194.183:8080`、`http://10.134.194.183:11434/v1`。

| 变量 | 为什么这么设 |
| --- | --- |
| `OCR_UPSTREAM_URL` | 服务端地址（现网=隧道本地端口 18080）。**不设就是「识别能力未部署」，识别接口一律 503** |
| `OCR_UPSTREAM_STYLE=paddlex` | 服务端就是 PaddleX 官方 serving，写死省一次 404 探测 |
| `OCR_UPSTREAM_TIMEOUT=300` | CPU 单页 7.5 s 起，扫描件大页/多列竖排会更慢，默认 180 太紧 |
| `LLM_API_BASE` | Ollama 的 OpenAI 兼容面（现网=隧道本地端口 11435；`/health` 会查它的 `/models`） |
| `LLM_TIMEOUT_SECONDS=600` | 默认 180 s：8B 模型在 CPU 上约 4.9 tok/s，一页动辄 60～110 s，长页必超时 |

验证（在数据端机器上执行）：

```bash
cd ~/Codefield/history
OCR_UPSTREAM_URL=http://127.0.0.1:18080 uv run python scripts/check_ocr_upstream.py
curl -s http://127.0.0.1:11435/v1/models                        # 隧道通了才有响应，应含 qwen3:8b
curl -s http://127.0.0.1:8865/health | python3 -m json.tool     # 大模型聚合接口应 ready=true
curl -s http://127.0.0.1:8765/health | python3 -m json.tool     # OCR 接口 upstream.reachable 应为 true
```

### 9.2 必做：关掉 Qwen3 的思考模式

`service/llm.py` 的 `call_ollama_chat_completion()` 里给 payload 加一个字段即可
（默认 `LLM_PROVIDER=ollama` 走的就是这个函数）：

```python
payload = {
    "model": LLM_MODEL,
    "messages": normalize_ollama_messages(messages),
    "stream": False,
    "think": False,            # ← 新增：Qwen3 关闭思考，省掉 5～8 倍 token
    "options": {"temperature": temperature},
}
```

不加的后果：同样一句话，返回 7 token 变成 595 token，单页整理从约 20 s 变成 150 s 以上。
注意 `think` 只对思考型模型有效，若把 `LLM_MODEL` 换成 `qwen2.5:7b-instruct` 之类
非思考模型，请把这一行去掉。

同时建议保留 prompt 里的 `/no_think`（无害，且换成别的推理后端时可能有用）。

### 9.3 想要更快（可选）

| 取舍 | 做法 | 效果 |
| --- | --- | --- |
| 大模型换小 | 服务端 `ollama pull qwen3:4b`，数据端 `LLM_MODEL=qwen3:4b` | 约 2 倍速度，专名/断句质量略降 |
| OCR 换轻量模型 | 把 `PP-StructureV3-cpu.yaml` 里 `GeneralOCR` 的 `PP-OCRv5_server_det/rec` 换成 `PP-OCRv5_mobile_det/rec` | 单页约减半，精细印刷体识别率略降 |
| 关表格 | 数据端不再传 `useTableRecognition=true`，配置里也置 `False` | 省掉表格分类/结构/单元格 4 个模型，单页快约 5 s |
| 上 GPU | 服务端换带可用 CUDA 的机器：`--device gpu:0`，Ollama 自动用 GPU | OCR 快 10 倍以上，大模型 20～50 tok/s |

### 9.4 网络形态：数据端在公网，服务端在内网（现网）

现网数据端是腾讯云 VM（`192.144.141.60`，域名 `wenqu.art`），服务端在家庭/办公内网
（`10.134.194.183`，DHCP）。两者**没有直连路由**（实测数据端 ping / 8080 / 11434 全部不通，
数据端也没有任何 VPN 进程），因此由服务端**主动**向数据端建立 SSH 反向隧道：

- 数据端不需要开放任何新入站端口（隧道反绑在 `127.0.0.1`，`GatewayPorts no` 保证公网访问不到）；
- 服务端不需要公网地址，只需能出站 22；
- 服务端换 IP、服务端重启都不影响数据端配置；只有数据端地址变化时才要改隧道 unit。

端口为什么是 `18080` / `11435` 而不是 `8080` / `11434`：数据端曾经跑本地 ollama 占着
`11434`，取其错开可避免冲突；**数据端的本地模型服务已于 2026-09-16 全部清理**（本地
ollama 服务 / 模型 / 二进制、`~/.paddlex` 模型缓存都没了），端口保持现状不改——改端口要
同时动隧道 unit 与数据端 unit，没有收益。

| 项目 | 值 |
| --- | --- |
| 隧道 unit（服务端） | `deploy/service/history-tunnel.service` |
| 数据端 unit（版本化） | `deploy/data/history-{data,ocr,llm}.service`、`deploy/data/literature-{data,ocr}.service` |
| 隧道目标 | `tunneluser@192.144.141.60:22`（数据端公网上的**专用只转发账号**，登录 shell 为 nologin） |
| 反绑端口 | `127.0.0.1:18080` → 服务端 `8080`；`127.0.0.1:11435` → 服务端 `11434` |

同内网自建时可省掉隧道，直接写 `http://10.134.194.183:8080` / `http://10.134.194.183:11434/v1`。

运维注意：

- 隧道只走 22 出站；数据端 sshd 现状（`sshd -T` 实测）已满足：
  `PasswordAuthentication no`、`PubkeyAuthentication yes`、`AllowTcpForwarding yes`、
  `GatewayPorts no`、`PermitListen any` —— **无需改 sshd 配置**。
- 数据端 `ufw` 未启用（`/etc/ufw/ufw.conf` 里 `ENABLED=no`），隧道不涉及放行；
  **若以后启用 ufw**，也只需保留 22/80/443，不需要 8080/11434。
- 服务端两个服务都绑 `0.0.0.0`（`ss -ltn | grep -E ':(8080|11434)'` 可确认），
  隧道从本机回环接入，天然可用。
- 服务端侧 `history-ocr` / `history-llm` / `history-tunnel` 都是 `systemctl --user`
  + `Restart=always`，且已 `enable-linger`，重启后免登录自动拉起。
- 隧道断了的表现：服务端 `systemctl --user status history-tunnel` 非 active，
  数据端 `/health` 的 `upstream.reachable=false`、大模型 `ready=false`。
- 服务端升级/迁移后，务必在数据端重跑 `scripts/check_ocr_upstream.py` 与 `/health`。

### 9.5 建立反向隧道（一次配置，服务端执行）

**第 1 步：服务端生成专用隧道密钥**（不要复用个人密钥；数据端保持 `PasswordAuthentication no`）
文件名要和 unit 里的 `-i %h/.ssh/cloud-tunnel` 一致：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/cloud-tunnel -N "" -C wenqu-tunnel
cat ~/.ssh/cloud-tunnel.pub
```

**第 2 步：把公钥加到数据端的 `tunneluser` 账号**（在数据端执行，`<公钥>` 换成上一步输出；
`restrict` 关闭一切能力后再只打开 forwarding，`permitlisten` 限定只能反绑这两个回环端口）

```bash
sudo -u tunneluser mkdir -p ~tunneluser/.ssh && sudo -u tunneluser chmod 700 ~tunneluser/.ssh
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:18080",permitlisten="127.0.0.1:11435" %s\n' \
  '<公钥>' | sudo tee -a ~tunneluser/.ssh/authorized_keys >/dev/null
sudo chown tunneluser: ~tunneluser/.ssh/authorized_keys && sudo chmod 600 ~tunneluser/.ssh/authorized_keys
```

> `tunneluser` 的 shell 用 nologin 即可（unit 是 `ssh -N`，不需要交互 shell）；
> 实测连上去会打印 `This account is currently not available.`，**这不影响转发**，
> 只要不报 `Permission denied` 就说明密钥已生效。

**第 3 步：服务端装 unit 并启动**

```bash
cp ~/history/deploy/service/history-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now history-tunnel.service
systemctl --user status history-tunnel.service --no-pager | head -20
```

**第 4 步：在数据端验证**

```bash
ss -ltn | grep -E ':(18080|11435)'                       # 两个端口应在 127.0.0.1 上监听
curl -s -o /dev/null -w "ocr health=%{http_code}\n" http://127.0.0.1:18080/health    # 200
curl -s http://127.0.0.1:11435/v1/models | head -c 200   # 含 qwen3:8b
```

**排错**

| 现象 | 处理 |
| --- | --- |
| 数据端看不到 18080/11435 | 看服务端 `journalctl --user -u history-tunnel -n 50` |
| `remote port forwarding failed for listen port 18080`（或 11435） | 两种原因：(1) `permitlisten` 写错；(2) 该端口在**数据端**已被上一次的隧道会话占着。第 2 种在服务端崩溃/重启后极常见——服务端侧已随重启清干净，但数据端 sshd 仍持有那条半开连接的监听 socket，默认要等 TCP keepalive（约 2 h）才回收。**只在服务端 `pkill` 没用。** 清法：在数据端用 `sudo ss -ltnp` 找到监听 18080/11435 的 `sshd: tunneluser@` 子进程，`sudo kill <pid>`（或 `sudo pkill -f 'tunneluser@'`，不必重启 sshd）。unit 的 `Restart=always` 会在端口释放后自动接上 |
| 端口在、请求 502/连接被拒 | 服务端对应服务没起来：`systemctl --user status history-ocr history-llm`（OCR 首次加载 12 个模型约 40 s，`Restart=always` 会自愈） |
| 用一会儿就断 | `ServerAliveInterval=30` 已在 unit 里；网络抖动导致的断开由 `Restart=always` + `RestartSec=10` 重建，无需人工干预 |
| 换数据端地址/域名 | 改 `history-tunnel.service` 里 `tunneluser@<数据端>`，`cp` 回 `~/.config/systemd/user/` 后 `daemon-reload` + `restart` |

## 10. 接口边界：哪些改动要动服务端

两个服务是独立进程，通过 HTTP 通信，**不加载数据端任何代码**。所以判断标准只有一条：
**这次改动有没有改变「请求/响应的形状或取值含义」**，而不是「改了多少代码」。

### 不用动服务端（绝大多数改动）

- 前端：`html/`、`js/`、`styles.css`；后端存储与编排：`service/data.py`、
  `service/extract.py`、`service/chronology.py`、`service/version.py`、
  `scripts/storage_admin.py`、数据库结构、导出、检索、批注、账号等。
- 数据端内部重构，只要仍然按 `docs/ocr-upstream.md` 第 3 节发请求、按第 4 节解析响应。
- 数据端新增接口、调整任务队列/并发/进度展示（服务端无状态，不会因此失效）。
- 数据端部署发布、重启、升级：服务端**不需要**跟着重启。

### 必须动服务端（视为接口变更）

| 数据端改动 | 服务端要做什么 |
| --- | --- |
| 把 `OCR_UPSTREAM_GEOMETRY_FIX` 设为 `1`（开几何矫正） | 已经能用（DocPreprocessor 已加载）。若按第 3 节把它彻底关掉过，则要改回配置并重启 |
| 请求里把 `useFormulaRecognition` 改成 `true` | 当前**会 500**（`Internal server error`，公式子管线未初始化）。需在 YAML 里置 `use_formula_recognition: True`、重启（会多下约 1 GB 模型） |
| 请求里把 `useSealRecognition` 改成 `true` | 当前**会 500**（`the input params for model setting ...`）。需在 YAML 里置 `use_seal_recognition: True` 并重启 |
| 请求里把 `useChartRecognition` 改成 `true` | 当前**会 500**（`chart_recognition_model` 未初始化）。需在 YAML 里置 `use_chart_recognition: True` 并重启（会多下 `PP-Chart2Table`） |
| 改 `LLM_MODEL` 换成服务端没拉过的模型 | 先在服务端 `ollama pull <模型>`，否则数据端 `/health` 的 `ready` 会是 `false` |
| 改 `LLM_PROVIDER`（`ollama` → 别的） | 调用路径会变（`/api/chat` → `/v1/chat/completions`），需确认服务端提供对应接口 |
| 给 Ollama 请求加 `"think": false` 后，又把模型换成非思考模型 | 需去掉 `think` 字段（该参数只对思考型模型有效，未实测非思考模型下的行为） |
| 改单页超时/吞吐预期（例如要求更快） | 只能改服务端：换小模型、换 OCR mobile 模型、关表格，或上 GPU（第 9.3 节） |

### 判断口诀

- 只是「谁调用、怎么存、怎么显示」变了 → 服务端不动。
- 「多传一个为 `true` 的开关」「换模型名」「改超时」→ 先看上面这张表。
- 拿不准就用两次请求自证：改完在数据端跑 `scripts/check_ocr_upstream.py` 与
  `/llm/health`，两条都通过就说明边界没破。

## 11. GPU 大模型 + CPU OCR 完整版（`zhs22` 实测，2026-10-03）

第 0–10 节是 `nuc-05zt` 的**全 CPU** 版。本机 `zhs22`（Ubuntu 22.04.5、20 核、31 GB、
RTX 3060 Laptop **6 GB**、驱动 580.178.04 / CUDA 13.0）采用**大模型走 GPU、OCR 仍留 CPU**
的形态：6 GB 显存放不下 Qwen3-8B 的 5.2 GB 权重 **再加上** PP-StructureV3 完整版
（方向矫正 + 表格 + 公式 + 印章 + 图表全开）约 4 GB 的权重，两者无法同时驻留。

### 11.1 与第 0–10 节的差异

| 项目 | 第 0–10 节（`nuc-05zt`） | 本节（`zhs22`） |
| --- | --- | --- |
| 依赖 / 模型源 | 阿里云 PyPI + 百度 BOS（实测 0.19 MB/s） | **ModelScope CDN**（本机出口上限约 1.2 MB/s，比 BOS 快约 6 倍） |
| 8B 权重 | `ollama pull qwen3:8b`（registry 实测 0.09 MB/s） | **ModelScope GGUF + Modelfile**（实测约 1.1 MB/s） |
| Ollama | 0.12.9 tgz | **0.35.1 tar.zst**（自带 `lib/ollama/cuda_v12` 与 `cuda_v13`） |
| 大模型 | CPU，4.9 tok/s | **GPU**，`ollama ps` 显示 `25%/75% CPU/GPU`，**28～31 tok/s** |
| OCR | 精简版（关公式 / 印章 / 图表） | **完整版**（全开），仍为 CPU |
| 监听 | `0.0.0.0:8080` / `0.0.0.0:11434` | `127.0.0.1:8080` / `127.0.0.1:11434` + 第 9.5 节反向隧道 |

### 11.2 资产预取（串行，约 3 小时）

`deploy/service/fetch-assets.py` 一次把 Ollama 二进制、Qwen3-8B GGUF、完整版 **15** 个
PaddleX 模型落到运行位置（`~/history-service/dl`、`~/history-service/gguf`、
`~/.paddlex/official_models`）。

```bash
python3 ~/history/deploy/service/fetch-assets.py            # 串行全量（可反复重跑，断点续传）
python3 ~/history/deploy/service/fetch-assets.py --verify   # 只做 sha256 校验，不下载
```

- **默认串行**（`--workers 1`）：本机出口带宽是硬上限（约 1.2 MB/s），并行只会互相抢。
- 每个传输带 `--speed-limit 51200 --speed-time 45`：低速超过 45 s 自动断开重试，避免干挂。
- 实测：17/17 任务完成；`--verify` 66 个文件、0 问题。有效资产约 10 GB
  （Ollama 1.4 + GGUF 4.8 + PaddleX 4.0），另有 1.4 GB 因第 8 节第 8 条的命名坑作废。

### 11.3 Ollama 0.35.1 + Qwen3-8B（GPU）

```bash
mkdir -p ~/history-service/ollama
tar --zstd -xf ~/history-service/dl/ollama-linux-amd64.tar.zst -C ~/history-service/ollama
~/history-service/ollama/bin/ollama --version      # → 0.35.1；unit 的 ExecStart 就指这里

OLLAMA_MODELS=$HOME/history-service/models ~/history-service/ollama/bin/ollama serve &
OLLAMA_HOST=127.0.0.1:11434 ~/history-service/ollama/bin/ollama create qwen3:8b \
    -f ~/history/deploy/service/Modelfile.qwen3-8b
```

> Modelfile 里的 `FROM` 是**相对路径**，`ollama create` 按 **Modelfile 所在目录**解析它
> （实测：用仓库那份重建得到的 ID 与绝对路径版完全一致，都是 `e886af8fc1f9`）。
> 所以必须写 `-f ~/history/deploy/service/Modelfile.qwen3-8b`，不要拷到临时目录再执行。

GPU 生效确认（`OLLAMA_DEBUG=1` 启动日志）：

```
inference compute id=0 library=CUDA compute=8.6 name=CUDA0
  description="NVIDIA GeForce RTX 3060 Laptop GPU" driver=13.0 total="5.6 GiB" available="5.2 GiB"
```

| 实测项 | 值 |
| --- | --- |
| 常驻显存 | `llama-server` 4250 MiB；整卡 4681 / 6144 MiB |
| 分层 | `ollama ps` → `25%/75% CPU/GPU`（5.8 GB 放不进 5.2 GiB 可用显存，自动溢出部分到 CPU） |
| 首答 | 10 token / 0.32 s = **30.99 tok/s**（另含 24.8 s 首次加载） |
| 常驻后 | 32 token / 1.1 s = **28.24 tok/s** |
| 冷启动（重启后首次调用） | `time` 实测约 **130 s**：主要耗在首次加载模型，加载完成后同一请求仅 2.0 s；随后复测 32 token / 1.15 s = **27.75 tok/s** |

### 11.4 OCR 完整版（CPU）

`PP-StructureV3-cpu.yaml` 四个开关全开（`use_doc_preprocessor` / `use_seal_recognition` /
`use_formula_recognition` / `use_chart_recognition`），服务启动加载 15 个模型、**约 40 s**
就绪。逐页是否做几何矫正仍由**请求字段**决定（第 3 节），数据端默认行为不变。

```bash
systemctl --user enable --now history-ocr.service
curl -s http://127.0.0.1:8080/health        # {"errorCode":0,"errorMsg":"Healthy"}
```

| 实测项（`test-layout-parsing.py`） | 值 |
| --- | --- |
| 合成文本页（默认参数） | 8.7 s，4 个版面块，`block_bbox` 与原图逐像素对应 |
| 合成文本页（`--full --preprocess`） | 6.2 s，响应里 `model_settings` 六个开关全为 `True` |
| 合成表格页 | 7.9 s，返回 `table_res_list`，`block_content` 为 HTML 表格 |

> 9.3 节「上 GPU」这张牌在本机打不出来——显存不足，OCR 只能留 CPU。

### 11.5 常驻与自启

```bash
cp ~/history/deploy/service/history-{ocr,llm,tunnel}.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now history-ocr.service history-llm.service history-tunnel.service
loginctl enable-linger "$USER"
```

- 三个 unit 都绑 `127.0.0.1`，数据端经第 9.5 节的反向隧道（`18080`→8080、`11435`→11434）
  接入；同内网直连时把 `--host` 与 `OLLAMA_HOST` 改成 `0.0.0.0` 即可。
- 隧道 unit 带 `ExitOnForwardFailure=yes`：远端端口反绑失败会立刻退出，由 `Restart=always`
  重试 —— 因此「ssh 进程还在」等价于「远端端口已绑上」。
- 服务端换机 / 升级后，在数据端重跑 `scripts/check_ocr_upstream.py` 与 `/llm/health`。

### 11.6 本节的坑

见第 8 节第 8 条（`PP-Chart2Table_safetensors`）。另：本机 `HTTP(S)_PROXY` 默认指向本机 Clash
（`127.0.0.1:7897`）—— `fetch-assets.py` 已显式 `--noproxy '*'`，`ollama` 客户端对回环地址
不走代理，都无需额外处理；但**手工 curl 下载时要留意**，别被代理带偏。
