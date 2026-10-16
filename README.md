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

### 对话参考文献

对话未选择参考文献时，仅检索当前用户拥有的文献，包括自己发布的公开文献和下载到个人文献库的副本。参考文献选择列表也只显示这些文献；公开文献库中尚未下载的文献不参与检索。

### 待做

1. 文献库查找：标签、层级。
2. 失败恢复。
3. 图表还原。
4. 文献合并。
5. 测试编年。
