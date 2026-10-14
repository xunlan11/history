# 阅览器原文高亮与双向索引实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development or native task-by-task execution to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一页完成 OCR、简繁转换、标点和校对后，为原文图片与中栏整理文本建立句子级关联，实现中栏句子悬停时高亮图片对应区域，并支持从图片区域反向定位中栏句子。

**Architecture:** 保留现有四阶段处理流程，不增加第五个用户可见阶段。OCR 阶段保存页面文字行及坐标；校对完成后由后端生成一份独立的页面阅读索引，前端按页加载索引，在图片上使用 SVG 覆盖层显示坐标，在整理文本中使用句子 `<span>` 建立交互。索引是正文处理完成后的派生结果，生成失败不影响正文阅读。

**Tech Stack:** Python、FastAPI、SQLite、现有后端调度器、原生 JavaScript、HTML、CSS、SVG。

**Spec:** 本文件即本功能的设计与实施规格；实现前应以本文件的接口、数据结构和失败降级约束为准。

## Global Constraints

- 保持现有四个主阶段：`ocr`、`variant`、`punctuation`、`proofreading`；不把阅读索引加入 `PROCESSING_STAGES`，不增加第五个主进度格。
- 阅读索引只在页面最终整理文本完成后展示；索引为 `ready` 前，中栏和图片继续使用现有普通阅读模式。
- 原文图片坐标使用 OCR 返回的原始像素坐标，并通过页面宽高换算为响应式 SVG 坐标。
- 不把完整 `lines`、`blocks` 和句子索引加入全量文献快照或 `localStorage`；索引按页面独立存储、按页面请求。
- 索引生成失败不能把已经完成的正文页面标记为处理失败；页面必须保留可读的原图和整理文本。
- 文本编辑模式暂时关闭联动；用户保存编辑结果后，旧索引必须标记为 `stale`，不能继续使用旧坐标。
- 所有页面索引 API 必须复用现有文献可见性和用户权限检查。
- 对齐不可靠时宁可不显示图片高亮，也不能高亮到错误的历史文本区域。

## Review Focus

- 一句话跨越多条 OCR 行时，所有对应行的区域都应同时高亮；测试归入对齐模块任务。
- OCR 文本经过 OpenCC 简体转换后，字符仍应能够对应到原图片行；测试归入对齐模块任务。
- 校对阶段修改、删除或补充字符后，无法精确对齐的句子应标记为低置信度或不匹配；测试归入对齐模块任务。
- 缺少 OCR 坐标、图片尺寸或索引接口失败时，阅览器应回退为现有普通图片和纯文本；测试归入前端任务。
- 用户在中栏编辑并保存后，旧句子节点和图片高亮不得继续使用；测试归入编辑状态任务。

---

### Task 1: 保存 OCR 版面行和索引元数据

**Files:**
- Create: `service/reader_index.py`
- Modify: `service/scheduler.py:418-426`
- Modify: `service/data.py:194-340`
- Modify: `js/core.js:394-420, 1324-1364`
- Test: `tests/test_reader_index.py`

**Interfaces:**

- `service/reader_index.py` 提供 `normalize_ocr_layout(result: dict[str, Any]) -> dict[str, Any]`，只保留页面宽高、按阅读顺序排列的文本行、行文本、`bbox`、`polygon` 和必要的块顺序信息。
- `service/reader_index.py` 提供 `reader_index_status_payload(status: str, source_revision: int, text_hash: str = "", error: str = "") -> dict[str, Any]`，统一生成轻量状态元数据。
- `service/data.py` 增加页面级阅读索引存储，索引按 `page_id` 唯一，至少包含 `document_id`、`status`、`source_revision`、`text_hash`、`payload`、`error`、`updated_at`。
- `service/data.py` 增加 `GET /api/documents/{document_id}/pages/{page_id}/reader-index`，返回页面索引状态和索引内容；接口必须先执行现有页面可见性检查。
- `scheduler.py` 在 OCR 完成时保存归一化后的 OCR 行布局到阅读索引记录，状态为 `waiting_text`，而不是把完整坐标写进文献快照。
- 前端页面对象只保留 `readerIndexStatus`、`readerIndexRevision`、`readerIndexUpdatedAt` 等轻量字段；`normalizeDocuments` 不保存完整坐标数组。

