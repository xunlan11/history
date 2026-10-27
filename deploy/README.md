# history / literature 部署手册（面向执行代理）

> **读者**：执行部署、迁移或排错的自动化代理；不假设人类会逐段阅读。
> **用法**：读 §0 → §1 → §2，按 §2 选任务，再顺序执行对应步骤。步骤内的「校验」必须执行，不能跳过。
> **边界**：本文只描述**目标状态与可复现操作**。线上实际提交、发布目录、进程状态一律现场读取（§1.0），不得从本文推断。
> **维护规则**：只追加"事实"和"操作"，写在对应章节；一次性交接、某次实测结果写进 §1.4 或附录；不要再往文末追加带日期的小节。

## 0. 约定

| 项 | 约定 |
| --- | --- |
| 角色术语 | **数据端** = 本仓库所在服务器（存 SQLite/文件、拆页、任务编排）；**模型端** = 跑 PaddleX + Ollama 的数据处理服务器。代码里的 `UPSTREAM`、`OCR_UPSTREAM_*` 都指模型端。不要再使用"本机/本站/上游/服务端"等旧称，历史文档里的"服务端"= 模型端。 |
| 分支标记 | `[M]` 仅迁移现有站点；`[F]` 仅全新安装；`[M\|F]` 两者都做；`[U]` 仅更新代码 |
| 步骤格式 | 每步开头一行：`主机 · 前置 · 产物`。命令块内默认同一 shell，变量跨块有效 |
| 占位符 | 尖括号 `<...>` 必须先替换成实测值；未替换等于未执行 |
| 失败即停 | 每个新 shell 先执行 `set -euo pipefail` |
| 权限 | 数据端：`sudo systemctl`（system 管理器，unit 在 `/etc/systemd/system/`）。模型端：`systemctl --user`（unit 在 `~/.config/systemd/user/`，需 `loginctl enable-linger`） |
| 禁止 | ① 用 `nginx -T` 代替 reload 后的响应头验证；② 手工往 `.deploy/current` 里写文件；③ 用多个 uvicorn worker 跑 OCR/进度；④ 清库、删 `.deploy/releases`、切公网入口前不备份 |

## 1. 事实（单一真值表）

### 1.0 现状快照（每次任务先执行，用于判断"要不要重启/要不要发布"）

```bash
cd /home/ubuntu/Codefield/history
git rev-parse HEAD
readlink .deploy/current; cat .deploy/current/version.json
sudo -n systemctl is-active history-data literature history-ocr literature-ocr history-llm history-version
ss -lntp 2>/dev/null | grep -E ':(8665|18665|8765|18765|8865|8965|18080|11435|11436)\b'
curl -s http://127.0.0.1:8665/health
```

### 1.1 拓扑与端口

| 执行端 | 服务（unit 名） | 监听 | 仓库模板 | 说明 |
| --- | --- | --- | --- | --- |
| 数据端 | `history-data` | `127.0.0.1:8665` | `deploy/data/history-data.service` | 历史站 Data API（SQLite + 调度器 + 语义索引） |
| 数据端 | `history-ocr` | `127.0.0.1:8765` | `deploy/data/history-ocr.service` | 历史站 OCR 编排（不加载模型） |
| 数据端 | `history-llm` | `127.0.0.1:8865` | `deploy/data/history-llm.service` | 两站共享生成 API |
| 数据端 | `history-version` | `127.0.0.1:8965` | 仓库无模板，见附录 A | 发布服务：把仓库 HEAD 发布到 `.deploy/current` |
| 数据端 | `literature` | `127.0.0.1:18665` | `deploy/data/literature.service` | 文学站 Data API（独立库） |
| 数据端 | `literature-ocr` | `127.0.0.1:18765` | `deploy/data/literature-ocr.service` | 文学站 OCR 编排（独立存储） |
| 模型端 | `history-ocr` | `127.0.0.1:8080` | `deploy/service/history-ocr.service` | PaddleX PP-StructureV3，CPU |
| 模型端 | `history-llm` | `127.0.0.1:11434` | `deploy/service/history-llm.service` | Ollama 生成（默认 Spark，Qwen 备选） |
| 模型端 | `history-embedding` | `127.0.0.1:11436` | `deploy/service/history-embedding.service` | Ollama 嵌入，固定 CPU |
| 模型端 | `history-tunnel` | 数据端 `18080`→`8080`、`11435`→`11434` | `deploy/service/history-tunnel.service` | 反向 SSH 隧道 |
| 模型端 | `history-embedding-tunnel` | 数据端 `11436`→`11436` | `deploy/service/history-embedding-tunnel.service` | 独立嵌入隧道 |

- 同名 `history-ocr` / `history-llm` 在两端都有，**执行命令前必须确认当前主机**。
- 两站共用一份代码（`history/`）与一个发布目录 `history/.deploy/current`；DB、files、ocr-storage 各自独立。
- 线路：nginx `/history/api/{data,ocr,llm,version}/` → 8665/8765/8865/8965；`/literature/api/{data,ocr,llm,version}/` → 18665/18765/8865/8965（`proxy_pass` 结尾 `/` 剥离前缀）。

### 1.2 文件与落盘位置

| 路径 | 内容 | 在 Git 里 |
| --- | --- | --- |
| `/home/ubuntu/Codefield/history` | 代码仓库（两站共用） | 是 |
| `history/storage/`（`app.db`、`files/`、`backups/`） | 历史站数据 | 否（忽略） |
| `history/ocr-storage/` | 历史站 OCR 任务状态与产物 | 否 |
| `/home/ubuntu/Codefield/literature/`（`app.db`、`files/`、`ocr-storage/`） | 文学站全部本地数据 | 否（Codefield 非 Git 仓库） |
| `history/.deploy/releases/<12位>`、`.deploy/current` | 前端发布目录（软链接） | 否 |
| `~/.local/bin/uv` | uv（systemd 用绝对路径） | 否 |
| `/etc/history-generation.env` | 生成 API 配置（优先于 unit 与代码默认值） | 否 |
| `/etc/history-semantic.env`、`/etc/literature-semantic.env` | 两站语义检索配置 | 否 |
| `/etc/wenqu-sso.env` | 问渠 SSO：`DATABASE_URL`、`SERVICE_TOKEN_SECRET`（600，文学站必需） | 否 |
| 模型端 `~/history-service/` | `ollama/`、`models/`、`models-embedding/`、`venv-ocr/`、`service/`、`PP-StructureV3-cpu.yaml`、`logs/` | 否 |

- 前端发布目录 = `git archive HEAD` 的整棵树；nginx 只 alias 它并对外提供 `html/`、`js/`、`styles.css`，不把仓库根当 Web 根。
- Git 不是数据备份；`.venv/` 不搬运；`.deploy/` 可由同一提交重建。

### 1.3 环境变量

数据端（system unit；括号内为代码默认值）：

