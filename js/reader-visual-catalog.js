/* Optional floating catalogue. The parent calls syncReaderVisualCatalog(item) from renderReader. */
const readerVisualCatalogCache = new Map();
const readerVisualCatalogButtons = new WeakSet();
const readerVisualCatalogState = {
  documentId: null, snapshot: "", open: false, loading: false, error: "", catalog: null,
  revision: 0, navigationRevision: 0, button: null, panel: null, bound: false,
};

function readerVisualCatalogSnapshot(item) {
  return JSON.stringify([typeof currentUser === "undefined" ? "" : currentUser?.id, item?.id,
    item?.processingRevision, item?.catalogRevision, item?.updatedAt,
    (item?.pages || []).map((page) => [page.id, page.processingRevision, page.imageHash,
      page.readerContentRevision, page.readerContentUpdatedAt, page.updatedAt, page.visualsExtracted, page.visuals])]);
}

function readerVisualCatalogNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ensureReaderVisualCatalog() {
  const state = readerVisualCatalogState;
  const host = document.querySelector("#reader-visual-catalog-toggle");
  let button = host?.tagName === "BUTTON" ? host : host?.querySelector("[data-reader-catalog-button]");
  if (!button) {
    button = document.querySelector("[data-reader-catalog-button]");
    if (host && button && !host.contains(button)) { button.remove(); button = null; }
  }
  if (!button) {
    const sidebarToggle = document.querySelector(".reader-sidebar-toggle") || document.querySelector("#reader-sidebar-toggle");
    const anchor = host || sidebarToggle?.parentElement || document.querySelector("#reader-sidebar") || document.querySelector(".reader-sidebar");
    if (!anchor) return false;
    button = readerVisualCatalogNode("button", "reader-visual-catalog-toggle", "图表目录");
    button.type = "button";
    button.dataset.readerCatalogButton = "true";
    if (!host && sidebarToggle) button.classList.add("is-reader-rail-button");
    anchor.append(button);
  }
  button.classList.add("reader-visual-catalog-toggle");
  button.setAttribute("aria-controls", "reader-visual-catalog");
  button.setAttribute("aria-expanded", String(state.open));
  button.setAttribute("aria-label", "图表目录");
  state.button = button;
  if (!readerVisualCatalogButtons.has(button)) {
    readerVisualCatalogButtons.add(button);
    button.addEventListener("click", () => {
      state.open = !state.open;
      button.setAttribute("aria-expanded", String(state.open));
      if (state.open) {
        syncReaderVisualCatalog(getSelectedDocument());
        state.panel?.querySelector("button")?.focus();
      } else closeReaderVisualCatalog();
    });
  }
  state.panel = document.querySelector("#reader-visual-catalog");
  if (!state.panel) {
    state.panel = readerVisualCatalogNode("section", "reader-visual-catalog");
    state.panel.id = "reader-visual-catalog";
    state.panel.setAttribute("role", "region");
    state.panel.setAttribute("aria-label", "图表目录");
    document.body.append(state.panel);
    state.panel.addEventListener("click", (event) => {
      const row = event.target?.closest?.("[data-catalog-page-id]");
      if (row && state.panel.contains(row)) navigateReaderVisualCatalog(row.dataset.catalogPageId, row.dataset.catalogVisualId);
    });
  }
  if (!state.bound) {
    state.bound = true;
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) { event.preventDefault(); closeReaderVisualCatalog(); }
    });
  }
  state.panel.hidden = !state.open;
  return true;
}

function closeReaderVisualCatalog() {
  const state = readerVisualCatalogState;
  state.open = false;
  if (state.panel) state.panel.hidden = true;
  state.button?.setAttribute("aria-expanded", "false");
  state.button?.focus();
}