**Data shape:**

```json
{
  "status": "waiting_text | building | ready | stale | failed",
  "sourceRevision": 3,
  "textHash": "sha256-or-equivalent",
  "imageWidth": 1654,
  "imageHeight": 2339,
  "lines": [
    {
      "id": "line-001",
      "order": 1,
      "text": "OCR 原文行",
      "normalizedText": "简体 OCR 行",
      "bbox": [120, 240, 1460, 285],
      "polygon": [[120, 240], [1460, 240], [1460, 285], [120, 285]]
    }
  ],
  "sentences": []
}
```

**Steps:**

- [ ] **Step 1: 写 OCR 布局归一化测试**

  测试包含正常行、缺失 `bbox`、只有多边形、空行和缺失页面尺寸；断言输出不包含无关的 OCR 大字段，并保持阅读顺序。

- [ ] **Step 2: 实现布局归一化和索引状态结构**

  从现有 OCR 服务返回的 `blocks`、`lines`、`width`、`height` 中提取稳定字段；为没有坐标的行保留文本但将坐标置空。

- [ ] **Step 3: 增加页面级索引存储和读取 API**

  在 SQLite schema 中增加页面索引记录，读取接口返回 `status`、版本信息和索引 payload；删除文献或页面时依靠外键级联清理。

- [ ] **Step 4: 在 OCR 完成时保存行布局**

  调整 `scheduler.py` 的 OCR 完成分支，保存归一化布局和 `waiting_text` 状态；正文中的 `ocrText`、OCR 摘要和现有处理状态保持原行为。

- [ ] **Step 5: 更新前端轻量状态归一化**

  让 `normalizeDocuments` 接收索引状态字段，但不要把 `lines` 或 `sentences` 放入页面对象和本地缓存。

- [ ] **Step 6: 运行测试**

  Run: `python -m unittest tests/test_reader_index.py -v`

  Expected: OCR 布局归一化和页面索引存取测试全部通过。

---

### Task 2: 生成句子到 OCR 区域的对齐索引

**Files:**
- Modify: `service/reader_index.py`
- Modify: `service/scheduler.py` 的校对完成分支
- Test: `tests/test_reader_index.py`

**Interfaces:**

- `normalize_for_alignment(text: str) -> str`：只用于对齐，移除标点、空白和换行，不改变正文内容。
- `split_sentences(text: str) -> list[dict[str, Any]]`：根据现代汉语句末标点拆分句子，返回每句的原文本、起始偏移和结束偏移。
- `build_reader_index(*, layout: dict[str, Any], source_text: str, displayed_text: str, source_revision: int) -> dict[str, Any]`：返回完整页面索引；`displayed_text` 必须是阅览器实际展示的最终整理文本。
- 每个句子对象至少包含：`id`、`text`、`start`、`end`、`lineIds`、`boxes`、`confidence`。

**Alignment rules:**

- 优先对齐简体 OCR 文本与最终整理文本去掉标点后的字符序列。
- 标点新增不计入字符匹配；换行和空白不作为正文字符匹配。
- OpenCC 转换后的行文本使用 `normalizedText` 参与对齐，原始 `text` 只用于保留原始信息。
- 一句话覆盖多个 OCR 行时，句子对象保留多个 `lineIds` 和多个 `boxes`。
- 一个 OCR 行包含多个句子时，按字符范围切分该行的矩形区域；无法安全切分时使用整行区域并降低置信度。
- 精确匹配使用 `exact`；通过局部模糊匹配得到的结果使用 `fuzzy`；无法可靠定位的句子使用 `unmatched`，其 `boxes` 为空。
- 对齐算法不能修改 `displayed_text`，只生成索引。

**Steps:**

- [ ] **Step 1: 写句子拆分和字符对齐测试**

  测试以下输入：普通多句文本、句子跨两行、一个 OCR 行包含两句、繁体转简体、标点新增、校对改字、无法匹配的句子。

