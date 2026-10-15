# 语义检索：部署与离线验证

本仓库是代码端。代码端只安装开发依赖、运行纯函数/临时 SQLite/模拟模型测试，不启动服务，不需要真实文献数据、Ollama、OCR 或嵌入模型。本文的配置和索引操作命令属于后续数据端/服务端部署，不能作为代码端测试的前置条件。

## 交给服务端大模型的部署任务

本次暂定使用 **Qwen3-Embedding-0.6B，Q8_0 量化**，Ollama 精确标签为 **`qwen3-embedding:0.6b-q8_0`**。不要替换为 `latest`、`qwen3-embedding:0.6b` 或生成模型 `qwen3:8b`；后者继续负责问答/编年生成。模型权重仅安装在模型服务端，SQLite、全文、分段与向量保存在数据端。

服务端执行者按下面顺序完成，并返回实际检查结果；本文命令尚未在真实部署主机执行：

1. 检查既有 `history-llm.service`、Ollama 二进制、模型目录和可用内存，沿用现有服务与存储位置。
2. 在模型服务端拉取上述精确标签，确认 Q8_0、1024 维及模型 digest，执行下方接口冒烟检查。
3. 从数据端经原有隧道复查同一模型：数据端 `127.0.0.1:11435` → 模型服务端 `127.0.0.1:11434`。两端应看到相同 digest。
4. 若同时具备数据端操作权限，按下方说明更新代码/前端、配置两站并重启相应单元；只有模型服务端权限时，交付模型标签、digest、端口、接口结果及资源记录，列出待数据端执行的步骤。
5. 数据端录入真实授权文献后完成索引、检索/问答/编年和引用验收。空库接口成功只证明部署连通，不代表召回质量通过验收。

## 模型服务端安装和检查

现有部署约定见 [部署总览](README.md)：模型目录为 `~/history-service/models`，二进制为 `~/history-service/ollama/bin/ollama`，模型服务是用户级 `history-llm.service`。以下命令在运行该服务的同一 Linux 用户下执行。若实际目录不同，先检查 `systemctl --user cat history-llm.service` 并使用已有位置；不要创建另一份模型缓存或重复启动 `ollama serve`。

```bash
systemctl --user status history-llm.service --no-pager
systemctl --user cat history-llm.service
# 现有 Ollama 应处于运行状态；若尚未安装，先按部署总览安装对应 unit。
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_MODELS="$HOME/history-service/models"
"$HOME/history-service/ollama/bin/ollama" --version
"$HOME/history-service/ollama/bin/ollama" pull qwen3-embedding:0.6b-q8_0
"$HOME/history-service/ollama/bin/ollama" show qwen3-embedding:0.6b-q8_0
```

`show` 应显示 Q8_0；不要用创建别名的方式掩盖实际量化不符。下载遇到未知模型或 `/api/embed` 不受支持时，检查模型标签、网络和 Ollama 版本，升级服务端后重新验收，不在代码中加入旧接口兼容分支。

下方 Python 只依赖标准库，在模型服务端运行；它检查真实 digest、量化和查询/正文两条 1024 维有限非零向量，只输出检查摘要。`truncate=false` 确保超长输入直接报错。

```bash
python3 - <<'PY'
import json
import math
import os
import urllib.request

base = os.environ.get("EMBEDDING_API_BASE", "http://127.0.0.1:11434").rstrip("/")
model = "qwen3-embedding:0.6b-q8_0"
def request(route, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + route, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.load(response)

tag = next(m for m in request("/api/tags")["models"] if m.get("name") == model or m.get("model") == model)
assert tag.get("digest"), "missing model digest"
show = request("/api/show", {"model": model})
assert show["details"]["quantization_level"] == "Q8_0", show["details"]
query = "Instruct: Given a question about historical documents, retrieve relevant passages that answer the question\nQuery: 军费从哪里筹措？"
result = request("/api/embed", {"model": model, "input": [query, "筹集饷银，以供军需。"], "truncate": False, "keep_alive": "5m"})
vectors = result["embeddings"]
assert len(vectors) == 2
for vector in vectors:
    assert len(vector) == 1024, len(vector)
    assert all(math.isfinite(x) for x in vector)
    assert math.hypot(*vector) > 0
print(json.dumps({"model": model, "digest": tag["digest"], "quantization": "Q8_0", "dimensions": 1024, "vectors": len(vectors)}, ensure_ascii=False))
PY
# 保留模型已加载时的内存/显存与上下文信息。
curl --fail --silent --show-error http://127.0.0.1:11434/api/ps
```

