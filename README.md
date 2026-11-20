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

- [页面标点](service/llm.py#L435-L485)
- [页面校对](service/llm.py#L553-L583)
- [元数据识别](service/llm.py#L618-L643)
- [编年补充](service/llm.py#L687-L722)
- [证据回答](service/evidence.py#L101-L109)
- [证据 JSON 模板](service/evidence.py#L96-L100)
- [JSON 公共 system](service/llm.py#L761-L766)
- [缺字段重试](service/llm.py#L792-L798)
- [无材料对话](service/llm.py#L1084-L1090)

### 待做

1. 失败恢复。
2. 补充上传。
3. 章节目录、图表目录。
4. 自动备份。

### 测试

1. 编年。
2. 水印。