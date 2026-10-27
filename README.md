## 数据端

### 虚拟环境（根目录）

uv：
```bash
winget install astral-sh.uv # Windows 系统
curl -LsSf https://astral.sh/uv/install.sh | sh # Linux / macOS 系统
cd history
uv sync
uv sync --upgrade
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

## 提示词索引

- 页面标点：[llm.py L350–L399](service/llm.py#L350-L399)
- 页面校对：[llm.py L467–L496](service/llm.py#L467-L496)
- 元数据识别：[llm.py L531–L556](service/llm.py#L531-L556)
- 编年补充：[llm.py L600–L635](service/llm.py#L600-L635)
- 证据回答：[evidence.py L101–L109](service/evidence.py#L101-L109)
- 证据 JSON 模板：[evidence.py L96–L100](service/evidence.py#L96-L100)
- JSON 公共 system：[llm.py L673–L678](service/llm.py#L673-L678)
- 缺字段重试：[llm.py L705–L711](service/llm.py#L705-L711)
- 无材料对话：[llm.py L1030–L1036](service/llm.py#L1030-L1036)

### 待做

1. 失败恢复。
2. 补充上传。
3. 阅览器侧边栏。
4. 章节目录。

### 测试

1. 编年。
2. 水印。
3. 图表。