从数据端复查时，先设置 `export EMBEDDING_API_BASE=http://127.0.0.1:11435`，再执行同一段 Python。同网段直接连接可使用模型服务端实际内网地址；需同时调整数据端配置，沿用现有访问控制。

## 已实现的行为

- 检索、问答、编年共用 `/api/retrieval/query`：当前用户权限过滤后，混合正文向量与字面候选，返回带原文哈希和区间的证据。
- 正文按页内段落切分，目标 500、上限 800、最多重叠 80 个 Unicode 码点；保持原文字符及换行，不跨页。
- SQLite 保存任务、租约和向量。页面保存立即使旧正文索引失效；批量调用期间不占写事务；服务中断等待恢复，非法结果最多尝试三次。
- 生成接口只接受当前证据引用，拒绝虚构 chunkId 和不在原文中的 quote。问答按有来源的要点输出，编年剔除无正文依据的条目。该验证只保证引文与来源一致，不证明模型的历史判断正确。
- 重试使用当轮冻结材料，并重新检查访问权限。编辑问题在原文献范围重新召回；选定空集合不会扩大为全库。
- 引用打开来源页，在独立引用区展示并高亮精确文本层，避免把 OCR、校对文本或笔记混为同一正文，也避免繁简显示转换改变引用。有效句子索引可联动原图；原文已更新则提示定位失效。
- 附件继续以当前对话的临时字面候选进入上下文，不加入全库向量索引。

## 数据库和发布单位

数据结构及前端同步协议统一为 **schema 9**。只支持新结构初始化与校验，不迁移 schema 8，不自动删除已有库。用户已清理相关数据；部署时使用干净的新库。前端缓存键也更新到 schema 9，不读取旧文献/对话缓存。

数据 API、LLM API、前端和维护脚本需要一起更新。完整 SQLite 备份包含派生索引和索引任务；JSON 导入会由页面保存重建分段，向量由后台重新生成。备份恢复和 JSON 导入仍要求当前 schema，不加入旧版本兼容分支。

## 数据端配置

`history-data.service` 读取可选 `/etc/history-semantic.env`；`literature.service` 读取可选 `/etc/literature-semantic.env`。两站各自使用自己的数据库、任务和向量。

部署模板为 [data/semantic.env.example](data/semantic.env.example)。在数据端仓库根目录执行：

```bash
sudo install -m 0640 -o root -g ubuntu deploy/data/semantic.env.example /etc/history-semantic.env
sudo install -m 0640 -o root -g ubuntu deploy/data/semantic.env.example /etc/literature-semantic.env
```

`ubuntu` 是现有 unit 的运行用户；实际用户不同时调整文件属组，确保该用户能读取配置。模板显式指定 `EMBEDDING_MODEL=qwen3-embedding:0.6b-q8_0` 和 `SEMANTIC_SEARCH_ENABLED=true`。更新两站现有配置时，先核对并合并已有地址/凭据；示例 `install` 命令用于首次创建。两站可共用模型服务，数据库各自独立。

模型查询输入默认使用以下英文任务说明；正文不加前缀：

```text
Instruct: Given a question about historical documents, retrieve relevant passages that answer the question
Query: 用户的问题
```

代码仅在选用上述精确模型且未设置 `EMBEDDING_QUERY_PREFIX` 时自动添加这个含真实换行的前缀。模板刻意不定义该变量；旧部署若设置了空值，应移除该行后重启，否则空值会显式禁用前缀。自定义前缀需要保留真实换行，不能把字面 `\n` 当换行。修改前缀会改变模型指纹并触发重建。

首次发布时按部署总览同步数据 API、LLM API、前端和 unit 后，在数据端执行：