| 变量 | 作用 | 生产值 |
| --- | --- | --- |
| `DATA_DB_PATH` / `DATA_STORAGE_DIR` / `DATA_FILE_STORAGE_DIR` / `DATA_PUBLIC_BASE_URL` | Data API 数据路径与对外基址 | 历史站走默认（`storage/`、`/history/api/data`）；文学站显式指向 `~/Codefield/literature{,/files}`、`/literature/api/data` |
| `AUTH_MODE`（`local`） | `local`=本地账号 + Bearer；`sso`=问渠 Cookie | `history-data=local`，`literature=sso` |
| `PROCESSING_OCR_URL` / `PROCESSING_LLM_URL`（8765 / 8865） | 调度器调用本机编排服务 | 文学站必须是 18765 / 8865（**不设会误连历史站 OCR**） |
| `PROCESSING_SCHEDULER_ENABLED`（true）、`PROCESSING_HTTP_TIMEOUT_SECONDS`（1000）、`PROCESSING_RETRY_SECONDS`（10）、`PROCESSING_PREVIOUS_PAGE_TAIL_CHARS`（300） | 后台调度 | 默认 |
| `PROCESSING_STAGE_WORKERS`（4）/ `PROCESSING_STAGE_LANES`（1） | 四阶段线程池 / 每阶段并发页数 | 默认 |
| `OCR_PUBLIC_BASE_URL` | OCR 结果文件对外基址 | `/history/api/ocr`、`/literature/api/ocr` |
| `OCR_STORAGE_DIR` | OCR 存储目录 | 文学站 `~/Codefield/literature/ocr-storage` |
| `OCR_UPSTREAM_URL`（空） | 模型端地址；**空 = 未部署**，识别接口回 503 `ocr_upstream_not_configured` | `http://127.0.0.1:18080`（隧道） |
| `OCR_UPSTREAM_TIMEOUT`（180）、`OCR_UPSTREAM_HEALTH_TIMEOUT`（5）、`OCR_UPSTREAM_HEALTH_PATH`（`/health`）、`OCR_UPSTREAM_TOKEN`、`OCR_UPSTREAM_MODEL`（`PP-StructureV3`） | 模型端调用 | `TIMEOUT=300` |
| `OCR_ASSET_ORIGINS`（空） | 允许关联的外部裁图来源 | 未设 |
| `LLM_PROVIDER`（ollama）、`LLM_MODEL`（`spark-x2.6:4b-q4_k_m`）、`LLM_API_BASE`（`http://127.0.0.1:11435/v1`）、`LLM_TIMEOUT_SECONDS`（180） | 生成服务 | 见 §7.2 |
| `LLM_CONTEXT_TOKENS` / `LLM_TEXT_CONTEXT_TOKENS`（16384）、`LLM_OUTPUT_TOKENS`（1024）、`LLM_TEMPLATE_MARGIN_TOKENS`（256）、`LLM_TEXT_CHUNK_CHARS`（6000）、`LLM_REPEAT_PENALTY`（1.1）、`LLM_OLLAMA_THINK`（0）、`LLM_TOKENIZER_PATH`（空）、`LLM_API_KEY`（空） | 预算与采样 | 见 §7.2 |
| `SEMANTIC_SEARCH_ENABLED`（false）、`EMBEDDING_API_BASE`（`http://127.0.0.1:11436`）、`EMBEDDING_MODEL`（`qwen3-embedding:0.6b-q8_0`）、`EMBEDDING_TIMEOUT_SECONDS`（60）、`EMBEDDING_BATCH_SIZE`（8）、`SEMANTIC_SCAN_INTERVAL_SECONDS`（30）、`SEMANTIC_MIN_COSINE`（0.45）、`EMBEDDING_DOCUMENT_PREFIX`（空）、`EMBEDDING_QUERY_PREFIX`（未定义=用代码默认查询指令） | 语义检索 | 见 §7.3 |
| `VERSION_REPO_DIR` / `VERSION_RELEASES_DIR` / `VERSION_CURRENT_LINK` / `VERSION_HEALTH_PATH` | 发布服务 | 默认 |

模型端（user unit）：`OLLAMA_HOST`、`OLLAMA_MODELS`、`OLLAMA_KEEP_ALIVE=-1`、`OLLAMA_MAX_LOADED_MODELS=1`、`OLLAMA_NUM_PARALLEL=1`、`OLLAMA_CONTEXT_LENGTH`（生成 16384 / 嵌入 4096）、嵌入实例的 `CUDA_VISIBLE_DEVICES=-1` 等、OCR 的 `PADDLE_PDX_MODEL_SOURCE=bos`、`OMP_NUM_THREADS=8`。

### 1.4 模型

| 用途 | 标签 | 约束 |
| --- | --- | --- |
| 生成（默认） | `spark-x2.6:4b-q4_k_m` | Q4_K_M，`num_ctx=16384`；来源 `XHToken/Spark-X2.6-4B-GGUF`，revision `83b47fda018fd14f51aa63341f78266f628af5a5`，文件 `Spark-X2.6-4B-Q4_K_M.gguf`（3543441312 B，SHA-256 `91cb2811aebb47ac916aa619d27d4cdd7f4143106b7917accb8ead4cd7f5cbd9`） |
| 生成（备选，保留） | `qwen3:8b` | 手动切换，无自动失败回退；本机 16K 为 CPU/GPU 混合加载 |
| 嵌入 | `qwen3-embedding:0.6b-q8_0` | 必须精确标签、Q8_0、1024 维、CPU 实例、`truncate=false`；不能用生成模型代替 |
| OCR | PaddleX PP-StructureV3（模型端 `:8080`） | CPU；YAML `deploy/service/PP-StructureV3-cpu.yaml` |

本机（RTX 3060 Laptop 6GB / Ollama 0.35.1）实测基线，仅作参照，不代表业务效果验收：

| 模型 | 上下文 | 分配 | 显存峰值 | 热生成 |
| --- | --- | --- | --- | --- |
| Qwen3-8B Q4_K_M | 16384 | 41% CPU / 59% GPU | 4743 MiB | 21.15 tok/s |
| Spark-X2.6-4B Q4_K_M | 4096 | 100% GPU | 3527 MiB | 64.62 tok/s |
| Spark-X2.6-4B Q4_K_M | 16384 | 100% GPU | 3970 MiB | 64.32 tok/s |

### 1.5 数据与 schema

- `service/data.py` 的 `SCHEMA_VERSION = 9`。空库首次启动自动建表；**已有库必须已是完整 schema 9**，不符直接 RuntimeError，旧迁移分支已删除。
- 表结构自愈：`processing_jobs`（放宽 mode、补 `chunk_size`）、`pending_uploads`/`upload_registrations`、`page_reader_indexes`、`semantic_*` 由对应模块 `ensure_schema()` 用 `CREATE ... IF NOT EXISTS` 建，无需手工迁移。
- 两站库独立；`users`/`conversations`/`roles`/`semantic_models`/`app_meta` 不随文献数据清理删除。

### 1.6 重启矩阵（改了什么 → 重启什么）

| 变更 | 需重启 |
| --- | --- |
| `service/{data,scheduler,uploads,reader_index,reader_content,retrieval,retrieval_worker,retrieval_types,embedding,variant,match,extract,task_progress}.py` | `history-data`、`literature` |
| `service/{llm,evidence}.py` | `history-llm` |
| `service/{ocr,ocr_upstream}.py`（另含 `reader_content`、`variant`、`task_progress`） | `history-ocr`、`literature-ocr` |
| `service/version.py` | `history-version` |
| `html/`、`js/`、`styles.css` | 不重启；走发布（§8.1） |
| `pyproject.toml` / `uv.lock` | `uv sync` 后重启**全部** `uv run` 服务 |
| `deploy/data/*.service`、`/etc/*.env` | 复制/编辑 + `daemon-reload` + 重启对应服务（**先同步 unit 再重启**） |
| 模型端 `service/ocr_model*.py`、`PP-StructureV3-cpu.yaml`、`deploy/service/history-ocr.service` | `systemctl --user restart history-ocr` |
| 模型端隧道 unit | `systemctl --user restart history-tunnel`（或 `history-embedding-tunnel`） |

判断"要不要重启"的标准动作：`git diff --name-only <上次重启提交>..HEAD -- service/`，再对照本表；并用 `systemctl show -p ActiveEnterTimestamp <unit>` 与提交时间比对。

### 1.7 依赖与版本约束

- Python ≥ 3.10，`uv.lock` 为准；部署只用 `uv sync --frozen --no-dev`，不执行 `uv lock --upgrade`。`uv run` 是 systemd 的启动方式，`pyproject.toml` 与 `uv.lock` 必须一致，否则重启时会重新解析。
- 数据端不需要 paddlepaddle/paddleocr/paddlex（已从依赖移除），识别能力全部在模型端。
- 模型端 OCR 环境独立（`venv-ocr`），PaddleX 当前验证版本 **3.7.2**；升级前需检查内部管线接口并重跑识别与进度验证。

