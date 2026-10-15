## 数据端

### 虚拟环境（根目录）

uv：
```bash
winget install astral-sh.uv # Windows 系统
curl -LsSf https://astral.sh/uv/install.sh | sh # Linux / macOS 系统
cd history
uv sync
uv lock --upgrade
```

### 数据库维护

```bash
uv run python scripts/storage.py backup # 生成完整备份包
uv run python scripts/storage.py check # 校验数据库和文件资产
uv run python scripts/storage.py vacuum # 压缩和优化数据库
uv run python scripts/storage.py export-json storage/export.json # 导出
uv run python scripts/storage.py import-json storage/export.json # 导入
uv run python scripts/storage.py restore storage/backups/history-backup-YYYYMMDD-HHMMSS.zip --yes # 先停止数据服务，再从完整备份包恢复
```

## 代码端离线验证

代码端不运行数据、OCR、LLM 或嵌入服务，不需要实际文献数据库或模型。安装开发依赖后，测试使用临时 SQLite 和模拟模型，并拦截未模拟的网络请求：

```bash
uv sync --group dev
uv run pytest tests -q
node --test tests/js/retrieval.test.cjs tests/js/evidence-links.test.cjs tests/js/service-status.test.cjs
```

语义检索代码已接入检索、问答和编年：按段索引、混合召回、权限过滤、索引更新与重试、引用校验及原文定位。数据结构统一为 schema 9，不提供旧数据迁移兼容。语义检索默认关闭，嵌入模型暂定 **Qwen3-Embedding-0.6B Q8_0**（`qwen3-embedding:0.6b-q8_0`）；部署配置、索引维护及后续真实模型验收见 [语义检索部署说明](deploy/semantic-search.md)。

### 待做

1. 文献库：标签、文件夹，嵌套。
2. 检索：首页对话、文献库查找、阅览器目录格式。
3. 语义检索部署验收：代码已实现；待数据端/服务端配置嵌入模型并完成真实语料、性能验收。
4. 失败恢复。
5. 图表还原。
6. 文献合并。
7. 文献导出。
8. 对话参考文献私有、公开选项。
