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

### 待做

1. 一键回到上次浏览位置。
2. 文献库：标签、文件夹，嵌套。
3. 检索，首页对话、文献库查找、阅览器目录格式。
4. 原文高亮。
5. 图表还原。
6. 语义检索：嵌入模型把每段文本向量化建索引，检索/问答/编年按意思召回并回指原文。
7. 分离简繁转换和句读。