- [ ] **Step 2: 实现句子拆分和对齐工具**

  保留最终文本中的原始字符偏移，避免前端重新切分造成 `data-sentence-id` 与后端索引错位。

- [ ] **Step 3: 实现行坐标聚合**

  将句子命中的行和坐标整理为 `lineIds`、`boxes`；缺少坐标时保留句子文本和状态，但不生成虚假的图片区域。

- [ ] **Step 4: 在校对完成后生成索引**

  以页面最终的 `punctuatedText` 为 `displayed_text`，加载 OCR 阶段保存的布局，生成索引并更新页面记录为 `ready`。索引生成异常时记录 `failed` 和错误信息，但捕获异常，不回滚正文处理成功状态。

- [ ] **Step 5: 处理旧索引失效**

  使用页面 `processingRevision` 和最终文本 hash 校验索引；文本、OCR 结果或图片尺寸变化时将旧索引标记为 `stale`。

- [ ] **Step 6: 运行对齐测试**

  Run: `python -m unittest tests/test_reader_index.py -v`

  Expected: 所有精确、模糊和不匹配场景符合上面的 confidence 规则。

---

### Task 3: 在阅览器中加载句子索引并渲染图片高亮

**Files:**
- Modify: `js/documents.js:713-772, 1033-1063`
- Modify: `js/core.js` 增加页面索引 URL、缓存和状态工具
- Modify: `js/reader.js` 增加联动状态管理
- Modify: `styles.css` 增加图片覆盖层和句子状态样式
- Test: `tests/reader-index-ui.md` 或手工验收记录

**Interfaces:**

- `getReaderIndexUrl(documentId, pageId) -> string`：生成页面索引 API 地址。
- `loadReaderIndex(documentId, pageId) -> Promise<ReaderIndex>`：按页面加载并缓存索引；请求失败返回 `null`，不得阻塞 `renderReader()`。
- `renderReaderText(page, readerIndex?)`：有可用索引时按 `sentences` 渲染句子节点；无索引时继续使用现有纯文本渲染。
- `renderReaderOriginal(page, readerIndex?)`：保留现有图片渲染，并在图片上方创建 SVG 高亮层。
- `setReaderLinkActive(sentenceId: string | null) -> void`：统一设置中栏句子和图片区域的 active 状态。

**Rendering rules:**

- 图片和 SVG 使用同一个相对定位容器；SVG 的 `viewBox` 使用索引中的 `imageWidth` 和 `imageHeight`。
- 每个句子节点使用 `data-sentence-id`，并设置 `tabindex="0"`，支持鼠标悬停和键盘聚焦。
- 鼠标进入、键盘聚焦句子时，同时激活所有对应图片区域；鼠标离开或焦点离开时清除激活状态。
- 高亮只使用 `exact` 和 `fuzzy` 中有 `boxes` 的句子；`unmatched` 不绘制区域。
- 索引仍在 `loading`、`failed` 或 `stale` 时，保持当前普通阅读表现。
- 图片加载完成后再计算覆盖层尺寸，图片响应式缩放不能导致高亮错位。
- 编辑模式中恢复普通文本，关闭句子联动；保存后重新请求索引状态。

**Steps:**

- [ ] **Step 1: 写前端降级和渲染验收用例**

  明确验证：索引 ready、索引加载失败、无坐标、图片未加载、句子跨多行、进入编辑模式和页面切换时没有残留高亮。

- [ ] **Step 2: 增加按页索引加载和缓存**

  缓存 key 使用 `documentId + pageId + sourceRevision`；切换页面或文献时清理当前 active 状态，避免旧页面高亮残留。

- [ ] **Step 3: 将中栏文本渲染为句子节点**

  保持现有空状态、备注显示和 `contentEditable` 行为；只有索引有效时使用句子节点。

- [ ] **Step 4: 增加 SVG 图片覆盖层**

  使用 `polygon` 或 `rect` 绘制句子区域；同一句话的多个区域使用同一个 `data-sentence-id`。

- [ ] **Step 5: 实现中栏到图片的悬停和键盘联动**

  事件使用事件委托，统一调用 `setReaderLinkActive`；当前区域进入视口时允许滚动图片容器，但不要改变页面选择状态。

