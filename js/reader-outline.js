/* 章节目录卡片：服务端从整理文本识别各级标题，点击跳到对应页并高亮该标题所在句。 */
const readerOutlineCache = new Map();
const readerOutlineState = {
  documentId: null, snapshot: "", loading: false, error: "", outline: null,
  revision: 0, navigationRevision: 0, activeId: "", button: null, panel: null, bound: false,
};

function readerOutlinePageText(page) {
  return page?.punctuatedText || page?.ocrText || "";
}

function readerOutlineSnapshot(item) {
  return JSON.stringify([typeof currentUser === "undefined" ? "" : currentUser?.id, item?.id,
    item?.processingRevision, item?.updatedAt,
    (item?.pages || []).map((page) => [page.id, page.pageNumber, page.processingRevision,
      readerOutlinePageText(page).length, readerOutlinePageText(page).slice(0, 40)])]);
}

function readerOutlineNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ensureReaderOutline() {
  const state = readerOutlineState;
  const button = document.querySelector('[data-reader-sidebar-tab="chapters"]');
  const panel = document.querySelector("#reader-chapters-panel");
  if (!button || !panel) return false;
  button.setAttribute("aria-controls", "reader-chapters-panel");
  button.setAttribute("aria-label", "章节目录");
  state.button = button;
  state.panel = panel;
  if (!state.bound) {
    state.bound = true;
    panel.addEventListener("click", (event) => {
      const row = event.target?.closest?.("[data-outline-id]");
      if (row && panel.contains(row)) navigateReaderOutline(row.dataset.outlineId);
    });
  }
  return true;
}

function isReaderOutlineValid(outline, item) {
  return Boolean(outline && outline.version === 1 && outline.documentId === item.id &&
    Array.isArray(outline.items) && Number.isInteger(outline.total) && outline.total === outline.items.length &&
    Number.isInteger(outline.textPages) && Number.isInteger(outline.totalPages) &&
    outline.items.every((entry) => entry && typeof entry.id === "string" && entry.id &&
      typeof entry.pageId === "string" && entry.pageId && typeof entry.title === "string" && entry.title &&
      Number.isInteger(entry.level) && entry.level >= 1 && Number.isFinite(entry.pageNumber) &&
      Number.isInteger(entry.start) && entry.start >= 0));
}

function renderReaderOutline() {
  const state = readerOutlineState, panel = state.panel;
  if (!panel) return;
  const focused = document.activeElement;
  const focusedRow = focused?.closest?.("[data-outline-id]");
  const restoreId = focusedRow && panel.contains(focusedRow) ? focusedRow.dataset.outlineId : "";
  panel.setAttribute("aria-busy", String(state.loading));
  panel.replaceChildren();
  const heading = readerOutlineNode("div", "section-heading reader-chapter-catalog-heading");
  heading.append(readerOutlineNode("h3", "", "章节"));
  panel.append(heading);
  const status = readerOutlineNode("p", "reader-chapter-catalog-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  panel.append(status);
  if (!state.documentId) { status.textContent = "请先打开文献"; return; }
  if (state.loading) { status.textContent = "正在识别章节标题…"; return; }
  if (state.error) {
    status.textContent = state.error;
    const retry = readerOutlineNode("button", "reader-chapter-catalog-retry", "重试");
    retry.type = "button";
    retry.addEventListener("click", () => {
      readerOutlineCache.delete(state.snapshot);
      syncReaderOutline(getSelectedDocument());
    });
    panel.append(retry);
    return;
  }
  const outline = state.outline;
  if (!outline) return;
  if (!outline.items.length) {
    status.textContent = outline.complete ? "未识别到章节标题" : "尚未识别到章节标题，目录仍在生成";
    return;
  }
  status.textContent = `${outline.total} 个标题 · 已识别 ${outline.textPages}/${outline.totalPages} 页` +
    (outline.complete ? "" : " · 目录仍在生成");
  const list = readerOutlineNode("ol", "reader-chapter-catalog-items");
  for (const entry of outline.items) {
    const li = document.createElement("li");
    const button = readerOutlineNode("button", "reader-chapter-catalog-item");
    button.type = "button";
    button.dataset.outlineId = entry.id;
    button.dataset.level = String(entry.level);
    button.style.paddingLeft = `${8 + (entry.level - 1) * 14}px`;
    button.append(readerOutlineNode("span", "reader-chapter-catalog-title", entry.title));
    button.append(readerOutlineNode("span", "reader-chapter-catalog-page", `第 ${entry.pageNumber} 页`));
    if (entry.id === state.activeId) button.setAttribute("aria-current", "true");
    li.append(button);
    list.append(li);
  }
  panel.append(list);
  if (restoreId) {
    Array.from(list.querySelectorAll("[data-outline-id]"))
      .find((row) => row.dataset.outlineId === restoreId)?.focus();
  }
}

async function syncReaderOutline(item) {
  const state = readerOutlineState;
  const snapshot = readerOutlineSnapshot(item);
  if (snapshot !== state.snapshot) {
    if (state.documentId !== (item?.id || null)) state.navigationRevision++;
    state.snapshot = snapshot;
    state.documentId = item?.id || null;
    state.outline = null;
    state.error = "";
    state.loading = false;
    state.activeId = "";
    state.revision++;
  }
  if (!ensureReaderOutline()) return;
  renderReaderOutline();
  const open = Boolean(state.panel && !state.panel.hidden);
  if (!open || !item?.id) return;
  const revision = state.revision;
  let entry = readerOutlineCache.get(snapshot);
  if (!entry) {
    entry = { value: null, promise: null };
    readerOutlineCache.set(snapshot, entry);
    while (readerOutlineCache.size > 6) readerOutlineCache.delete(readerOutlineCache.keys().next().value);
    entry.promise = (async () => {
      const response = await fetch(DATA_PROCESSING_URL + "/" + encodeURIComponent(item.id) + "/outline", { cache: "no-store" });
      if (!response.ok) throw new Error("章节目录加载失败，请重试");
      const outline = await response.json();
      if (!isReaderOutlineValid(outline, item)) throw new Error("章节目录数据无效，请重试");
      entry.value = outline;
      return outline;
    })();
  }
  if (entry.value) { state.outline = entry.value; state.error = ""; renderReaderOutline(); return; }
  state.loading = true;
  state.error = "";
  renderReaderOutline();
  try {
    const outline = await entry.promise;
    if (state.revision !== revision || state.snapshot !== snapshot || readerOutlineSnapshot(getSelectedDocument()) !== snapshot) return;
    state.outline = outline;
  } catch (error) {
    if (readerOutlineCache.get(snapshot) === entry) readerOutlineCache.delete(snapshot);
    if (state.revision !== revision || state.snapshot !== snapshot) return;
    state.error = error.message || "章节目录加载失败，请重试";
  } finally {
    if (state.revision === revision && state.snapshot === snapshot) {
      state.loading = false;
      renderReaderOutline();
    }
  }
}

function readerOutlineSentence(index, offset) {
  if (!index?.sentences?.length) return null;
  return index.sentences.find((sentence) => offset >= sentence.start && offset < sentence.end) ||
    index.sentences.find((sentence) => sentence.start >= offset) || null;
}

// 没有句子索引时（未校对的页），退回到「整理文本」里带偏移的文本节点。
function scrollReaderOutlineTarget(offset) {
  const container = typeof readerText === "undefined" ? null : readerText;
  const nodes = container?.querySelectorAll("[data-reader-text-start]") || [];
  if (!nodes.length) {
    if (container) container.scrollTop = 0;
    return null;
  }
  const target = Array.from(nodes).find((node) =>
    Number(node.dataset.readerTextStart) <= offset && offset < Number(node.dataset.readerTextEnd)) ||
    Array.from(nodes).find((node) => Number(node.dataset.readerTextStart) >= offset) || null;
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.classList.add("is-outline-target");
    window.setTimeout(() => target.classList.remove("is-outline-target"), 2200);
  }
  return target;
}