## 2. 任务路由

| 任务 | 步骤序列 |
| --- | --- |
| **T1 仅更新代码**（最常见） | §1.0 快照 → §4.2 同步依赖（锁文件变了才做）→ §5.3（模型端文件有变才做）→ §7.x 配置有变才做 → §7.7 按 §1.6 重启 → §8.1 发布前端 → §9 验收 |
| **T2 迁移现有站点** | §3 盘点/停写/备份 → §4 [M] → §5 [M] → §6 → §7 → §8 → §9 → §10.2 记录回滚点 → 切入口 |
| **T3 全新安装** | §3.1 参数盘点 → §4 [F] → §5 [F] → §6 → §7 → §8 → §9 |
| **T4 换生成模型** | §1.4 权重准备（§5.2）→ §7.2 数据端配置 → 重启 `history-llm` → §9.3 真实调用 |
| **T5 只有一端权限** | 完成本端全部步骤，另一端的待办按 §10.3 逐条列出；**不得**宣称已端到端可用 |

## 3. 采集、停写与备份 `[M|F]`

### 3.1 必填参数 `[M|F]`

数据端 · 前置：无 · 产物：本节表格填满

| 输入 | 要求 |
| --- | --- |
| 代码来源与提交 | 仓库地址 + 可检出 commit；迁移时记录源端 `git rev-parse HEAD` 与未提交改动 |
| 两端登录 | 数据端/模型端 SSH 地址、运行账号、sudo 权限（可同机） |
| 目录 | 数据端默认 `/home/ubuntu/Codefield/history` + `.../literature`；模型端 `~/history-service`、`~/.paddlex` |
| 连接方式 | 默认反向 SSH 隧道；可选可信内网直连；同机 loopback |
| 公网入口 | 域名、TLS、现有 Nginx（本机为 `~/Codefield/root/nginx/`）、上传大小上限 |
| 站点范围 | 默认两站；只部署历史站时省略 literature / literature-ocr / SSO |
| 文学站依赖 | 问渠 SSO：PostgreSQL、`/login`、Cookie 域、`DATABASE_URL`、`SERVICE_TOKEN_SECRET` |
| 源端环境 | 实际 systemd 管理器、unit/drop-in、Python/PaddleX/Ollama 版本、模型 digest |
| 迁移材料 | 两站 SQLite/文件、OCR 状态、环境配置、模型缓存；必须确认有无现存数据 |

迁移优先保留源端用户与绝对目录（部分任务记录绝对路径）；若换目录，需保留旧路径软链接或单独验证路径调整。

### 3.2 源端盘点 `[M]`

源数据端 · 前置：§3.1 · 产物：版本/unit/数据快照清单

- 记录：代码提交、未提交文件、各 unit 实际路径与管理器、数据目录、`/health` 里的 schema 与计数。
- 记录模型端输出：`uname -m`、`ollama --version`、`venv-ocr/bin/python --version`、`pip freeze > ~/ocr-requirements.txt`、`curl :11434/api/tags`、`curl :11436/api/tags`。
- `/etc/*env` 与 SSH 私钥只存受限材料，交付记录只写"已迁移 + 路径"。

### 3.3 停写并打包 `[M]`

源数据端 · 前置：§3.2 · 产物：`site-data.tar.gz` + `.sha256`

```bash
sudo systemctl stop history-data.service literature.service history-ocr.service literature-ocr.service history-llm.service
umask 077
bundle_dir="$HOME/history-migration/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$bundle_dir"
tar -C /home/ubuntu/Codefield -czf "$bundle_dir/site-data.tar.gz" history/storage history/ocr-storage literature
sha256sum "$bundle_dir/site-data.tar.gz" > "$bundle_dir/site-data.tar.gz.sha256"
```

源端保持停写直到新端切换完成。只部署一站或目录自定义时按盘点调整 tar 路径；目录缺失必须查原因，不能忽略 tar 失败。

模型端资产（同机仍服务其他应用时先安排停机窗口或可验证快照）：

```bash
systemctl --user stop history-ocr.service history-llm.service history-embedding.service
umask 077; mkdir -p "$HOME/history-migration"
tar --exclude='history-service/venv-ocr' --exclude='history-service/logs' \
    -C "$HOME" -czf "$HOME/history-migration/model-assets.tar.gz" history-service .paddlex
sha256sum "$HOME/history-migration/model-assets.tar.gz" > "$HOME/history-migration/model-assets.tar.gz.sha256"
```

### 3.4 传输与校验 `[M]`

前置：§3.3 · 产物：两端收到包且 SHA-256 一致

站点包 → 新数据端；模型包 + `ocr-requirements.txt` → 新模型端；另需单独迁移 `/etc/*env`、Nginx/TLS、SSH 授权、SSO 依赖。只切数据端时可复用原模型端，跳过模型包。

## 4. 准备数据端 `[M|F]`

### 4.1 系统与代码 `[M|F]`

数据端 · 前置：§3（迁移） · 产物：`$DATA_REPO` 在指定提交、`.venv` 就绪

```bash
export DATA_USER=ubuntu
export DATA_HOME="$(getent passwd "$DATA_USER" | cut -d: -f6)"
export DATA_ROOT="$DATA_HOME/Codefield"
export DATA_REPO="$DATA_ROOT/history"
export LITERATURE_ROOT="$DATA_ROOT/literature"
test "$(id -un)" = "$DATA_USER"
sudo apt-get update
sudo apt-get install -y git curl ca-certificates rsync tar openssh-client nginx
```

```bash
# 目标无仓库时
export REPO_URL='<已确认的仓库地址>'
export DEPLOY_COMMIT='<交接指定的commit>'
mkdir -p "$DATA_ROOT"; test ! -e "$DATA_REPO"
git clone "$REPO_URL" "$DATA_REPO"
git -C "$DATA_REPO" checkout --detach "$DEPLOY_COMMIT"
```

已有工作区：先核对 `git status --short` 并保存必要修改，再同步；不能 reset 丢未提交内容。

### 4.2 依赖 `[M|F|U]`

前置：§4.1 · 产物：`$UV_BIN` 与 `.venv`（锁文件一致）

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # 已有 uv 可跳过
export PATH="$HOME/.local/bin:$PATH"
cd "$DATA_REPO"
uv sync --frozen --no-dev
export UV_BIN="$(command -v uv)"
git rev-parse HEAD
```

### 4.3 数据目录 `[M|F]`

前置：§4.2 · 产物：`storage/`、`ocr-storage/`、`literature/` 就位

`[M]` 目标必须为空目录，包放在 `$HOME/history-migration/site-data.tar.gz`：

```bash
test ! -e "$DATA_REPO/storage"; test ! -e "$DATA_REPO/ocr-storage"; test ! -e "$LITERATURE_ROOT"
mkdir -p "$DATA_ROOT"
tar -C "$DATA_ROOT" -xzf "$HOME/history-migration/site-data.tar.gz"
sudo chown -R "$DATA_USER:$(id -gn "$DATA_USER")" "$DATA_REPO/storage" "$DATA_REPO/ocr-storage" "$LITERATURE_ROOT"
```

`[F]`：

```bash
mkdir -p "$DATA_REPO/storage" "$DATA_REPO/ocr-storage" \
         "$LITERATURE_ROOT/files" "$LITERATURE_ROOT/ocr-storage"