- [ ] **Step 6: 运行静态检查和手工验收**

  Run: `git diff --check`，并在真实处理完成的一页上逐项验收：正常句子、跨行句子、无法匹配句子、页面切换和索引失败降级。

---

### Task 4: 实现图片区域反向定位和编辑后的索引重建

**Files:**
- Modify: `js/reader.js`
- Modify: `js/documents.js`
- Modify: `service/data.py`
- Modify: `service/scheduler.py`
- Test: `tests/reader-index-ui.md` 或手工验收记录

**Interfaces:**

- `setReaderLinkActive(sentenceId: string | null, options?: { scrollText?: boolean; scrollImage?: boolean }) -> void`：正向和反向联动共用。
- 图片区域点击时根据 `data-sentence-id` 定位句子，并调用 `setReaderLinkActive(id, { scrollText: true })`。
- 保存正文后调用 `markReaderIndexStale(documentId, pageId, processingRevision)`；后端下一次生成索引后恢复 `ready`。

**Steps:**

- [ ] **Step 1: 为 SVG 区域增加点击和键盘操作**

  点击图片高亮区域后滚动中栏到对应句子，并保留短暂 selected 状态；区域必须具备可访问的 `aria-label`。

- [ ] **Step 2: 处理编辑保存后的索引失效**

  保存正文时比较文本 hash；内容变化则将索引标记为 `stale`，内容未变化则继续复用现有索引。

- [ ] **Step 3: 增加索引重建触发**

  索引重建作为轻量派生任务执行，不改变四阶段进度和页面正文状态；完成后通过现有同步机制刷新 `readerIndexStatus`。

- [ ] **Step 4: 验证双向联动和失效恢复**

  验收图片点击定位文本、文本悬停定位图片、编辑保存后高亮关闭、索引重新 ready 后高亮恢复。

---

### Task 5: 全流程回归和兼容旧数据

**Files:**
- Modify: `js/core.js` 的旧页面归一化逻辑（如需要）
- Modify: `service/data.py` 的 schema 兼容逻辑（如需要）
- Create: `tests/reader-index-regression.md`

**Steps:**

- [ ] **Step 1: 验证旧文献兼容**

  没有 OCR 坐标或没有阅读索引的旧页面仍然正常显示图片、OCR 文本和整理文本，不触发异常请求循环。

- [ ] **Step 2: 验证权限和页面切换**

  私有文献、公开文献、无权限页面和快速连续切页都不能泄露或混用索引数据。

- [ ] **Step 3: 验证不同版面**

  至少覆盖横排文本、竖排 OCR 重排文本、多行句子、多栏页面和无文本图片。

- [ ] **Step 4: 验证性能**

  确认初始文献快照大小没有因为 OCR 坐标显著增加；索引只在打开页面时按需加载；连续悬停不触发网络请求。

- [ ] **Step 5: 完成最终检查**

  Run: `git diff --check`；运行后端单元测试；完成浏览器手工验收；确认四阶段进度文案仍为原来的四阶段。

## 预计改动范围

- 新增：`service/reader_index.py`
- 新增：页面级阅读索引存储及 API，具体实现放在 `service/data.py`
- 修改：`service/scheduler.py`，保存 OCR 坐标并在校对完成后生成索引
- 修改：`js/core.js`，只保存轻量索引状态并提供按页加载工具
- 修改：`js/documents.js`，渲染句子节点和图片 SVG 覆盖层
- 修改：`js/reader.js`，管理联动、悬停、聚焦、点击和缓存状态
- 修改：`styles.css`，增加高亮、选中和降级状态样式
- 新增：后端对齐单元测试和前端手工验收记录

## 明确不做的事情

- 不增加第五个用户可见的处理阶段。
- 不要求大模型返回图片坐标。
- 不把完整 OCR 坐标写入 `localStorage` 或全量文献快照。
- 不在索引匹配失败时凭猜测扩大高亮范围。
- 不在用户编辑过程中持续维护复杂的句子 DOM 联动。
- 不因为索引失败而重新执行 OCR、标点或校对。