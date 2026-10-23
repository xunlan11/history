# 部署与迁移执行手册

本文件是部署大模型的执行入口。目标是在新主机恢复历史站 `/history`、文学站 `/literature` 和远程模型服务，并用实际请求验证。命令示例面向 Debian/Ubuntu Linux，使用 Bash；其他发行版替换包管理步骤。每段标明执行主机。先读完对应分支，再执行命令，遇到失败先解决再进入下一步。

执行主机每个新 shell 先启用失败即停，下面各块共享该主机 shell 的变量；占位符必须先替换，互斥分支只选一条：

```bash
set -euo pipefail
```

代码工作区只整理代码和执行离线检查；下面的安装、备份、服务启动及真实推理命令仅在目标部署主机执行。交付时记录实际完成项和缺失项，不能把本文的示例或健康检查当成已完成的生产验收。

## 1. 先选择部署路径并填写交接记录

| 本次任务 | 执行顺序 |
| --- | --- |
| 迁移现有站点 | 源端盘点及停写备份 → 新模型端恢复 → 连通两端 → 新数据端恢复及配置 → 发布前端/代理 → 验收 → 切换入口 |
| 全新安装 | 盘点目标参数 → 准备模型及依赖 → 连通两端 → 新数据端空库初始化 → 发布前端/代理 → 验收 |
| 仅更新代码 | 备份现有数据及当前发布 → 同步指定提交及依赖 → 更新 unit/配置 → 重启数据端 → 发布同一提交的前端 → 验收；模型未变时复用模型端 |

执行前从任务上下文、源机和现有配置中确定下表；不要把旧 IP 或假定的密码填到新环境。只有无法从已授权环境取得的必要信息才需要补充。只有一端权限时完成该端，交付另一端的具体待办。

| 必须确定的输入 | 本文示例/要求 |
| --- | --- |
| 代码来源和提交 | 仓库地址、可检出的 commit；迁移时记录源端 `git rev-parse HEAD` 和未提交改动 |
| 两端登录方式 | 数据端、模型端的 SSH 地址、运行账号、sudo 权限；两端可以是同一台主机 |
| 数据端目录 | 默认 `/home/ubuntu/Codefield/history`，文学站独立数据为 `/home/ubuntu/Codefield/literature` |
| 模型端目录 | 运行账号的 `~/history-service`、`~/.paddlex`；记录 CPU 架构、GPU 驱动及可用 RAM/磁盘 |
| 连接方式 | 双机默认模型端向数据端反向 SSH；可选可信内网直连；同机使用本机直连 |
| 公网入口 | 域名、TLS、现有 Nginx 配置、上传大小、DNS/负载均衡切换方式 |
| 站点范围 | 默认两站；只部署历史站时省略 literature、literature-ocr 和 SSO 步骤 |
| 文学站登录依赖 | 问渠 SSO 的 PostgreSQL、`/login` 及账号相关路由、Cookie 域、`DATABASE_URL`、`SERVICE_TOKEN_SECRET` |
| 源端环境 | 实际 systemd 管理器、unit/drop-in、Python/PaddleX/PaddlePaddle/Ollama 版本、生成/嵌入模型 digest |
| 数据迁移材料 | 两站 SQLite/文件、OCR 状态、环境配置、模型缓存；必须确认有无现存数据，不能默认“已清空” |

迁移优先保留源端用户和绝对目录。部分持久化任务记录绝对路径；更换目录时，需保留对应旧路径的受控软链接或完成单独验证的路径调整，再恢复任务，不能只改 unit 的工作目录。

## 2. 拓扑、服务管理器和路径

| 执行端 | 服务 | 本机监听 | 仓库文件 |
| --- | --- | --- | --- |
| 数据端 | 历史站 Data API | `127.0.0.1:8665` | `data/history-data.service` |
| 数据端 | 历史站 OCR 编排 API | `127.0.0.1:8765` | `data/history-ocr.service` |
| 数据端 | 两站共享 LLM API | `127.0.0.1:8865` | `data/history-llm.service` |
| 数据端 | 文学站 Data API | `127.0.0.1:18665` | `data/literature.service` |
| 数据端 | 文学站 OCR 编排 API | `127.0.0.1:18765` | `data/literature-ocr.service` |
| 模型端 | PaddleX PP-StructureV3，CPU | `127.0.0.1:8080` | `service/history-ocr.service` |
| 模型端 | Ollama 生成，允许 GPU/CPU 混合 | `127.0.0.1:11434` | `service/history-llm.service` |
| 模型端 | Ollama 嵌入，固定 CPU | `127.0.0.1:11436` | `service/history-embedding.service` |
| 模型端 | OCR/生成反向隧道 | 数据端 `18080`→模型端 `8080`、数据端 `11435`→模型端 `11434` | `service/history-tunnel.service` |
| 模型端 | 独立嵌入反向隧道 | 数据端 `11436`→模型端 `11436` | `service/history-embedding-tunnel.service` |

**新安装统一约定：数据端使用 system 服务，模型端使用 user 服务。** 数据端 unit 带 `User=ubuntu` 和 `WantedBy=multi-user.target`，安装到 `/etc/systemd/system/`，用 `sudo systemctl`；模型端 unit 使用 `%h` 和 `default.target`，安装到运行账号的 `~/.config/systemd/user/`，用 `systemctl --user`。

源端旧部署可能使用 user 服务：先分别检查 `sudo systemctl` 和 `systemctl --user` 的 `show/cat/status`，后续停止、备份和重启必须针对实际管理器。目标已有旧 user 实例时，切换前停用它，不能在两个管理器中同时启动相同端口。两端都有 `history-ocr` 和 `history-llm`，执行命令前确认当前主机。

需要迁移的持久化内容：

| 内容 | 默认位置 | 迁移说明 |
| --- | --- | --- |
| 历史站 SQLite、文件和备份 | `history/storage/` | 含 `app.db`、可能存在的 WAL/SHM、`files/`，在仓库目录内且被 Git 忽略 |
| 历史站 OCR 状态与产物 | `history/ocr-storage/` | 包括后台 OCR 任务状态 |
| 文学站全部本地数据 | `literature/` | 含 `app.db`、`files/`、`ocr-storage/`，与历史站隔离 |
| 数据端配置 | `/etc/history-semantic.env`、`/etc/literature-semantic.env`、`/etc/history-generation.env`、`/etc/wenqu-sso.env`，以及实际 drop-in | 最后一份是文学站必需依赖；凭据通过受控渠道迁移，不写入 Git 或交付回答 |
| 模型程序、权重和配置 | `~/history-service/`、`~/.paddlex/` | 保留两个 Ollama 模型目录及 digest；OCR 虚拟环境在目标机重建 |
| 基础设施 | Nginx/TLS、SSO PostgreSQL、SSH key/authorized_keys、sshd 限制 | 不包含在应用 SQLite 备份中，需单独迁移或复用 |