async function navigateReaderOutline(id) {
  const state = readerOutlineState, item = getSelectedDocument();
  const entry = state.outline?.items.find((row) => row.id === id);
  if (!item || state.documentId !== item.id || !entry) return false;
  const token = ++state.navigationRevision;
  try {
    const beforePage = getSelectedPage();
    if (typeof saveReaderBeforeVisualNavigation === "function") {
      if (!await saveReaderBeforeVisualNavigation(item, beforePage)) throw new Error("请先保存当前页的修改");
    } else if (readerEditing) {
      throw new Error("请先保存当前页的修改");
    }
    if (getSelectedDocument()?.id !== item.id || token !== state.navigationRevision) return false;
    const live = getSelectedDocument();
    const page = live.pages.find((row) => row.id === entry.pageId);
    if (!page) throw new Error("目录对应的页面不存在，请重试");
    if (Number(entry.sourceRevision || 0) !== Number(page.processingRevision || 0)) {
      readerOutlineCache.delete(state.snapshot);
      throw new Error("章节目录已更新，请重试");
    }
    state.activeId = id;
    selectedPageId = page.id;
    syncSelectionToUrl();
    renderReader();
    const index = await loadReaderIndex(live.id, page.id);
    if (token !== state.navigationRevision || getSelectedDocument()?.id !== live.id ||
        getSelectedPage()?.id !== page.id) return true;
    const currentPage = getSelectedPage();
    const sentence = index && typeof isReaderIndexValid === "function" && isReaderIndexValid(index, currentPage)
      ? readerOutlineSentence(index, entry.start) : null;
    if (sentence) {
      // 索引可能是在本次渲染之后才加载完的，重绘一次保证正文已经按句子切成节点。
      if (typeof readerText !== "undefined" && readerText && !readerText.querySelector("[data-sentence-id]")) renderReader();
      if (typeof setReaderCitationSentence === "function") setReaderCitationSentence(sentence.id);
      else scrollReaderOutlineTarget(entry.start);
    } else {
      scrollReaderOutlineTarget(entry.start);
    }
    state.error = "";
    renderReaderOutline();
    return true;
  } catch (error) {
    if (token === state.navigationRevision && getSelectedDocument()?.id === item.id) {
      state.error = error.message || "章节定位失败，请重试";
      renderReaderOutline();
    }
    return false;
  }
}