function renderReaderVisualCatalog() {
  const state = readerVisualCatalogState, panel = state.panel;
  if (!panel) return;
  panel.hidden = !state.open;
  const focused = document.activeElement;
  const focusedRow = focused?.closest?.("[data-catalog-page-id]");
  const restoreRow = focusedRow && panel.contains(focusedRow) ? { ...focusedRow.dataset } : null;
  panel.setAttribute("aria-busy", String(state.loading));
  panel.replaceChildren();
  const heading = readerVisualCatalogNode("div", "reader-visual-catalog-heading");
  heading.append(readerVisualCatalogNode("h3", "", "图表目录"));
  const close = readerVisualCatalogNode("button", "reader-visual-catalog-close", "关闭");
  close.type = "button";
  close.addEventListener("click", closeReaderVisualCatalog);
  heading.append(close);
  panel.append(heading);
  const status = readerVisualCatalogNode("p", "reader-visual-catalog-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  panel.append(status);
  if (!state.documentId) { status.textContent = "请先打开文献"; return; }
  if (state.loading) { status.textContent = "正在加载图表目录…"; return; }
  if (state.error) {
    status.textContent = state.error;
    const retry = readerVisualCatalogNode("button", "reader-visual-catalog-retry", "重试");
    retry.type = "button";
    retry.addEventListener("click", () => {
      readerVisualCatalogCache.delete(state.snapshot);
      syncReaderVisualCatalog(getSelectedDocument());
    });
    panel.append(retry);
    return;
  }
  const selectedItem = typeof getSelectedDocument === "function" ? getSelectedDocument() : null;
  const selectedPage = typeof getSelectedPage === "function" ? getSelectedPage() : null;
  if (typeof createReaderVisualBackfill === "function") {
    const backfill = createReaderVisualBackfill(selectedItem, selectedPage);
    if (backfill) panel.append(backfill);
  }
  const catalog = state.catalog;
  if (!catalog) return;
  const entries = catalog.items.slice().sort((a, b) => a.pageNumber - b.pageNumber || a.blockOrder - b.blockOrder);
  status.textContent = !entries.length ? (catalog.complete ? "暂无图表" : "已索引页面暂无图表，目录仍在生成") :
    `${catalog.total} 项图表 · 已索引 ${catalog.indexedPages}/${catalog.totalPages} 页${catalog.complete ? "" : " · 目录仍在生成"}`;
  const list = readerVisualCatalogNode("ol", "reader-visual-catalog-items");
  for (const entry of entries) {
    const li = document.createElement("li");
    const button = readerVisualCatalogNode("button", "reader-visual-catalog-item");
    button.type = "button";
    button.dataset.catalogPageId = entry.pageId;
    button.dataset.catalogVisualId = entry.visualId;
    const kindLabel = ({ figure: "插图", chart: "统计图", table: "表格", caption: "图注" })[entry.kind] || "图表";
    const title = entry.title || `未题名${kindLabel} · 页内第 ${entries.filter((row) => row.pageId === entry.pageId).indexOf(entry) + 1} 项`;
    const stateLabel = entry.status === "missing" ? " · 图像待提取" : entry.status === "unassigned" ? " · 待核对" : "";
    button.append(readerVisualCatalogNode("span", "reader-visual-catalog-title", `${kindLabel} · ${title}${stateLabel}`));
    button.append(readerVisualCatalogNode("span", "reader-visual-catalog-page", `第 ${entry.pageNumber} 页`));
    const selected = typeof getSelectedPage === "function" ? getSelectedPage() : null;
    if (selected?.id === entry.pageId && typeof readerVisualState !== "undefined" && readerVisualState.selected?.id === entry.visualId) {
      button.setAttribute("aria-current", "true");
    }
    li.append(button); list.append(li);
  }
  panel.append(list);
  if (restoreRow) {
    const restored = Array.from(list.querySelectorAll("[data-catalog-page-id]")).find((row) =>
      row.dataset.catalogPageId === restoreRow.catalogPageId && row.dataset.catalogVisualId === restoreRow.catalogVisualId);
    restored?.focus();
  }
}

function isReaderVisualCatalogValid(catalog, item) {
  return Boolean(catalog && catalog.documentId === item.id && Array.isArray(catalog.items) &&
    [catalog.total, catalog.indexedPages, catalog.totalPages].every((n) => Number.isInteger(n) && n >= 0) &&
    catalog.total === catalog.items.length && catalog.indexedPages <= catalog.totalPages && typeof catalog.complete === "boolean" &&
    catalog.items.every((entry) => entry && typeof entry.pageId === "string" && typeof entry.visualId === "string" && entry.visualId &&
      Number.isFinite(entry.pageNumber) && Number.isFinite(entry.blockOrder) &&
      ["figure", "chart", "table", "caption"].includes(entry.kind) && ["structured", "image"].includes(entry.renderMode)));
}

async function syncReaderVisualCatalog(item) {
  const state = readerVisualCatalogState;
  const snapshot = readerVisualCatalogSnapshot(item);
  if (snapshot !== state.snapshot) {
    if (state.documentId !== (item?.id || null)) state.navigationRevision++;
    state.snapshot = snapshot;
    state.documentId = item?.id || null;
    state.catalog = null;
    state.error = "";
    state.loading = false;
    state.revision++;
  }
  if (!ensureReaderVisualCatalog()) return;
  state.button.disabled = !item;
  renderReaderVisualCatalog();
  if (!state.open || !item?.id) return;
  const revision = state.revision;
  let entry = readerVisualCatalogCache.get(snapshot);
  if (!entry) {
    entry = { value: null, promise: null };
    readerVisualCatalogCache.set(snapshot, entry);
    while (readerVisualCatalogCache.size > 6) readerVisualCatalogCache.delete(readerVisualCatalogCache.keys().next().value);
    entry.promise = (async () => {
      const response = await fetch(DATA_PROCESSING_URL + "/" + encodeURIComponent(item.id) + "/visual-catalog", { cache: "no-store" });
      if (!response.ok) throw new Error("图表目录加载失败，请重试");
      const catalog = await response.json();
      if (!isReaderVisualCatalogValid(catalog, item)) throw new Error("图表目录数据无效，请重试");
      entry.value = catalog;
      return catalog;
    })();
  }
  if (entry.value) { state.catalog = entry.value; state.error = ""; renderReaderVisualCatalog(); return; }
  state.loading = true;
  state.error = "";
  renderReaderVisualCatalog();
  try {
    const catalog = await entry.promise;
    if (state.revision !== revision || state.snapshot !== snapshot || readerVisualCatalogSnapshot(getSelectedDocument()) !== snapshot) return;
    state.catalog = catalog;
  } catch (error) {
    if (readerVisualCatalogCache.get(snapshot) === entry) readerVisualCatalogCache.delete(snapshot);
    if (state.revision !== revision || state.snapshot !== snapshot) return;
    state.error = error.message || "图表目录加载失败，请重试";
  } finally {
    if (state.revision === revision && state.snapshot === snapshot) {
      state.loading = false;
      renderReaderVisualCatalog();
    }
  }
}

async function saveReaderBeforeVisualNavigation(item, page) {
  if (typeof readerEditing === "undefined" || !readerEditing) return true;
  const button = typeof editDocumentButton === "undefined" ? document.querySelector("#edit-document") : editDocumentButton;
  if (!button || button.disabled) return false;
  const expected = readerText.innerText.trim();
  button.click();
  // The existing save handler writes locally synchronously, then awaits flushPendingSync().
  // Also tolerate a parent save handler that completes its local work asynchronously.
  const deadline = Date.now() + 10000;
  while (readerEditing || getPagePrimaryText(page) !== expected) {
    if (getSelectedDocument()?.id !== item.id || getSelectedPage()?.id !== page.id || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (typeof flushPendingSync === "function") await flushPendingSync();
  if (typeof syncDirty !== "undefined" && syncDirty) return false;
  return !readerEditing && getSelectedDocument()?.id === item.id && getSelectedPage()?.id === page.id;
}

async function navigateReaderVisualCatalog(pageId, visualId) {
  const state = readerVisualCatalogState, item = getSelectedDocument();
  const entry = state.catalog?.items.find((row) => row.pageId === pageId && row.visualId === visualId);
  if (!item || state.documentId !== item.id || !entry) return false;
  const token = ++state.navigationRevision;
  try {
    const beforePage = getSelectedPage();
    if (!await saveReaderBeforeVisualNavigation(item, beforePage)) throw new Error("请先保存当前页的修改");
    if (getSelectedDocument()?.id !== item.id) return false;
    if (token !== state.navigationRevision) return false;
    const live = getSelectedDocument(), page = live.pages.find((p) => p.id === pageId);
    if (!page || entry.sourceRevision !== page.processingRevision) throw new Error("图表目录已更新，请重试");
    const contentKey = typeof getReaderContentKey === "function" ? getReaderContentKey(live, page) :
      JSON.stringify([page.id, page.processingRevision, getPagePrimaryText(page)]);
    selectedPageId = pageId;
    if (typeof syncSelectionToUrl === "function") syncSelectionToUrl();
    renderReader();
    const content = await loadReaderContent(live, page);
    const current = getSelectedDocument(), currentPage = getSelectedPage();
    if ((typeof readerEditing !== "undefined" && readerEditing) || token !== state.navigationRevision || current?.id !== live.id || currentPage?.id !== pageId ||
        (typeof getReaderContentKey === "function" ? getReaderContentKey(current, currentPage) :
          JSON.stringify([currentPage.id, currentPage.processingRevision, getPagePrimaryText(currentPage)])) !== contentKey) return false;
    if (!content || content.sourceRevision !== entry.sourceRevision || !Object.hasOwn(content.visuals || {}, visualId)) {
      throw new Error("该图表内容暂不可用，请重试");
    }
    renderReader();
    // Parent rendering normally consumes the cache. This fallback also makes the module usable before integration.
    if (typeof renderReaderContent === "function") {
      const index = typeof getCachedReaderIndex === "function" ? getCachedReaderIndex(current, currentPage) : null;
      if (!renderReaderContent(currentPage, content, index)) throw new Error("该图表内容暂不可用，请重试");
      if (typeof renderReaderVisualOverlay === "function") renderReaderVisualOverlay(currentPage, content);
    }
    setReaderVisualActive(visualId, { scrollImage: true, scrollText: true });
    state.error = "";
    renderReaderVisualCatalog();
    return true;
  } catch (error) {
    if (token === state.navigationRevision && getSelectedDocument()?.id === item.id) {
      state.error = error.message || "图表定位失败，请重试";
      renderReaderVisualCatalog();
    }
    return false;
  }
}