Git 仓库不是数据备份；不搬运 `.venv/`。静态发布的 `.deploy/` 可以从相同提交重建。

## 3. 源端盘点、停写与传输（迁移分支）

### 3.1 记录版本和自定义配置

在源数据端记录代码提交、未提交文件、各 unit 的实际路径/管理器、数据目录、健康接口中的 schema 和数量。将必要的未提交代码纳入交接，不能只传一个无法包含这些改动的 commit。

在源模型端记录以下输出，并把依赖清单保存在迁移材料中：

```bash
uname -m
"$HOME/history-service/ollama/bin/ollama" --version
"$HOME/history-service/venv-ocr/bin/python" --version
"$HOME/history-service/venv-ocr/bin/python" -m pip freeze > "$HOME/ocr-requirements.txt"
curl --fail --silent --show-error http://127.0.0.1:11434/api/tags
curl --fail --silent --show-error http://127.0.0.1:11436/api/tags
```

保存两个实例的模型名称、digest、量化和当前 unit/drop-in。检查依赖清单中的本地文件路径或私有源是否也需要交接。所有 `/etc/*env` 的内容和 SSH 私钥只保存在受限迁移材料中，交付记录仅注明已迁移与路径。

### 3.2 停写并备份数据

在源数据端先把公网入口切入维护模式，阻止新写入，然后停止两个 Data API、两个 OCR 编排及共享 LLM API。下面按 system 服务示例；旧端若是 user 服务，改用实际管理器：

```bash
sudo systemctl stop history-data.service literature.service history-ocr.service literature-ocr.service history-llm.service
```

确认上述服务均已停止，后台写入进程退出；不要只停止浏览器。按默认布局打包整个持久化目录，包含残留 WAL/SHM，且不删除源文件：

```bash
umask 077
bundle_dir="$HOME/history-migration/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$bundle_dir"
tar -C /home/ubuntu/Codefield -czf "$bundle_dir/site-data.tar.gz" history/storage history/ocr-storage literature
sha256sum "$bundle_dir/site-data.tar.gz" > "$bundle_dir/site-data.tar.gz.sha256"
```

只部署一站或源端采用自定义目录时，按盘点结果调整 tar 路径；目录缺失须确认原因，不能忽略 tar 失败。源端保持停写直到新端切换完成。

模型端优先复制现有资产，避免重下权重。停止模型端三个模型服务后制作一致的资产副本；如果该机仍服务其他应用，先安排停机窗口或使用可验证的一致快照。示例：

```bash
systemctl --user stop history-ocr.service history-llm.service history-embedding.service
umask 077
mkdir -p "$HOME/history-migration"
tar --exclude='history-service/venv-ocr' --exclude='history-service/logs' -C "$HOME" -czf "$HOME/history-migration/model-assets.tar.gz" history-service .paddlex
sha256sum "$HOME/history-migration/model-assets.tar.gz" > "$HOME/history-migration/model-assets.tar.gz.sha256"
```

通过已确认的 SSH/受控传输通道，将站点包送至新数据端、模型包和 `ocr-requirements.txt` 送至新模型端；另行迁移环境文件、Nginx/TLS、SSH 授权及 SSO 依赖。两端校验 SHA-256；校验清单引用旧绝对路径时，在目标目录用记录的摘要校验包文件。仅切换数据端时可复用原模型端，跳过模型包搬运。

## 4. 准备目标数据端：代码、依赖与数据

本文命令默认数据运行账号为 `ubuntu`，在该账号的登录 shell 执行，并具备 sudo。修改变量时同步后续目录；迁移现有任务优先保留源路径。

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

把交接指定的仓库检出到 `$DATA_REPO`，切到指定 commit，确认工作区改动与交接记录一致。目标尚无仓库时执行：

```bash
export REPO_URL='<已确认的仓库地址>'
export DEPLOY_COMMIT='<交接指定的commit>'
mkdir -p "$DATA_ROOT"
test ! -e "$DATA_REPO"
git clone "$REPO_URL" "$DATA_REPO"
git -C "$DATA_REPO" checkout --detach "$DEPLOY_COMMIT"
```

已有工作区时先核对 `git status --short` 并保存必要修改，再同步目标提交，不能直接 reset 丢弃未提交内容。新机没有 uv 时安装到数据运行账号；已有 uv 可跳过安装。然后安装锁定依赖：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
cd "$DATA_REPO"
uv sync --frozen --no-dev
export UV_BIN="$(command -v uv)"
git rev-parse HEAD
```

使用 Python ≥3.10 且满足 `uv.lock` 的目标平台；部署不执行 `uv lock --upgrade`。API 使用项目虚拟环境，模型端 OCR 依赖单独安装。

迁移分支：在服务尚未启动、目标持久化目录为空时解包，示例假设已把包放在 `$HOME/history-migration/site-data.tar.gz`：

```bash
test ! -e "$DATA_REPO/storage"
test ! -e "$DATA_REPO/ocr-storage"
test ! -e "$LITERATURE_ROOT"
mkdir -p "$DATA_ROOT"
tar -C "$DATA_ROOT" -xzf "$HOME/history-migration/site-data.tar.gz"
sudo chown -R "$DATA_USER:$(id -gn "$DATA_USER")" "$DATA_REPO/storage" "$DATA_REPO/ocr-storage" "$LITERATURE_ROOT"
```

若目标已有数据，先保存其备份并恢复到独立位置，不能直接覆盖。全新安装分支只创建目录：

```bash
mkdir -p "$DATA_REPO/storage" "$DATA_REPO/ocr-storage" "$LITERATURE_ROOT/files" "$LITERATURE_ROOT/ocr-storage"
```

当前代码仅支持 **schema 9**：空库首次启动自动初始化；已有库必须已是完整 schema 9。源 schema 8 或未知结构须单独处理并保留原件，不能靠删库完成迁移。下面只读检查恢复的库；新安装不存在的库会跳过：

```bash
cd "$DATA_REPO"
uv run --frozen --no-dev python - <<'PY'
import os
import sqlite3
from pathlib import Path
for path in (Path(os.environ['DATA_REPO']) / 'storage/app.db', Path(os.environ['LITERATURE_ROOT']) / 'app.db'):
    if not path.exists():
        print(path, 'new database')
        continue
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        version = db.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()
        assert version and int(version[0]) == 9, (path, version)
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', path
        for (source,) in db.execute("SELECT source_path FROM processing_jobs WHERE status NOT IN ('completed','failed','cancelled')"):
            assert Path(source).is_file(), f'Missing task source: {source}'
    print(path, 'schema 9, integrity ok, pending task sources present')