```bash
systemctl --user daemon-reload
systemctl --user restart history-data.service literature.service history-llm.service
journalctl --user -u history-data.service -u literature.service -n 100 --no-pager
```

此处的 `history-llm.service` 是**数据端 LLM API**，与模型服务端的同名单元位于不同机器；模型服务端仅拉取权重通常无需重启 Ollama。只启用一站时，仅安装该站配置并重启对应数据 API 和共享 LLM API。

`EMBEDDING_API_BASE` 是 Ollama 根地址；适配器也接受以 `/v1` 结尾的地址并去掉该后缀。使用 `/api/tags` 获取真实 digest，`/api/embed` 批量嵌入并显式 `truncate=false`，拒绝静默截断、维数变化、NaN、Infinity 或零向量。聊天模型 `qwen3:8b` 不应作为嵌入模型填写。

每次嵌入检查模型 digest；digest、维数、查询/文档前缀或分段版本变化时，旧向量空间不参与新召回。后台重新排队，重建期间字面检索仍使用当前正文。模型切换不需要保留旧模型兼容路径；不再使用的派生向量可通过 `rebuild` 清理。

`SEMANTIC_MIN_COSINE` 是候选排序前的下限，默认排除非正相似度，不能作为通用相关性保证。实际模型需用标注语料评测后调整；检索返回的 score 是融合排序分数，不是事实置信度。

## 首页连接状态

首页顶栏按“识别 → 嵌入 → 生成”显示三个独立状态。嵌入通过数据 API 的 `GET /api/embedding/health` 检查当前站点的嵌入配置和 Ollama 模型列表，每 10 秒刷新；不调用 `/api/embed`，不加载模型、不创建索引，也不查询生成服务状态。现有数据 API 代理即可转发，无需新增模型端口或代理路径。

三个服务沿用相同状态表述：`已连接`、`未就绪`、`不可达`、`未连接`。嵌入未启用、模型缺失或响应无效时为“未就绪”；上游连接/超时失败时为“不可达”；浏览器无法取得有效健康检查结果时为“未连接”。“已连接”说明配置模型出现在可访问的模型列表中；实际向量推理仍需完成前文的接口检查。

## 服务端资源

所选 Ollama Q8_0 权重文件约 **639 MB**。短片段、小批量（默认 8）、低并发时，可先为嵌入进程预留 **4 GB 内存，6 GB 更宽裕**；这是部署容量估算，不是官方最低要求或本机实测值，不包含生成模型、OCR、操作系统和数据库的占用。CPU 可运行该模型；GPU 部署另测显存，不能把 639 MB 下载体积当作运行显存。模型最大上下文不应作为实际部署上下文直接照搬；现有 Ollama unit 配置 4096，部署时需用实际加载信息与峰值占用核实。

现有模型 unit 配置最多加载一个模型、并行数为 1。首次沿用同一 Ollama 和隧道，不提高模型加载上限。后台索引在正文任务 queued/running 时暂停新任务；查询嵌入仍可能导致 Qwen3-8B 与嵌入模型互相装卸。记录冷启动/热查询延迟、索引批处理时的峰值 RAM/VRAM 和生成延迟。若切换开销不可接受，再评估独立嵌入实例与端口/隧道，并同步 `EMBEDDING_API_BASE`；不要未经容量核实提高并发。

服务端交付记录至少包含 Ollama 版本、精确标签、digest、Q8_0、实际 1024 维结果、连接路径、RAM/VRAM 峰值、冷/热耗时、已执行与待执行的两端步骤。

## 生成模型上下文预算

LLM API 的可选配置文件为 `/etc/history-generation.env`：

```ini
LLM_CONTEXT_TOKENS=4096
LLM_OUTPUT_TOKENS=1024
LLM_TEMPLATE_MARGIN_TOKENS=256
# 推荐：服务端生成模型对应版本的 tokenizer.json，复制到数据端即可，无需模型权重。
# LLM_TOKENIZER_PATH=/opt/history-tokenizers/qwen3/tokenizer.json
```

三种对话模式按完整提示词、问题、历史、正文及附件计算预算，先裁剪完整旧轮次，再减少低排名片段。实际送模 evidence/history 回传并保存，重试不重新抽取别的材料。输出限制同步传给 Ollama `num_predict` 或 OpenAI 兼容接口 `max_tokens`；Ollama 另收到 `num_ctx`。