```

目标已有数据时先另存备份、恢复到独立位置，不能直接覆盖。

### 4.4 schema 校验 `[M|F]`

前置：§4.3 · 产物：两库均为完整 schema 9、integrity ok、未完成任务源文件存在

```bash
cd "$DATA_REPO"
export DATA_REPO LITERATURE_ROOT
uv run --frozen --no-dev python - <<'PY'
import os, sqlite3
from pathlib import Path
for path in (Path(os.environ['DATA_REPO'])/'storage/app.db', Path(os.environ['LITERATURE_ROOT'])/'app.db'):
    if not path.exists():
        print(path, 'new database'); continue
    with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as db:
        v = db.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()
        assert v and int(v[0]) == 9, (path, v)
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', path
        for (src,) in db.execute("SELECT source_path FROM processing_jobs WHERE status NOT IN ('completed','failed','cancelled')"):
            assert Path(src).is_file(), f'Missing task source: {src}'
    print(path, 'schema 9, integrity ok, pending task sources present')
PY
```

schema 8 或未知结构必须单独处理并保留原件，**不能靠删库完成迁移**。

## 5. 准备模型端 `[M|F]`

### 5.1 资产、OCR 环境与 unit `[M|F]`

模型端 · 前置：§3.4（迁移） · 产物：`~/history-service/*`、`~/.paddlex`、三个模型 user unit 已 enabled

迁移（目标必须为空）：

```bash
test ! -e "$HOME/history-service"; test ! -e "$HOME/.paddlex"
tar -C "$HOME" -xzf "$HOME/history-migration/model-assets.tar.gz"
```

目录约定：

```text
~/history-service/ollama/bin/ollama
~/history-service/models/                 # 生成实例 manifests/blobs（Spark + Qwen）
~/history-service/models-embedding/       # 嵌入实例 manifests/blobs
~/history-service/venv-ocr/bin/paddlex
~/history-service/PP-StructureV3-cpu.yaml
~/history-service/service/                # ocr_model.py、ocr_model_progress.py
~/history-service/logs/
~/.paddlex/                               # OCR 模型缓存
```

`[F]` 或架构/驱动变化时重建 OCR 环境（不复制旧 venv）：

```bash
export OCR_PYTHON=python3.11
export PADDLE_VERSION='<源端或已验证的版本>'
export PADDLEX_VERSION='<源端或已验证的版本>'
sudo apt-get update
sudo apt-get install -y python3-venv libgl1 libglib2.0-0 libgomp1
mkdir -p "$HOME/history-service"
"$OCR_PYTHON" -m venv "$HOME/history-service/venv-ocr"
"$HOME/history-service/venv-ocr/bin/python" -m pip install --upgrade pip
# 迁移：优先用源端完整清单
"$HOME/history-service/venv-ocr/bin/python" -m pip install -r "$HOME/ocr-requirements.txt"
# 全新安装：改用下面两行
# ... pip install "paddlepaddle==$PADDLE_VERSION" -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
# ... pip install "paddlex[ocr,serving]==$PADDLEX_VERSION"
```

Ollama 程序（`[F]` 或缺失时）：

```bash
export OLLAMA_VERSION='<已确认的发行标签>'
sudo apt-get install -y curl ca-certificates zstd
mkdir -p "$HOME/history-service/ollama"
curl --fail --location --retry 3 \
  "https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION/ollama-linux-amd64.tar.zst" \
  -o /tmp/history-ollama.tar.zst
tar --zstd -xf /tmp/history-ollama.tar.zst -C "$HOME/history-service/ollama"
"$HOME/history-service/ollama/bin/ollama" --version
```

直连 GitHub 不通时走镜像前缀 `https://gh-proxy.com/`。ARM64 不能用 amd64 包。

从仓库送到模型端同名位置：

| 仓库来源 | 模型端目标 |
| --- | --- |
| `deploy/service/PP-StructureV3-cpu.yaml` | `~/history-service/PP-StructureV3-cpu.yaml` |
| `deploy/service/*.service`（5 个） | `~/history-service/deploy/service/`（暂存） |
| `service/ocr_model.py`、`service/ocr_model_progress.py` | `~/history-service/service/`（两个都要） |

```bash
mkdir -p "$HOME/history-service/logs" "$HOME/history-service/models" \
         "$HOME/history-service/models-embedding" "$HOME/.config/systemd/user"
install -m 0644 "$HOME/history-service/deploy/service/history-{ocr,llm,embedding}.service" "$HOME/.config/systemd/user/"
sudo loginctl enable-linger "$(id -un)"
systemctl --user daemon-reload
systemctl --user enable --now history-ocr.service history-llm.service history-embedding.service
```

YAML 策略：保留文档预处理、版面/区域检测、文字识别；**固定关闭**表格结构重建、公式识别、印章识别、图表转表格。表格与图表区域仍需被版面检出，但输出区域图片供数据端保存。CPU OCR 首次启动会下载缺失模型；迁移已有 `~/.paddlex` 可减少下载。生成实例可用 GPU，嵌入实例屏蔽 CUDA/Vulkan/ROCm 并保持 4096 上下文；`OLLAMA_KEEP_ALIVE=-1` 首次推理后常驻。

### 5.2 模型准备与自检 `[M|F|T4]`

前置：§5.1 · 产物：两个实例可真实推理，digest/维数符合 §1.4

已有缓存时不要无条件 `pull`（远端标签变化会改内容）：

```bash
OLLAMA_HOST=127.0.0.1:11434 "$HOME/history-service/ollama/bin/ollama" pull qwen3:8b            # 仅缺时
OLLAMA_HOST=127.0.0.1:11436 "$HOME/history-service/ollama/bin/ollama" pull qwen3-embedding:0.6b-q8_0
OLLAMA_HOST=127.0.0.1:11434 "$HOME/history-service/ollama/bin/ollama" show spark-x2.6:4b-q4_k_m
OLLAMA_HOST=127.0.0.1:11434 "$HOME/history-service/ollama/bin/ollama" show qwen3:8b
OLLAMA_HOST=127.0.0.1:11436 "$HOME/history-service/ollama/bin/ollama" show qwen3-embedding:0.6b-q8_0
```

Spark 权重校验与注册（固定 revision + SHA-256，校验失败停止，不导入坏权重）：

```bash
(
set -e
spark_dir="$HOME/history-service/downloads/spark-x2.6-4b"
spark_file="$spark_dir/Spark-X2.6-4B-Q4_K_M.gguf"
spark_sha=91cb2811aebb47ac916aa619d27d4cdd7f4143106b7917accb8ead4cd7f5cbd9
mkdir -p "$spark_dir"
if [[ ! -f "$spark_file" ]] || ! printf '%s  %s\n' "$spark_sha" "$spark_file" | sha256sum --check --status; then
  curl --fail --location --retry 3 --connect-timeout 15 --speed-limit 1024 --speed-time 60 --continue-at - \
    'https://huggingface.co/XHToken/Spark-X2.6-4B-GGUF/resolve/83b47fda018fd14f51aa63341f78266f628af5a5/Spark-X2.6-4B-Q4_K_M.gguf?download=true' \
    --output "$spark_file"
fi
printf '%s  %s\n' "$spark_sha" "$spark_file" | sha256sum --check
spark_modelfile="$(mktemp "$spark_dir/Modelfile.XXXXXX")"; trap 'rm -f "$spark_modelfile"' EXIT
printf 'FROM ./Spark-X2.6-4B-Q4_K_M.gguf\nPARAMETER num_ctx 16384\n' > "$spark_modelfile"
OLLAMA_HOST=127.0.0.1:11434 "$HOME/history-service/ollama/bin/ollama" create spark-x2.6:4b-q4_k_m --file "$spark_modelfile"
)
```

直连失败且模型端有代理时，在 `curl` 前加 `HTTPS_PROXY=http://127.0.0.1:7897`（按实际）。GGUF 会另存一份 blob，预留两份磁盘。不要用 `SparkLLM/Spark-X2.6-4B` 的默认标签（那是 BF16），不要删除 `qwen3:8b`。

真实推理 + 嵌入契约自检（模型端执行；`ready` 与维数都要断言）：

```bash
python3 - <<'PY'
import json, math, urllib.request
def req(base, route, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    r = urllib.request.Request(base+route, data=body, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(r, timeout=600) as resp:
        return json.load(resp)
gen = req('http://127.0.0.1:11434','/api/chat', {'model':'spark-x2.6:4b-q4_k_m',
      'messages':[{'role':'user','content':'请回答：部署测试通过'}],
      'think':False,'stream':False,'options':{'num_ctx':16384,'num_predict':64}})
assert gen.get('message',{}).get('content','').strip(), gen
base, model = 'http://127.0.0.1:11436', 'qwen3-embedding:0.6b-q8_0'
tag = next(m for m in req(base,'/api/tags')['models'] if model in (m.get('name'), m.get('model')))
assert tag.get('digest'), tag
assert req(base,'/api/show',{'model':model})['details']['quantization_level'] == 'Q8_0'
query = 'Instruct: Given a question about historical documents, retrieve relevant passages that answer the question\nQuery: 军费从哪里筹措？'
vecs = req(base,'/api/embed',{'model':model,'input':[query,'筹集饷银，以供军需。'],'truncate':False})['embeddings']
assert len(vecs) == 2
for v in vecs:
    assert len(v) == 1024 and all(math.isfinite(x) for x in v) and math.hypot(*v) > 0
print(json.dumps({'generation':'ok','embedding':model,'digest':tag['digest'],'dimensions':1024}, ensure_ascii=False))
for p in (11434, 11436):
    print(p, json.dumps(req(f'http://127.0.0.1:{p}','/api/ps'), ensure_ascii=False))
PY
```

判定：嵌入实例 `size_vram=0`；生成实例驻留目标模型且 `CONTEXT=16384`；`ollama list` 仍能看到备选 Qwen。记录冷/热耗时与 RAM/VRAM 峰值。

### 5.3 OCR 启动器与实时进度 `[M|F|U]`

前置：§5.1 · 产物：模型端 `service.ocr_model` 与 YAML 同步、`/health` 通过

模型 unit 用 `venv-ocr/bin/python -m service.ocr_model` 启动，保留 PaddleX 官方 `/layout-parsing` 契约与串行推理，单工作进程（进度表在进程内存，多 worker 会分裂）。

```bash
export MODEL_REPO="$HOME/history"   # 跨机器时先传送相同文件
mkdir -p "$HOME/history-service/service"
install -m 0644 "$MODEL_REPO/service/ocr_model.py" "$MODEL_REPO/service/ocr_model_progress.py" "$HOME/history-service/service/"
install -m 0644 "$MODEL_REPO/deploy/service/history-ocr.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user restart history-ocr.service
# 首次启动要等模型加载完成再查
curl --fail http://127.0.0.1:8080/health
```

进度链路（全链路单一事实来源）：模型端 `X-OCR-Progress-Key` 头 + `GET /layout-parsing/progress/{key}` → 数据端 `/ocr/progress/{progressKey}` → 调度器 `/api/documents/{id}/processing` → 前端 `stagePages.ocr` / `registrationProgress`。返回 `percent/stage/completed/total/unit/status/completedSteps/totalSteps/basis/updatedAt`；100% 只在成功响应后出现；旧模型端回 404/405 时仅停用该次轮询，识别照常执行，不生成虚假百分比。

## 6. 连通两端

### 6.1 默认：反向 SSH 隧道

模型端 · 前置：§5.1 · 产物：数据端 3 个端口可达

- 专用 key `~/.ssh/cloud-tunnel`，账号 `tunneluser`；目标 host key 走可信渠道写入 `known_hosts`（unit 用 `StrictHostKeyChecking=yes`）。
- 数据端 sshd 需允许 `127.0.0.1:18080`、`127.0.0.1:11435`、`127.0.0.1:11436`（`AllowTcpForwarding` / `PermitListen` / key 的 `permitlisten`），改完先 `sshd -t`，保留当前会话再 reload。转发只绑 loopback。
- 端口选 18080/11435 而非 8080/11434：数据端本地已被占用/留作回退。

```bash
export TUNNEL_DEST='<专用SSH账号>@<新数据端SSH主机>'
for name in history-tunnel history-embedding-tunnel; do
  sed "s|tunneluser@192.144.141.60|$TUNNEL_DEST|g" \
      "$HOME/history-service/deploy/service/$name.service" > "$HOME/.config/systemd/user/$name.service"
done
chmod 600 "$HOME/.ssh/cloud-tunnel"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -i "$HOME/.ssh/cloud-tunnel" "$TUNNEL_DEST" true
systemctl --user daemon-reload
systemctl --user enable --now history-tunnel.service history-embedding-tunnel.service
```

key 禁止远程命令时，去掉 `ssh ... true`，改为前台跑 unit 里的 `ssh -NT ... -R ...`，用数据端请求验证后退出，再启动 unit。

数据端确认：

```bash
curl -sSf http://127.0.0.1:18080/health
curl -sSf http://127.0.0.1:11435/api/tags
curl -sSf http://127.0.0.1:11436/api/tags
```

标签/digest 必须与模型端一致。失败依次查：模型服务 → SSH 授权 → 隧道日志 → 数据端端口占用。

### 6.2 可选：内网直连或同机

- 直连：填模型端真实内网地址，连 `8080`、`11434`、`11436`。三个模型 unit 默认只监听 `127.0.0.1`，必须同时改监听（`OLLAMA_HOST` 用 drop-in 覆盖；OCR 需 override `ExecStart` 的 `--host`）**并**在防火墙只放行数据端。只改客户端 URL 不生效。此路径未在生产验证过，须在目标机实测。
- 同机：不启隧道、不改监听，直接 `OCR_UPSTREAM_URL=http://127.0.0.1:8080`、`LLM_API_BASE=http://127.0.0.1:11434/v1`、`EMBEDDING_API_BASE=http://127.0.0.1:11436`（避免与嵌入实例争 11436）。

## 7. 配置数据端并启动

新 shell 先重设 §4.1 的变量。源端自定义 drop-in 先审查再合并，避免把旧路径/旧模型端地址带回来。

### 7.1 安装 system unit 与认证模式

数据端 · 前置：§4.4 · 产物：5 个 unit 在 `/etc/systemd/system/`

```bash
cd "$DATA_REPO"
for unit_path in deploy/data/*.service; do
  unit_name="$(basename "$unit_path")"
  sed -e "s|/home/ubuntu/.local/bin/uv|$UV_BIN|g" \
      -e "s|/home/ubuntu/Codefield/history|$DATA_REPO|g" \
      -e "s|/home/ubuntu/Codefield/literature|$LITERATURE_ROOT|g" \
      -e "s|/home/ubuntu|$DATA_HOME|g" \
      -e 's| run python -m uvicorn | run --frozen --no-dev python -m uvicorn |' \
      -e "s|^User=ubuntu$|User=$DATA_USER|" "$unit_path" | sudo tee "/etc/systemd/system/$unit_name" >/dev/null
done
sudo systemctl daemon-reload
```

- `history-data` 用 `AUTH_MODE=local`（Bearer，重启后内存会话失效需重新登录）；`literature` 用 `AUTH_MODE=sso`，必须读到 `/etc/wenqu-sso.env`（root + 运行组可读），且 SSO PostgreSQL、统一 `/login`、Cookie 域在新入口可用。仅迁移 SQLite **不会**迁移统一账号系统。
- 顺序硬约束：`/etc` 里的 unit 必须先同步再 `restart`。代码默认值是 `local`，只重启不同步 unit 会把文学站也变成 local（SSO 失效）。
- 没有 SSO 依赖时可先交付历史站，文学站标记未完成，**不得**擅自改认证方式。

### 7.2 生成 API 配置

数据端 · 前置：§7.1 · 产物：`/etc/history-generation.env`（优先于 unit 与代码默认值）

首次创建（已有文件跳过并逐项合并，保留认证与其他设置）：

```bash
sudo test ! -e /etc/history-generation.env &&
sudo install -m 0640 -o root -g "$(id -gn "$DATA_USER")" /dev/null /etc/history-generation.env &&
sudo tee /etc/history-generation.env >/dev/null <<'ENV'
LLM_PROVIDER=ollama
LLM_API_BASE=http://127.0.0.1:11435/v1
LLM_MODEL=spark-x2.6:4b-q4_k_m
# LLM_MODEL=qwen3:8b
LLM_TIMEOUT_SECONDS=600
LLM_OLLAMA_THINK=0
LLM_CONTEXT_TOKENS=16384
LLM_OUTPUT_TOKENS=1024
LLM_TEMPLATE_MARGIN_TOKENS=256
LLM_TEXT_CONTEXT_TOKENS=16384
LLM_TEXT_CHUNK_CHARS=6000
LLM_REPEAT_PENALTY=1.1
LLM_TOKENIZER_PATH=
# LLM_API_KEY=...
ENV
```

要点：

- `LLM_API_BASE` 含 `/v1`（列模型用），`LLM_PROVIDER=ollama` 时实际调用原生 `/api/chat`。隧道分支保持 `127.0.0.1:11435/v1`。
- 只有一条 `LLM_MODEL` 生效；模型端 `history-llm`（Ollama）与数据端 `history-llm`（生成 API）同名不同机。
- 切换生成模型必须同步 `LLM_TOKENIZER_PATH`：**不能沿用 Qwen tokenizer**，留空则用保守预算。
- `LLM_CONTEXT_TOKENS` 是问答默认预算（unit 与 Spark Modelfile 也 16384）；整页标点/校对由 `LLM_TEXT_CONTEXT_TOKENS` 独立控制，实际请求最高可到 40960。

改完重启并验证：

```bash
sudo systemctl restart history-llm.service
curl -sSf http://127.0.0.1:8865/health | python3 -c '
import json,sys; r=json.load(sys.stdin)
assert r.get("ready") is True and r.get("model")=="spark-x2.6:4b-q4_k_m", r
print("generation ready")'
curl -sSf --max-time 180 http://127.0.0.1:8865/llm/punctuate \
  -H 'Content-Type: application/json' \
  -d '{"sourceText":"军需各款应分别登记每月核对收入支出保存原始凭据以备查核凡已收款项与待收款项均应注明不得混列经手人员应逐项签认以便日后复核"}' | python3 -c '
import json,sys; r=json.load(sys.stdin)
assert r.get("punctuatedText","").strip(), r
print(r["punctuatedText"])'
```

切回备选：`LLM_MODEL=qwen3:8b`（上下文仍 16384，tokenizer 留空或换匹配文件）→ 重启同一服务 → 健康接口 `model` 变 `qwen3:8b` → 再跑一次真实请求。两个权重都保留，无需重下。

对比两个模型时固定：OCR/嵌入、输入原文、提示词、上下文与输出上限、思考开关、采样、重复惩罚；各自预热后记录首次加载、热推理、tokens/s、RAM/VRAM、CPU/GPU 分配；不要并发交替请求（加载耗时混入结果）。

### 7.3 语义检索

数据端 · 前置：§7.2 · 产物：两站 `/etc/*-semantic.env`

两站可共享模型服务，SQLite/任务/向量各自独立。仓库 unit 默认 `SEMANTIC_SEARCH_ENABLED=false`，模型检查通过后在此启用：

```bash
for config_path in /etc/history-semantic.env /etc/literature-semantic.env; do
  if sudo test -e "$config_path"; then
    printf '配置已存在，请核对并合并：%s\n' "$config_path"; continue
  fi
  sudo install -m 0640 -o root -g "$(id -gn "$DATA_USER")" /dev/null "$config_path" || exit 1
  sudo tee "$config_path" >/dev/null <<'ENV'
SEMANTIC_SEARCH_ENABLED=true
EMBEDDING_API_BASE=http://127.0.0.1:11436
EMBEDDING_MODEL=qwen3-embedding:0.6b-q8_0
EMBEDDING_TIMEOUT_SECONDS=60
EMBEDDING_BATCH_SIZE=8
SEMANTIC_SCAN_INTERVAL_SECONDS=30
SEMANTIC_MIN_COSINE=0.45
EMBEDDING_DOCUMENT_PREFIX=
# 保持 EMBEDDING_QUERY_PREFIX 未定义；空值会禁用代码默认的查询指令。
# EMBEDDING_API_KEY=...
ENV
done
```

- `EMBEDDING_API_BASE` 是 Ollama 根地址。默认查询指令 `Instruct: Given a question about historical documents, retrieve relevant passages that answer the question` + 真实换行 + `Query: 用户问题`；正文不加前缀。
- `SEMANTIC_MIN_COSINE` 是候选下限，不是可信度：该模型中文基线相似度约 0.2~0.35，设 0 等于不设门槛（寒暄/乱码也会被当材料）。实测真实提问 0.61~0.79、无关输入 0.21~0.35，故取 0.45；语料风格变化大时重测再调。
- digest/维数/前缀/分段版本变化后旧向量不参与召回，后台自动重建；恢复相同模型与配置可复用。

### 7.4 模型端地址覆盖（直连分支）

反向隧道分支保持默认 `OCR_UPSTREAM_URL=http://127.0.0.1:18080`。直连/同机时给两个 OCR unit 加 drop-in（`/etc/systemd/system/{history-ocr,literature-ocr}.service.d/upstream.conf`）：

```ini
[Service]
Environment=OCR_UPSTREAM_URL=http://127.0.0.1:8080
```

内网直连换成模型端内网地址。模型端不可用时不能伪装成就绪：`/health` 的 `upstream.reachable` / `ready` 必须如实反映。

### 7.5 OCR 请求策略（代码固定，勿改配置绕过）

- 方向分类/去畸变按请求模式固定：`formal` 开，`quick`/`reader` 关；不由环境变量控制。
- 正文识别用 `reader` 模式：`geometry_fix=False`、`coordinateSpace="input"`，bbox 与原图逐像素对应，可直接本地裁图。
- 所有请求固定关闭 `useTableRecognition`、`useChartRecognition`、`useWiredTableCellsTransToHtml`、`useWirelessTableCellsTransToHtml`，启用 `returnMarkdownImages`。
- 表格/图表统一走图片链路：版面定位 → 关联模型端裁图 → 保存 `page-visual` 资产 → 原位显示/放大；不再生成单元格模型或 HTML 表格。公式、印章识别继续关闭。
- 改 YAML 或启动器后必须同步两端并重启（模型端 `systemctl --user restart history-ocr`，数据端 `systemctl restart history-ocr literature-ocr`）；仅更新模型端不会加载数据端代码。
- 前端每页只存 `page.ocr` 轻量摘要（confidence/engine/width/height/blockCount/blockTypes/hasMarkdown/upstream/warnings/recognizedAt），版面块与行坐标留在 OCR 任务记录里。

### 7.6 处理链路（调度器）

- `PROCESSING_OCR_URL` 指本机 OCR 编排（历史 8765 / 文学 18765），`PROCESSING_LLM_URL` 指共享 8865；**不能**填模型端端口。
- 默认模式 `chunked`（大串小并）：按"每部分页数"切块（默认 3，上限 10），块间串行，块内四阶段（OCR→简繁→标点→校对）错位推进；`PROCESSING_STAGE_WORKERS≥4` 才能四阶段同时推进，`PROCESSING_STAGE_LANES>1` 才出现同阶段并行多页。
- `serial`/`parallel` 仍可选；`processing_jobs` 表在连接时自动升级（放宽 mode、补 `chunk_size`）。
- 任务与进度全部后端持久化，不需要常驻 CLI worker；关闭浏览器任务继续；重启 Data API 复用已完成阶段。

### 7.7 启动顺序

前置：端口无旧 user 实例占用、§4.4 通过、SSO 与模型链路就绪。**先就绪再启动，不能先起服务再搬数据。**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now history-ocr.service history-llm.service history-version.service
sudo systemctl enable --now history-data.service
sudo systemctl enable --now literature-ocr.service literature.service
sudo systemctl is-active history-data.service history-ocr.service history-llm.service \
      literature.service literature-ocr.service history-version.service
sudo journalctl -u history-data.service -u literature.service -n 100 --no-pager
```

只部署历史站时省略文学站两个 unit；不部署发布服务（附录 A）时省略 `history-version.service`，改走 §8.2。启动失败看日志修，不要另开 uvicorn 绕开 systemd。

## 8. 前端发布与代理

### 8.1 发布模型（生产现行）

**代码源 = 服务器本地 Git 仓库**：开发者在他处 push 到远端不等于上线。流程固定为：

1. 服务器 `git -C ~/Codefield/history pull`（线上不变，可随时回退）。
2. 触发发布：网页「更新」按钮，或 `curl -X POST http://127.0.0.1:8965/update`。
3. `history-version` 执行 `git archive HEAD` → `.deploy/releases/<12位>` → `os.replace` 软链接 `.deploy/current`；两站同时生效（共用同一发布目录）。

```bash
curl -s http://127.0.0.1:8965/version      # 看 updateAvailable / currentCommit / sourceCommit
curl -s -X POST http://127.0.0.1:8965/update
readlink .deploy/current                   # 应切到 releases/<12位>
cat .deploy/current/version.json           # commit 必须等于 git rev-parse HEAD
```

约束与坑：

- `version.json` 必须在发布目录里。手工 `git archive` 建的 release 必须补写 `version.json`（`{"commit": "<完整哈希>"}`），否则 `deployed_commit()` 回退到 HEAD 并误判"已是最新"，更新被跳过。
- `CURRENT_LINK` 不能 `.resolve()`（会跟随软链接导致 `switch_current_link` 误判失败）；代码已按此实现，勿改回。
- 未提交的本地改动不会进发布；`git archive HEAD` 只打 HEAD。
- 只改 `service/*.py` 时重启服务即可，不必发布；只改前端时不重启服务，必须发布。
- 旧 releases 可清理，**至少保留 `current` + 最近 2 个**（回滚用）。

### 8.2 无 version 服务时的静态发布 `[F]`

`history-version` 的 unit 不在仓库里（附录 A）。不部署它时，用同一套目录结构手工发布（版本接口按 §8.3 末尾降级为静态响应，前端不会有「更新」按钮）：

```bash
cd "$DATA_REPO"
release_id="$(git rev-parse --short=12 HEAD)-$(date +%Y%m%d%H%M%S)"
mkdir -p ".deploy/releases/$release_id"
git archive HEAD | tar -x -C ".deploy/releases/$release_id"
printf '{"commit":"%s"}\n' "$(git rev-parse HEAD)" > ".deploy/releases/$release_id/version.json"
chmod -R a+rX ".deploy/releases/$release_id"
ln -sfn "$PWD/.deploy/releases/$release_id" .deploy/current.next
mv -Tf .deploy/current.next .deploy/current
```

发布内容必须来自同一提交、只含可公开资产（整棵树即可，nginx 只 alias 出去）；不要把 `storage/`、`ocr-storage/` 暴露成 Web 根。

### 8.3 Nginx

生产由 `~/Codefield/root` 统一管理：`root/nginx/root.conf`（HTTP→HTTPS + SSL + `include conf.d/*.conf`），片段 `root/nginx/conf.d/{history,literature}.conf`。改仓库片段后：

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -skI --resolve www.wenqu.art:443:127.0.0.1 https://www.wenqu.art/history/styles.css | grep -i cache-control
```

必须满足：

- 旧入口 `= /history`、`= /history/`、`= /history/index.html` → `301 /history/html/`（`/literature` 同理）。多页结构下页面内是 `../js/`、`../styles.css` 相对路径，`/history/` 不再回退 index。
- 静态：`location /history/ { alias <repo>/.deploy/current/; index index.html; add_header Cache-Control "no-cache, must-revalidate" always; }`。**必须有该头**：否则 CSS/JS 会被启发式缓存，版本刷新后出现"半新半旧"。
- API：`/history/api/{data,ocr,llm,version}/` → 8665/8765/8865/8965，`/literature/api/{data,ocr,llm,version}/` → 18665/18765/8865/8965；`proxy_pass` 结尾 `/` 负责剥离前缀（`/history/api/data/api/bootstrap` → `/api/bootstrap`）。
- `client_max_body_size 256m`（按文献规模调）、`proxy_read_timeout 1200s`、HTTP/1.1 升级头（WebSocket 由其它子站使用；history 无 WS）。
- 无 version 服务时（§8.2），用两个精确 location 让前端不显示更新按钮：`location = /history/api/version/version { default_type application/json; return 200 '{"configured":false,"updateAvailable":false}'; }`（`/literature` 同理）。

`nginx -T` 只是重新解析文件，**不代表运行中的配置已更新**。判断是否 reload 过：比对 conf mtime 与 `ps -o lstart -p <worker pid>`。

### 8.4 发布后自动刷新（前端机制，改动前先读）

- 每个页面先加载 `js/core.js`/`js/service.js`；每 30s 轮询 `/history/api/version/version`（文学站为 `/literature/api/version/version`），`currentCommit` 变化 → 写 localStorage 广播 `wenqu.platform.reload` → 各标签页 `reloadWithFreshAssets()`（先 `fetch(...,{cache:"reload"})` 预刷新同源 CSS/JS，再 `location.reload()`，等价 Ctrl+F5）。
- `readerEditing` / 上传进行中会挂起刷新，等到下次轮询或页面转后台；`share.html` 不参与轮询。
- 因此：**出问题先确认是"没发布"、"没 reload nginx"、还是"只 reload 了主文档"**。

## 9. 验收

### 9.1 健康与 schema

```bash
python3 - <<'PY'
import json, urllib.request
for port in (8665, 18665, 8765, 18765, 8865):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=30) as r:
        d = json.load(r)
    assert d.get('status') == 'ok', (port, d)
    if port in (8665, 18665):
        assert d.get('schemaVersion') == 9, (port, d)
        print(port, {k: d.get(k) for k in ('database','documents','pages','fileRecords','schemaVersion')})
    else:
        assert d.get('ready') is True, (port, d)
        print(port, 'ready')
for port in (8665, 18665):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/embedding/health', timeout=90) as r:
        assert json.load(r).get('ready') is True, port
    print(port, 'embedding ready')
PY
```

只部署一站时删掉未启用端口。HTTP 200 不代表模型端就绪，必须断言字段。

### 9.2 数据完整性（读取既有库，不是导入）

```bash
cd "$DATA_REPO"
env DATA_DB_PATH="$DATA_REPO/storage/app.db" DATA_STORAGE_DIR="$DATA_REPO/storage" \
    DATA_FILE_STORAGE_DIR="$DATA_REPO/storage/files" "$UV_BIN" run --frozen --no-dev python scripts/storage.py check
env DATA_DB_PATH="$LITERATURE_ROOT/app.db" DATA_STORAGE_DIR="$LITERATURE_ROOT" \
    DATA_FILE_STORAGE_DIR="$LITERATURE_ROOT/files" "$UV_BIN" run --frozen --no-dev python scripts/storage.py check
```

迁移场景先与源端停写快照核对文献/页/文件数；启动后产生的增量单独说明。

### 9.3 真实模型链路（数据端，经实际连接）

```bash
export OCR_TEST_IMAGE='<测试页绝对路径>'
curl -sSf --max-time 600 -F "image=@$OCR_TEST_IMAGE" -F pageNumber=1 http://127.0.0.1:8765/ocr
curl -sSf --max-time 700 -H 'Content-Type: application/json' \
  -d '{"text":"测试文献《军需录》，民国二年成书。","source":"ocr"}' \
  http://127.0.0.1:8865/llm/extract-metadata
```

参数坑：`/ocr` 表单字段是 `image`（不是 `file`）；LLM 无 `/llm` 根路由，用 `/llm/chat`、`/llm/punctuate`、`/llm/extract-metadata`，请求体字段是 `prompt`/`text`/`sourceText` 而非 `message`。失败时部分接口仍回 200，必须看 `ready`、`errorKind`、`warnings`。

### 9.4 公网入口、登录与功能

切 DNS/负载均衡前用 `curl --resolve` 或临时域名访问新入口（保留正式 Host/TLS）。**验证线上必须走 HTTPS**：`curl http://127.0.0.1/... -H 'Host: www.wenqu.art'` 只会拿到 301。

| 验收项 | 通过条件 |
| --- | --- |
| 两站前端 | `/history/html/index.html`、`/literature/html/index.html` 及 js/css/partials 均 200，API 前缀正确 |
| 历史站登录 | 本地账号可登录，文献/附件/原图可访问；重启后需重登属预期 |
| 文学站登录 | 未登录跳 `/login`，Cookie 被后端解析；`/literature/api/data/api/auth/login` 返回 410（sso 模式禁本地登录） |
| 语义检索 | 换措辞仍能召回原文；私有/已删内容不越权 |
| 问答/编年/引用 | 各模式产出基于文献，引用可打开正确页与文本层 |
| 上传与后台任务 | 关浏览器后继续，顺序正确，重启 Data API 复用已完成阶段 |
| 站点隔离 | 两站库/文件/OCR 状态/会话各自正确，共享生成服务可用 |
| 故障恢复 | 断开 OCR/生成/嵌入时状态准确；恢复后任务续跑；语义故障时字面检索可用 |
| 开机自启 | 数据端 system unit 已 enable；模型端 user unit 已 enable 且 linger 生效 |

真实召回率、p95、内存与并发必须现场测，离线测试不能代替。

## 10. 运维

### 10.1 语义索引

由 Data API 内嵌 worker 随服务启停，无需额外进程。排错顺序：站点配置 → Data API 日志 → 嵌入连通性 → 真实检索结果。停用：把对应 env 的 `SEMANTIC_SEARCH_ENABLED=false` 并重启该 Data API（字面检索仍可用）。不要用清库解决索引故障。

### 10.2 回滚

- 前端：把 `.deploy/current` 指回上一个 `releases/<12位>`（`ln -sfn`），无需重启服务。
- 后端：恢复相互匹配的提交 + 依赖 + 配置后重启；schema 9 的数据不能交给不兼容的旧代码。
- 数据：先停写并备份，再谈合并/恢复；`scripts/storage.py restore ARCHIVE --yes` 前必须停对应 Data/OCR 服务，避免旧 WAL/SHM 混入。
- 不要为了处理普通启动错误去删库或删模型缓存。

### 10.3 交付记录（必须）

两端主机与运行账号、代码 commit、管理器与 enabled 状态、目录、连接方式、模型标签/digest/量化/维数、依赖版本、源/目标数据量与 storage check 结果、OCR/生成/嵌入的真实调用结果、登录与浏览器验收、资源测量、入口切换与回滚位置、未完成事项。**不输出**密码、DSN、Token、Cookie、私钥。

## 11. 排错

| 现象 | 处理 |
| --- | --- |
| `Address already in use` | 同名服务同时跑在 system 与 user 管理器，或有人手起了第二份进程 |
| `systemctl stop` 后 `is-active` 显示 `failed` | 正常：uvicorn 收 SIGTERM 退 143，unit 无 `SuccessExitStatus=143`。功能无影响 |
| 前端已更新但接口 404 | 只发布前端没重启后端（`service/*.py` 必须重启）；先看 nginx access.log 状态码 |
| 页面"半新半旧" | nginx 没 reload 或缺少 `Cache-Control: no-cache`；reload 后用 `curl -I` 验证响应头 |
| 点「更新」无反应 / updateAvailable 一直是 false | 发布目录缺 `version.json`，或 `CURRENT_LINK` 被 `.resolve()` |
| 文学站登录 410 / 无法登录 | 预期：sso 模式禁本地登录；要本地登录说明连错了站点或 `AUTH_MODE` 配错 |
| 历史站也被要求 SSO | unit 未同步 `AUTH_MODE=local` 就重启（先 cp unit 再 restart） |
| OCR 全部失败 | `/health` 看 `upstream.reachable`；`OCR_UPSTREAM_URL` 空 → 503 `ocr_upstream_not_configured` |
| 隧道端口 LISTEN 但 curl 超时 | 僵尸会话占端口：`sudo -n ss -lntp` 找出监听 18080 / 11435 的 pid（属 `sshd: tunneluser`）→ `sudo -n kill <pid>`，约 6s 自动重连。**勿杀 VS Code 的 ubuntu 会话**，也不要用 ubuntu 账号的 `systemctl --user` 判断隧道死活 |
| LLM ready=false | 隧道 → 模型端 `ollama ps` → digest/上下文 → 数据端 `LLM_API_BASE`/`LLM_MODEL` |
| 嵌入"已连接"但无语义结果 | 健康检查只看配置与模型列表；查索引状态、开关、查询前缀、真实 embed、权限 |
| schema 报错 | 备份是否完整 schema 9；只读检查原库、保留原件，不做不兼容升级 |
| `uv run` 启动很慢/联网 | `pyproject.toml` 与 `uv.lock` 不一致；`uv sync --frozen --no-dev` 后重启 |
| 公网 curl 卡数秒 | 本机走公网绕行；验证优先用 `127.0.0.1` 或 `--resolve` |

## 12. 依据

- uv 项目与锁文件：<https://docs.astral.sh/uv/guides/projects/>
- PaddleX 安装与 PP-StructureV3：<https://paddlepaddle.github.io/PaddleX/3.0/en/installation/installation.html>、<https://paddlepaddle.github.io/PaddleX/3.0/en/pipeline_usage/tutorials/ocr_pipelines/PP-StructureV3.html>
- Ollama Linux：<https://docs.ollama.com/linux>
- 嵌入精确标签：<https://ollama.com/library/qwen3-embedding:0.6b-q8_0>
- Nginx `proxy_pass` URI 规则：<https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass>
- 安装命令与模型信息以官方对应发行版为准。

## 附录 A：`history-version` unit（生产现状，仓库未提供模板）

安装到 `/etc/systemd/system/history-version.service`，`enable --now`；`VERSION_*` 全部走默认值（仓库目录 `~/Codefield/history`、发布目录 `.deploy/releases`、链接 `.deploy/current`）即可：

```ini
[Unit]
Description=History Version API
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/Codefield/history
Environment=PATH=/home/ubuntu/.local/bin:/home/ubuntu/.cargo/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/ubuntu/.local/bin/uv run python -m uvicorn service.version:app --host 127.0.0.1 --port 8965
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## 附录 B：历史命名与残留

| 旧名 | 现值 |
| --- | --- |
| `literature-data.service` / `~/Codefield/literature-data/` | `literature.service` / `~/Codefield/literature/` |
| `js/config.js` 站点识别 | `js/core.js`（`SITE_ID` 取 URL 首段） |
| `service/wenqu_sso/`（包） | `service/wenqu_sso.py`（单文件，与 `SSO/lib/python/wenqu_sso/session.py` 同源，改一处要同步） |
| `OCR_UPSTREAM_STYLE` / native 契约 / `/ocr/cover-candidate` | 已删除（只保留 PaddleX `/layout-parsing`；封面自动识别改为手工上传） |
| `service/table_content.py` / `renderMode=structured` | 已删除（表格与图表统一走图片链路） |
| `.deploy/releases` 内旧发布里的 `literature-data.service` | 历史快照，勿动 |
