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

### 阅览器原文高亮

页面完成四阶段处理后，悬停或聚焦整理文本中的句子，会高亮原图对应的文字行；点击原图文字区域或使用 Enter / 空格，可反向定位整理文本。一句话可以关联多行。编辑时关闭联动，保存后按最新正文重建索引；没有坐标、对齐不可靠或请求失败时继续普通阅读。

OCR 布局和句子索引独立存入页面索引表，按页加载，只在浏览器内存中缓存。现有页面如果未保存 OCR 布局，则继续普通阅读。

本功能将前后端数据库版本升级为 **schema 8**，继续严格拒绝版本不匹配和缺少表的数据库，不自动迁移。使用 schema 7 的部署需在升级前用旧版本工具做好完整备份，再显式配置新的数据库路径或替换为完整的 schema 8 数据库；已有备份请保留。

已通过后端与浏览器自动化验证，测试文件已在验证完成后删除。真实扫描件的横排、竖排、多栏定位精度，以及编辑后的同步效果，仍需在部署环境完成视觉验收。

### 待做

1. 文献库：标签、文件夹，嵌套。
2. 检索：首页对话、文献库查找、阅览器目录格式。
3. 语义检索：嵌入模型把每段文本向量化建索引，检索/问答/编年按意思召回并回指原文。
4. 失败恢复。
5. 图表还原。
6. 文献合并。
7. 文献导出。
8. 对话参考文献私有、公开选项。