配置 tokenizer 时需与实际生成模型匹配；当前模板按 Qwen ChatML 计数，并留模板余量。未配置时按 Qwen 字节级 tokenizer 的 UTF-8 字节上界保守估计，可能容纳更少材料。完整片段无法容纳时明确提示配置错误，不截断 JSON 或默许服务截断输入。修改生成模型或聊天模板后应重新核实预算。

## 索引维护（仅数据端执行）

以下命令本次没有在实际数据端执行，也不会启动 HTTP 服务。维护脚本不会自动读取 systemd 的 `EnvironmentFile`；必须先在同一 shell 加载目标站配置和数据库路径，防止操作到另一站。示例模板可由 Bash 读取：

```bash
cd /home/ubuntu/Codefield/history
set -a
. /etc/history-semantic.env
# 文学站改读 /etc/literature-semantic.env，并设置其 DB 路径。
export DATA_DB_PATH=/home/ubuntu/Codefield/history/storage/app.db
# 文学站路径：/home/ubuntu/Codefield/literature/app.db
set +a
```

确认目标数据库已经由数据 API 初始化为 schema 9，再执行以下命令。服务已开启后台 worker 时通常只需查看 `status`；它会自动建索引，不必额外常驻一个 CLI worker。

```bash
uv run python scripts/semantic_index.py status
uv run python scripts/semantic_index.py status --document DOCUMENT_ID
uv run python scripts/semantic_index.py rebuild
uv run python scripts/semantic_index.py retry
# 主动处理索引会调用配置的嵌入服务；不是代码端离线验证命令。
uv run python scripts/semantic_index.py run --once
```

`rebuild` 只清除选定范围的派生向量和任务，保留正文/文件；后台补偿扫描重新排队。`retry` 重置 failed/waiting 任务，不改变 ready 任务。所有命令沿用当前站点的 `DATA_DB_PATH`。

关闭 `SEMANTIC_SEARCH_ENABLED` 后停止后台索引和语义查询，两站仍可通过统一接口字面召回。正文保存仍维护分段和当前文本版本，以便以后重新启用；停用不是数据库版本回滚。

## 代码端验证与外部验收

```bash
uv sync --group dev
uv run pytest tests -q
node --test tests/js/retrieval.test.cjs tests/js/evidence-links.test.cjs tests/js/service-status.test.cjs
```

测试使用临时库、固定向量和模拟生成结果，拦截未模拟的 urllib 网络调用，不启动 ASGI/HTTP 服务。真实模型召回率、目标主机 p95、内存占用、共享模型资源竞争及浏览器实际页面交互不由这些测试证明。

`tests/fixtures/retrieval_cases.json` 提供 30 条人工编写的**合成材料**评测问题与预期页，供后续整理真实标注集；不是已经运行的生产评测，也不是历史事实来源。实际评测必须将问题/预期页换成数据端真实已授权文献，并先完成该范围的向量索引：

```bash
# 仅在数据端有已建索引的标注语料时执行；会调用真实嵌入服务。
uv run python scripts/semantic_index.py evaluate --user-id USER_ID --cases CASES.json --output storage/retrieval-evaluation.json
```

报告包含字面基线与混合召回的 Recall@10、MRR@10、无证据问题表现、耗时、实际模型指纹和每题返回页。验收仍需检查同名歧义、字号/旧称、繁简、精确番号、跨页事件、无相关证据与权限隔离；同时进行 1 万/5 万片段目标主机性能、模型故障和重启测试。本次代码端没有执行这些外部操作，不声称已达到计划中的召回率或性能指标。

## 模型资料

- Ollama 精确标签与权重规格：https://ollama.com/library/qwen3-embedding:0.6b-q8_0
- Qwen 官方模型卡（架构、1024 维与查询指令格式）：https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- Ollama 资源与并发配置说明：https://docs.ollama.com/faq

模型选择为当前暂定方案；后续更换模型/量化/前缀时更新环境配置并重新构建向量，使用相同真实语料比较后再验收。