PY
```

## 5. 准备目标模型端

### 5.1 程序、OCR 环境和资产位置

在模型运行账号登录 shell 执行。模型端只需要本节列出的资产，不要求部署应用后端。模型包已放到 `$HOME/history-migration/model-assets.tar.gz` 时，迁移分支在空目标恢复：

```bash
test ! -e "$HOME/history-service"
test ! -e "$HOME/.paddlex"
tar -C "$HOME" -xzf "$HOME/history-migration/model-assets.tar.gz"
```

若已经有可用实例先盘点并合并，不能覆盖另一个项目的模型目录。全新安装分支跳过解包，创建 `~/history-service` 后按下面步骤安装。架构或驱动变化时重装匹配平台的程序和依赖，保留模型权重。

所需目录和程序：

```text
~/history-service/ollama/bin/ollama
~/history-service/models/                 # 生成实例的 manifests/blobs
~/history-service/models-embedding/       # 嵌入实例的 manifests/blobs
~/history-service/venv-ocr/bin/paddlex
~/history-service/PP-StructureV3-cpu.yaml
~/history-service/logs/
~/.paddlex/                              # OCR 模型缓存
```

OCR 环境迁移时，用源端 Python 主次版本重建 `venv-ocr`，按 `ocr-requirements.txt` 安装；不要复制旧虚拟环境。全新安装时先根据 PaddleX 对应发行版锁定 Python、PaddlePaddle CPU、PaddleX 版本，记录到交接清单。以下安装变量须填写实际版本（迁移取源端值），先确认目标已安装对应 Python 及其 venv 支持；系统默认 Python 不匹配时先安装对应版本，不能把占位符直接执行：

```bash
export OCR_PYTHON=python3.11
export PADDLE_VERSION='<源端或已验证的版本>'
export PADDLEX_VERSION='<源端或已验证的版本>'
sudo apt-get update
sudo apt-get install -y python3-venv libgl1 libglib2.0-0 libgomp1
mkdir -p "$HOME/history-service"
"$OCR_PYTHON" -m venv "$HOME/history-service/venv-ocr"
"$HOME/history-service/venv-ocr/bin/python" -m pip install --upgrade pip
# 迁移环境：优先使用源端完整清单；缺少 CPU wheel 时使用对应发行版的官方索引。
"$HOME/history-service/venv-ocr/bin/python" -m pip install -r "$HOME/ocr-requirements.txt"
# 全新安装时，以上一行替换为以下两行：
# "$HOME/history-service/venv-ocr/bin/python" -m pip install "paddlepaddle==$PADDLE_VERSION" -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
# "$HOME/history-service/venv-ocr/bin/python" -m pip install "paddlex[ocr,serving]==$PADDLEX_VERSION"
```

模型端缺少 Ollama 程序时，优先恢复同架构、已验证版本的完整发行目录（包括动态库）。全新安装可按官方 Linux 安装说明下载匹配架构的发行包，解压到 `~/history-service/ollama/`；例如 x86_64 的 `.tar.zst` 发行包包含 `bin/`、`lib/`，需要 `zstd`：

```bash
export OLLAMA_VERSION='<已确认的发行标签，例如 vX.Y.Z>'
sudo apt-get install -y curl ca-certificates zstd
mkdir -p "$HOME/history-service/ollama"
curl --fail --location --retry 3 "https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION/ollama-linux-amd64.tar.zst" -o /tmp/history-ollama.tar.zst
tar --zstd -xf /tmp/history-ollama.tar.zst -C "$HOME/history-service/ollama"
"$HOME/history-service/ollama/bin/ollama" --version
```

发行版资产名/格式以选定版本官方页面为准；ARM64 不使用 amd64 包。迁移已备份的 Ollama 目录时跳过下载。

从仓库把下列文件通过受控传输送到模型端同名位置：

| 仓库来源 | 模型端目标 |
| --- | --- |
| `deploy/service/PP-StructureV3-cpu.yaml` | `~/history-service/PP-StructureV3-cpu.yaml`（直接放根目录，unit 运行时读取） |
| `deploy/service/*.service` | 暂存到 `~/history-service/deploy/service/`，共五个 unit |
| `service/ocr_model.py`、`service/ocr_model_progress.py` | `~/history-service/service/`（两个文件均需同步） |

在模型端安装三个模型 unit，隧道稍后配置：

```bash
mkdir -p "$HOME/history-service/logs" "$HOME/history-service/models" "$HOME/history-service/models-embedding" "$HOME/.config/systemd/user"
install -m 0644 "$HOME/history-service/deploy/service/history-ocr.service" "$HOME/.config/systemd/user/"
install -m 0644 "$HOME/history-service/deploy/service/history-llm.service" "$HOME/.config/systemd/user/"
install -m 0644 "$HOME/history-service/deploy/service/history-embedding.service" "$HOME/.config/systemd/user/"
sudo loginctl enable-linger "$(id -un)"
systemctl --user daemon-reload
systemctl --user enable --now history-ocr.service history-llm.service history-embedding.service
```

OCR 保留文档预处理、版面与区域检测和文字识别；表格结构重建、公式识别、印章识别、图表转表格固定关闭，YAML 不再包含这些模型的配置。版面检测仍可标出表格、公式、印章和图表区域；表格及图表使用区域图片，供数据端保存、显示和正文过滤。

CPU OCR 首次启动可能下载 YAML 所需模型；迁移已有 `~/.paddlex` 可减少下载。检查日志直到加载完成。OCR `--device cpu`；嵌入 unit 屏蔽 CUDA/Vulkan/ROCm；生成 unit 不限制为 CPU。嵌入与生成各最多加载一个模型、并行数为 1，上下文配置为 4096，`OLLAMA_KEEP_ALIVE=-1` 在首次推理后保持驻留。预留总 RAM 时计入 OCR、生成 CPU 分担和嵌入同时运行，不能用下载体积代替运行占用。

### 5.2 准备两个模型并真实推理

优先复用源端模型缓存，确保模型标签和 digest 一致。只有目标缺模型或明确计划更新时执行对应 `pull`；已有同名模型时不要无条件拉取，远端标签变化会改变内容。全新安装分别使用两个实例：

```bash
OLLAMA_HOST=127.0.0.1:11434 "$HOME/history-service/ollama/bin/ollama" pull qwen3:8b
OLLAMA_HOST=127.0.0.1:11436 "$HOME/history-service/ollama/bin/ollama" pull qwen3-embedding:0.6b-q8_0
OLLAMA_HOST=127.0.0.1:11434 "$HOME/history-service/ollama/bin/ollama" show qwen3:8b
OLLAMA_HOST=127.0.0.1:11436 "$HOME/history-service/ollama/bin/ollama" show qwen3-embedding:0.6b-q8_0
```

嵌入必须是精确标签 `qwen3-embedding:0.6b-q8_0`、Q8_0、1024 维；不能用生成模型代替。生成使用 `qwen3:8b`，生成目录保留生成模型，嵌入目录保留嵌入模型。CPU 嵌入不得加载到生成实例。

模型端执行下面脚本。它先做一次真实生成，再验证嵌入的 digest、量化及查询/正文两条有限非零向量；`truncate=false` 禁止静默截断：

```bash
python3 - <<'PY'
import json
import math
import urllib.request

def request(base, route, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + route, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=600) as response:
        return json.load(response)

generation = request('http://127.0.0.1:11434', '/api/chat', {
    'model': 'qwen3:8b', 'messages': [{'role': 'user', 'content': '请回答：部署测试通过'}],
    'think': False, 'stream': False, 'options': {'num_ctx': 4096, 'num_predict': 64},
})
assert generation.get('message', {}).get('content', '').strip(), generation
base = 'http://127.0.0.1:11436'
model = 'qwen3-embedding:0.6b-q8_0'
tag = next(m for m in request(base, '/api/tags')['models'] if model in (m.get('name'), m.get('model')))
assert tag.get('digest'), tag
show = request(base, '/api/show', {'model': model})
assert show['details']['quantization_level'] == 'Q8_0', show['details']
query = 'Instruct: Given a question about historical documents, retrieve relevant passages that answer the question\nQuery: 军费从哪里筹措？'
vectors = request(base, '/api/embed', {'model': model, 'input': [query, '筹集饷银，以供军需。'], 'truncate': False})['embeddings']
assert len(vectors) == 2
for vector in vectors:
    assert len(vector) == 1024 and all(math.isfinite(x) for x in vector)
    assert math.hypot(*vector) > 0
print(json.dumps({'generation': 'ok', 'embedding': model, 'digest': tag['digest'], 'dimensions': 1024}, ensure_ascii=False))
for port in (11434, 11436):
    print(port, json.dumps(request(f'http://127.0.0.1:{port}', '/api/ps'), ensure_ascii=False))
PY
```

检查嵌入 `/api/ps` 的 `size_vram=0`，生成实例仍有 `qwen3:8b`。记录冷/热耗时和 RAM/VRAM 峰值；GPU 存在时确认生成能利用 GPU，不能为节省排错时间把所有模型改为 CPU。

### OCR 实时进度更新

模型 unit 使用 `venv-ocr/bin/python -m service.ocr_model` 启动，固定 CPU 推理，保留 PaddleX 官方 `/layout-parsing` 请求/响应格式和串行推理线程。启动器观察实际推理阶段与文字区域产出，并固定图表图片策略：覆盖旧请求中的重建开关，将视觉块关联到 PaddleX 原生裁图；不修改 PaddleX 安装包。当前已用 PaddleX **3.7.2** 验证；升级 PaddleX 前需检查内部管线接口并重新执行识别与进度验证，缺少必要采集点时启动器会明确报错。

模型端从已确认的新代码目录同步以下文件，然后更新本用户的 OCR unit（工作目录仍为 `~/history-service`）：

```bash
# MODEL_REPO 是包含本次改动的仓库副本；跨机器时先传送相同文件。
export MODEL_REPO="$HOME/history"
mkdir -p "$HOME/history-service/service"
install -m 0644 "$MODEL_REPO/service/ocr_model.py" "$MODEL_REPO/service/ocr_model_progress.py" "$HOME/history-service/service/"
install -m 0644 "$MODEL_REPO/deploy/service/history-ocr.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user restart history-ocr.service
curl --fail http://127.0.0.1:8080/health
```

模型仍在加载时等待就绪再检查。不要只更新 unit 而遗漏两个 Python 文件。原有反向隧道继续转发同一个端口，无需增加端口或重启 LLM。

数据端同步本次代码与前端后，重启实际部署的 Data/OCR API（历史站与文学站都需要）：

```bash
sudo systemctl restart history-data.service history-ocr.service literature.service literature-ocr.service
```

真实进度链路是：模型端 `X-OCR-Progress-Key` 请求头 + `GET /layout-parsing/progress/{key}` → OCR API `/ocr/progress/{progressKey}` → 调度器 `/api/documents/{id}/processing` → 正文 `stagePages.ocr` / 登记 `registrationProgress`。`POST /ocr` 与 `/ocr/metadata-candidate` 均接受表单 `progressKey`。每次调度尝试和每次模型调用使用独立键，失败或取消后的旧查询不能覆盖新任务。

模型进度返回 `percent`、`stage`、`completed`、`total`、`unit`、`status`、`completedSteps`、`totalSteps`、`basis`、`updatedAt`。`basis=pipeline_steps` 表示配置步骤的完成比例，文字识别步骤按实际产出的文字区域数细分，其他步骤只在实际完成后推进；不预测耗时。100% 在成功响应后才产生。候选文字识别再按“已完成候选页 + 当前页完成比例”汇总；文字层提取直接计入已完成页。上传/候选 OCR/元数据识别仍沿用 0–20 / 20–50 / 50–100 的登记阶段显示区间，这个总比例是工作流比例，悬停可查看候选 OCR 本身的进度与计数。

旧模型端返回进度接口 404/405 时，仅停用该次调用的模型进度轮询，识别请求照常执行，界面不会生成虚假的页内百分比。真实进度也只保留在当前服务进程内存中；重启后新调度尝试重新采集。OCR API 和模型启动器均使用单工作进程，不能用多个 Uvicorn worker 分割进度表。

## 6. 连通模型端与数据端

### 6.1 默认：反向 SSH 隧道

模型端以专用 key `~/.ssh/cloud-tunnel` 连接数据端专用 SSH 账号。迁移时可受控迁移原 key 或生成新 key，并在数据端更新相应公钥授权。首次连接前，通过可信渠道确认目标 SSH host key 并写入模型账号 `known_hosts`；unit 使用 `StrictHostKeyChecking=yes`，不能靠关闭校验解决失败。

数据端 SSH 配置需要允许远程转发，并在适用的 key `permitlisten`、`sshd PermitListen`/`AllowTcpForwarding` 规则中允许三个地址：`127.0.0.1:18080`、`127.0.0.1:11435`、`127.0.0.1:11436`。保留原有限制。转发只绑定 loopback，无需开放这些公网端口。修改 sshd 配置后先 `sudo sshd -t`，保留当前会话并验证新登录，再按系统实际服务名 reload。

在模型端填写新数据端 SSH 地址，替换两个已交付隧道 unit 中的旧目的地址；先不要原样启用仓库里的旧 IP：

```bash
export TUNNEL_DEST='<专用SSH账号>@<新数据端SSH主机>'
for name in history-tunnel history-embedding-tunnel; do
  sed "s|tunneluser@192.144.141.60|$TUNNEL_DEST|g" "$HOME/history-service/deploy/service/$name.service" > "$HOME/.config/systemd/user/$name.service"
done
chmod 600 "$HOME/.ssh/cloud-tunnel"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -i "$HOME/.ssh/cloud-tunnel" "$TUNNEL_DEST" true
systemctl --user daemon-reload
systemctl --user enable --now history-tunnel.service
systemctl --user enable --now history-embedding-tunnel.service
```

若专用 key 禁止远程命令，上一条 `ssh ... true` 不适用；改为在前台执行 unit 中对应的 `ssh -NT ... -R ...`，用数据端请求验证转发后退出前台实例，再启动 unit。嵌入隧道独立启用，避免新端口未获授权时影响 OCR/生成隧道。

在数据端确认三条链路：

```bash
curl --fail --silent --show-error http://127.0.0.1:18080/health
curl --fail --silent --show-error http://127.0.0.1:11435/api/tags
curl --fail --silent --show-error http://127.0.0.1:11436/api/tags
```

生成/嵌入的模型标签和 digest 必须与模型端一致。失败时依次检查模型服务、SSH 授权、两条隧道日志和数据端端口占用。

### 6.2 可选：可信内网或同机直连

使用数据端可达的模型端实际内网地址，分别连接 `8080`、`11434`、`11436`。三个模型 unit 默认只监听 `127.0.0.1`，直连必须同时通过 drop-in 修改模型服务的监听地址，并限制防火墙仅允许数据端访问；只改客户端 URL 不会生效。该分支不启用反向隧道，数据端的上游配置按下一节覆盖。

两端在同一台主机时，不启用 SSH 隧道，也不修改模型的 loopback 监听。数据端直接使用 `OCR_UPSTREAM_URL=http://127.0.0.1:8080`、`LLM_API_BASE=http://127.0.0.1:11434/v1`、`EMBEDDING_API_BASE=http://127.0.0.1:11436`，避免嵌入隧道与模型本身争用 `11436`。

## 7. 配置数据端并启动 API

在第 4 节的数据运行账号 shell 中执行；新开 shell 时先重新设置 `DATA_USER`、`DATA_HOME`、`DATA_ROOT`、`DATA_REPO`、`LITERATURE_ROOT`、`UV_BIN`。源端自定义 drop-in 先审查，再合并到目标，避免把旧路径/上游地址照搬回来。

### 7.1 安装 system unit，准备登录依赖

将模板中的账号、home、仓库和文学站目录替换成实际值，安装到 system 管理器，并给启动命令加 `--frozen --no-dev`，沿用锁文件且不自动装开发依赖。`sed` 参数中的路径应是不含 `|` 等替换元字符的常规绝对路径；特殊路径改为逐项编辑并核对。

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

历史站 `AUTH_MODE=local`，使用本地账号和 Bearer Token；重启后内存会话失效，需要重新登录。文学站 `AUTH_MODE=sso`，unit 必须读到 `/etc/wenqu-sso.env`，其中包含真实 `DATABASE_URL` 和 `SERVICE_TOKEN_SECRET`。从源部署安全恢复该文件并限制为 root 和运行账号所属组可读；确认 SSO PostgreSQL、统一 `/login`、Cookie 域和账号路由已经在新入口可用。仅迁移 SQLite 不会迁移统一账号系统。没有 SSO 依赖时可先交付历史站，文学站标记未完成，不能擅自改成另一套认证。

### 7.2 生成 API 配置

`/etc/history-generation.env` 由数据端 `history-llm.service` 加载。首次创建可用以下默认值；已有文件先合并，保留认证和 tokenizer 路径。以下写文件命令只适用于首次创建，`test` 失败则不要执行后续覆盖命令：

```bash
sudo test ! -e /etc/history-generation.env &&
sudo install -m 0640 -o root -g "$(id -gn "$DATA_USER")" /dev/null /etc/history-generation.env &&
sudo tee /etc/history-generation.env >/dev/null <<'ENV'
LLM_PROVIDER=ollama
LLM_API_BASE=http://127.0.0.1:11435/v1
LLM_MODEL=qwen3:8b
LLM_TIMEOUT_SECONDS=600
LLM_CONTEXT_TOKENS=4096
LLM_OUTPUT_TOKENS=1024
LLM_TEMPLATE_MARGIN_TOKENS=256
# LLM_API_KEY=...
# LLM_TOKENIZER_PATH=/opt/history-tokenizers/qwen3/tokenizer.json
ENV
```

`LLM_API_BASE` 包含 `/v1`，提供模型列表和兼容接口；代码在 `LLM_PROVIDER=ollama` 时从该根地址调用原生 `/api/chat`。迁移 tokenizer 文件时保持其版本与生成模型一致；未配置 tokenizer 会采用保守预算。上下文、输出、余量须满足预算约束，并与模型实例的实际上下文一致。

### Semantic retrieval

这是数据端第 7 步的一部分。两站分别读取 `/etc/history-semantic.env` 和 `/etc/literature-semantic.env`；仓库 unit 默认关闭语义检索，以下配置在模型检查通过后启用。两站可共享模型服务，SQLite、任务和向量仍独立。

以下命令完整包含配置内容，直接创建实际配置文件。已有文件跳过创建，随后必须核对合并；只部署一站时删去另一站的路径：

```bash
for config_path in /etc/history-semantic.env /etc/literature-semantic.env; do
  if sudo test -e "$config_path"; then
    printf '配置已存在，请核对并合并：%s\n' "$config_path"
    continue
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
  if [ "$?" -ne 0 ]; then
    exit 1
  fi
done
```

`EMBEDDING_API_BASE` 是 Ollama 根地址。默认查询指令为 `Instruct: Given a question about historical documents, retrieve relevant passages that answer the question`，随后真实换行，再接 `Query: 用户问题`；正文不加前缀。不要将旧配置里的空 `EMBEDDING_QUERY_PREFIX=` 原样带入。digest、维数、前缀或分段版本改变后旧向量不参与新召回，后台会重新生成；恢复相同模型及配置可复用向量。`SEMANTIC_MIN_COSINE` 是候选过滤下限，不是答案可信度。该模型对中文有约 0.2~0.35 的基线相似度，设为 0 等于不设门槛：任何输入（含寒暄、乱码）都能凑满候选并被当成材料，模型随之据无关材料作答。2026-10-15 实测（《宫中档光绪朝奏折》）：真实提问 0.61~0.79，无关输入 0.21~0.35，故取 0.45；语料或问题风格差异大时应重测后再调。降低该值会放宽召回，提高则更严格。

### 7.3 直连覆盖与启动

反向隧道分支沿用上面的默认地址。内网直连分支把生成配置的 `LLM_API_BASE` 改为 `http://模型内网地址:11434/v1`，两站嵌入配置改为 `http://模型内网地址:11436`；再为两个 OCR 编排 unit 添加如下 drop-in，填写真实内网地址：

```ini
[Service]
Environment=OCR_UPSTREAM_URL=http://模型内网地址:8080
```

位置分别是 `/etc/systemd/system/history-ocr.service.d/upstream.conf`、`/etc/systemd/system/literature-ocr.service.d/upstream.conf`。同机直连使用第 6.2 节的 loopback 地址，同样覆盖两个 OCR unit；反向隧道分支保持 `OCR_UPSTREAM_URL=http://127.0.0.1:18080`。OCR 使用 PaddleX `/layout-parsing`，健康路径默认 `/health`；遇到版本差异先核对实际 API，不能将不可用的上游伪装为就绪。

整页方向分类与校正、文档去畸变按请求模式固定：`formal` 开启，`quick` 和 `reader` 关闭，不由 `OCR_UPSTREAM_GEOMETRY_FIX` 控制。当前正文识别调用 `reader`，保持坐标对应保存的原图；需要纠偏的 `formal` 请求返回处理后坐标，图表使用明确关联的上游裁图，不能按这些坐标裁输入原页。

所有请求固定关闭 `useTableRecognition`、`useChartRecognition`、`useWiredTableCellsTransToHtml` 和 `useWirelessTableCellsTransToHtml`，并启用 `returnMarkdownImages`。新识别的表格与图表统一使用图片链路：版面定位 → 关联区域裁图 → 保存图片资产 → 原位显示及放大；不再生成单元格模型或 HTML 表格。保留图表题注、阅读顺序和正文过滤。历史数据如需图表图片，重新识别对应页面即可。

公式识别、印章识别继续关闭。模型端 YAML 停止初始化表格结构和单元格模型，启动器同时覆盖旧数据端传入的重建开关；同步 YAML 和启动代码后重启模型端 OCR：

```bash
# 在模型端仓库根目录执行；只重启 OCR 模型服务。
install -m 0644 deploy/service/PP-StructureV3-cpu.yaml "$HOME/history-service/PP-StructureV3-cpu.yaml"
install -m 0644 service/ocr_model.py service/ocr_model_progress.py "$HOME/history-service/service/"
systemctl --user restart history-ocr.service
curl --fail http://127.0.0.1:8080/health
```

等待模型加载完成再检查健康接口。数据端需同时更新 `service/ocr_upstream.py` 和 `service/reader_content.py`，后者固定新图表图片显示并正确解码 `/9j/` 开头的 JPEG Base64（避免误当作 URL）。随后重启实际运行的 OCR API；按本部署模板是 `sudo systemctl restart history-ocr.service literature-ocr.service`，只部署一个站点时只重启对应服务。该增量无需数据库迁移、前端改动或 LLM/嵌入重启。仅更新模型端不会加载数据端代码。已有模型缓存可保留，停用后不会因缓存存在而自动加载。

Data API 的 `PROCESSING_OCR_URL` 指向本机 OCR 编排（历史站 `8765`，文学站 `18765`），`PROCESSING_LLM_URL` 指向共享编排 `8865`；这两个地址不能改成模型服务的端口。后台调度默认启用，HTTP 超时默认 1000 秒，需容纳上游调用。上传、登记和正文任务由后端持久化，不需要额外常驻 CLI worker。

大串小并（`chunked`）是登记默认处理方式：文献按“每部分页数”（默认 3，上限 10）切块，块间串行，块内仍走并行链路（文字识别、简繁、标点、校对四阶段错位推进，每个阶段同时只处理一页）。并发由两个环境变量控制，换大设备时按需调整，不必改代码：`PROCESSING_STAGE_WORKERS`（调度线程池大小，默认 4，需 ≥ 4 才能让四阶段同时推进）与 `PROCESSING_STAGE_LANES`（每个阶段同时处理几页，默认 1；调大才会出现同一阶段并行多页）。`processing_jobs` 表会在服务连接数据库时自动升级以支持该链路（放宽 `mode` 约束并补 `chunk_size` 列），旧库无需手工迁移。

确认没有旧 user 实例占用端口、数据检查通过、SSO 和模型链路已就绪，然后启动。恢复已有队列后服务会自动续跑，不能提前启动再搬数据：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now history-ocr.service history-llm.service
sudo systemctl enable --now history-data.service
sudo systemctl enable --now literature-ocr.service literature.service
sudo systemctl is-active history-data.service history-ocr.service history-llm.service literature.service literature-ocr.service
sudo journalctl -u history-data.service -u literature.service -n 100 --no-pager
```

只启用历史站时省略文学站两个 unit。启动失败先检查日志，不要另开 `uvicorn` 绕开 systemd。

## 8. 发布静态前端和配置入口代理

数据 API、LLM API、前端必须来自同一提交。前端是静态 HTML/CSS/JS，生产发布不需要 npm 构建。必须保留 `/history/html/...` 和 `/literature/html/...` 的站点前缀；前端按 URL 第一段决定站点、登录方式及缓存隔离。

迁移时先恢复原有域名/TLS、SSO 路由及代理设置。源端若有 `service.version` 发布服务，保留其 unit、`VERSION_CURRENT_LINK` 和受控路由，使用其既有发布流程；不要同时维护两套互相覆盖的发布链接。仓库没有提供 version 服务 unit，本节给出不依赖它的静态发布方式，版本按钮在此方式下标记“待配置”。

### 8.1 发布静态资产

在数据端执行，确认前端文件来自指定提交和已交接的修改。以下仅导出可公开的静态资产，不把代码、数据库或配置目录作为 Web 根目录：

```bash
cd "$DATA_REPO"
release_id="$(git rev-parse --short=12 HEAD)-$(date +%Y%m%d%H%M%S)"
static_release="/srv/history/releases/$release_id"
sudo install -d -m 0755 "$static_release"
sudo cp -R html js styles.css "$static_release/"
sudo chmod -R a+rX "$static_release"
# 先记录 readlink /srv/history/current 的旧目标，供回滚使用。
sudo ln -s "$static_release" /srv/history/current.next
sudo mv -Tf /srv/history/current.next /srv/history/current
```

`/srv/history/current` 应不存在或为发布软链接；若是实际目录，先核对并迁移现有内容。`current.next` 已存在时先检查是否有并发发布，不能覆盖另一个执行者的操作。

### 8.2 Nginx 路由

将下面片段合并到实际域名的 `server {}` 中，并保留现有 TLS、`/login` 和其他问渠服务路由。上传大小示例为 256 MB，按实际文献规模调整；上游超时应覆盖 OCR/LLM 长请求。`proxy_pass` 的结尾 `/` 用于去掉匹配的站点 API 前缀：例如 `/history/api/data/api/bootstrap` 转为后端 `/api/bootstrap`，不是 `/bootstrap`。

```nginx
client_max_body_size 256m;
proxy_read_timeout 1200s;
proxy_send_timeout 1200s;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Cookie $http_cookie;
proxy_set_header Authorization $http_authorization;

location = /history { return 302 /history/html/index.html; }
location = /history/ { return 302 /history/html/index.html; }
location = /literature { return 302 /literature/html/index.html; }
location = /literature/ { return 302 /literature/html/index.html; }

location ^~ /history/api/data/ { proxy_pass http://127.0.0.1:8665/; }
location ^~ /history/api/ocr/ { proxy_pass http://127.0.0.1:8765/; }
location ^~ /history/api/llm/ { proxy_pass http://127.0.0.1:8865/; }
location ^~ /literature/api/data/ { proxy_pass http://127.0.0.1:18665/; }
location ^~ /literature/api/ocr/ { proxy_pass http://127.0.0.1:18765/; }
location ^~ /literature/api/llm/ { proxy_pass http://127.0.0.1:8865/; }

# 仅用于尚未部署 version API 的静态发布方式；源端已有版本服务则保留其原路由。
location = /history/api/version/version {
    default_type application/json;
    return 200 '{"configured":false,"updateAvailable":false,"message":"由部署流程发布静态资产"}';
}
location = /literature/api/version/version {
    default_type application/json;
    return 200 '{"configured":false,"updateAvailable":false,"message":"由部署流程发布静态资产"}';
}
location ^~ /history/api/ { return 404; }
location ^~ /literature/api/ { return 404; }
location /history/ { alias /srv/history/current/; }
location /literature/ { alias /srv/history/current/; }
```

确认没有旧 location 冲突，执行 `sudo nginx -t` 成功后 `sudo systemctl reload nginx`。数据 API、OCR/LLM 编排和模型端口均保留内网/loopback，通过正式 HTTPS 入口访问站点。

## 9. 验收通过后再切换入口

### 9.1 API、schema 和链路

在数据端执行，必须检查 JSON 字段，HTTP 200 本身不代表上游就绪：

```bash
python3 - <<'PY'
import json
import urllib.request
for port in (8665, 18665, 8765, 18765, 8865):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=30) as response:
        data = json.load(response)
    assert data.get('status') == 'ok', (port, data)
    if port in (8665, 18665):
        assert data.get('schemaVersion') == 9, (port, data)
        print(port, {k: data.get(k) for k in ('database', 'documents', 'pages', 'fileRecords', 'schemaVersion')})
    else:
        assert data.get('ready') is True, (port, data)
        print(port, 'ready')
for port in (8665, 18665):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/embedding/health', timeout=90) as response:
        data = json.load(response)
    assert data.get('ready') is True, (port, data)
    print(port, 'embedding health ready')
PY
```

只部署一站时移除未启用端口。迁移场景中，先用恢复库与源端停写快照核对数据库路径、文献/页/文件数量；启动后若恢复队列产生新记录，单独说明增量。再执行两站文件完整性检查（读取既有库，不是恢复/导入）：

```bash
cd "$DATA_REPO"
env DATA_DB_PATH="$DATA_REPO/storage/app.db" DATA_STORAGE_DIR="$DATA_REPO/storage" DATA_FILE_STORAGE_DIR="$DATA_REPO/storage/files" "$UV_BIN" run --frozen --no-dev python scripts/storage.py check
env DATA_DB_PATH="$LITERATURE_ROOT/app.db" DATA_STORAGE_DIR="$LITERATURE_ROOT" DATA_FILE_STORAGE_DIR="$LITERATURE_ROOT/files" "$UV_BIN" run --frozen --no-dev python scripts/storage.py check
```

### 9.2 真实模型和应用调用

第 5.2 节已在模型端做过真实生成/嵌入；在数据端还需经实际连接验证，不能只查 `/api/tags`。反向隧道部署可复用第 5.2 节脚本，把生成地址 `11434` 改为数据端 `11435`，嵌入地址仍为 `11436`；直连部署替换两个 base 为真实内网地址。核对 digest 与源端及模型端一致。

选择一张已授权、包含清晰文字的测试页，在数据端验证 OCR 编排和生成编排。`OCR_TEST_IMAGE` 必须指向真实文件：

```bash
export OCR_TEST_IMAGE='<测试页的绝对路径>'
curl --fail --silent --show-error --max-time 600 -F "image=@$OCR_TEST_IMAGE" -F pageNumber=1 http://127.0.0.1:8765/ocr
curl --fail --silent --show-error --max-time 700 -H 'Content-Type: application/json' --data '{"text":"测试文献《军需录》，民国二年成书。","source":"ocr"}' http://127.0.0.1:8865/llm/extract-metadata
```

两项都要求 JSON 中 `ready=true`，OCR 有实际识别文本，生成有符合输入的结果；模型调用失败时部分接口仍返回 HTTP 200，须检查 `ready`、`errorKind` 和 `warnings`。

### 9.3 公网入口、登录和恢复行为

切 DNS/负载均衡前用临时域名、hosts 或 `curl --resolve` 访问新入口，保留正式 Host/TLS 语义。至少完成：

| 验收项 | 通过条件 |
| --- | --- |
| 两站前端 | `/history/html/index.html`、`/literature/html/index.html`、JS/CSS/partials 均成功加载，API 前缀正确 |
| 历史站登录 | 已有本地账号登录，文献/附件/原图可访问，重登后数据一致；新站用正常注册流程建立账号 |
| 文学站登录 | 未登录跳转统一 `/login`，登录后 Cookie 能被后端解析，账户权限保持源端语义 |
| 语义检索 | 授权文献完成向量索引后，使用与原文不同措辞仍能召回对应段落；私有/删除内容不越权 |
| 问答、编年和引用 | 各模式能生成基于文献的结果，引用打开正确页及文本层，原图定位可用 |
| 上传与后台任务 | 登记/正文任务在关闭浏览器后继续，排队顺序正确，重启 Data API 后复用已完成阶段 |
| 站点隔离 | 两站数据库、文件、OCR 状态及会话行为各自正确，共享生成服务可用 |
| 故障恢复 | OCR/生成/嵌入断开时状态准确；恢复后等待任务续跑，语义故障时字面检索仍可用 |
| 开机恢复 | 数据端 system units 已 enable；模型端 user units 已 enable 且 linger 生效；新登录后服务仍在 |

迁移前后的样本文件哈希、记录数和实际访问应相符；空库连通不等于数据迁移成功。真实召回率、p95、内存与并发负载需在目标主机测量，离线测试不能代替。

全部必需检查通过后切换正式入口，确认旧机不会继续接收写入，观察新端日志和队列，再决定旧机保留时间。没有完成的 SSO、真实文献验证、性能或重启测试必须明确列为待办。

## 10. 索引维护、回滚和交付记录

### 10.1 后台索引运行与停用

语义索引由 Data API 内的后台 worker 自动扫描和生成，随对应 Data API 启停，不需要额外启动索引进程。排错时先检查对应站点的配置、Data API 日志、嵌入模型连通性和真实检索结果。不要通过清空数据库处理普通索引故障。

将目标站点环境配置中的 `SEMANTIC_SEARCH_ENABLED` 设为 `false`，并重启对应 Data API，即可停用语义查询和后台索引；字面检索仍可用。重新启用前先确认模型和配置正确。

### 10.2 回滚

尚未切入口且新端未产生业务写入时，可停新端并把入口保留在原端，再恢复原端服务。切换后已有新写入时，先停写并备份新端，明确数据合并/恢复方案，不能直接把入口指回旧库。

代码回滚需同时恢复相互匹配的后端提交、依赖、配置和静态发布；schema 9 数据不能交给不兼容的旧代码。静态发布回滚到预先记录的 `/srv/history/current` 旧目标。不要删除当前库或模型缓存以处理普通启动错误。

应用完整 ZIP 备份包含 SQLite 和文件资产，但不包含 `ocr-storage`、SSO 数据库或机器配置。若使用 `scripts/storage.py restore ARCHIVE --yes`，先停止相关站点 Data/OCR 服务，备份目标并确保没有旧 WAL/SHM 随旧库混入，单独恢复 OCR 状态，按当前 schema 校验后再启动。JSON 导出不是后台任务的完整迁移备份。

### 10.3 必须返回的交付记录

交付信息采用简短表格/清单，记录实际观测值：两端主机和运行账号、代码 commit、system/user 管理器和启用状态、目录、连接路径、模型标签/digest/量化/维数、环境依赖版本、源/目标数据数量及文件检查、OCR/生成/嵌入真实调用、登录和浏览器验收、资源测量、入口切换及回滚位置、未完成事项。不要输出密码、完整数据库 DSN、Token、Cookie 或私钥。

## 11. 常见阻塞和依据

| 现象 | 优先检查 |
| --- | --- |
| `Address already in use` | 同名服务是否同时跑在 system/user 管理器，或有人手动启动了另一份进程 |
| 文学站启动失败 | `/etc/wenqu-sso.env` 是否存在、可读；PostgreSQL 与统一登录是否实际可用 |
| OCR 启动失败 | `~/history-service/PP-StructureV3-cpu.yaml` 是否在 unit 指定位置；OCR 环境版本、模型缓存和系统动态库 |
| 上游不可达 | 模型进程 → loopback 监听 → SSH host key/key 授权 → 隧道日志 → 数据端转发端口；直连检查监听/防火墙 |
| 模型列表正常但推理失败 | 真实请求、Ollama 版本、剩余内存、模型 digest/量化、`/api/ps`；嵌入接口必须支持 `/api/embed` 和 `truncate=false` |
| 首页嵌入“已连接”但无语义结果 | 健康检查只看配置和模型列表；检查索引状态、语义开关、查询前缀、真实 embed 及文献权限 |
| 前端 404/登录循环 | `/history`、`/literature` 前缀，Nginx 去前缀规则，静态文件相对路径，Cookie 域/SSO 路由 |
| schema 报错 | 备份是否为完整 schema 9；只读检查原库，保留原件并停止不兼容升级 |

安装命令和模型信息以官方对应发行版为准。以下是补充依据，执行所需的项目路径、配置和顺序均已写在本文中：

- uv 项目与锁文件：`https://docs.astral.sh/uv/guides/projects/`
- PaddleX 安装及 PP-StructureV3：`https://paddlepaddle.github.io/PaddleX/3.0/en/installation/installation.html`、`https://paddlepaddle.github.io/PaddleX/3.0/en/pipeline_usage/tutorials/ocr_pipelines/PP-StructureV3.html`
- Ollama Linux 安装：`https://docs.ollama.com/linux`
- 嵌入精确标签：`https://ollama.com/library/qwen3-embedding:0.6b-q8_0`
- Nginx URI 转发：`https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass`
