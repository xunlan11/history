const READER_PANEL_STATE_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.readerPanels`;

function loadReaderPanelState() {
  try {
    const value = JSON.parse(localStorage.getItem(READER_PANEL_STATE_STORAGE_KEY)) || {};
    return {
      sidebarCollapsed: value.sidebarCollapsed === true,
      originalCollapsed: value.originalCollapsed === true,
      annotationCollapsed: value.annotationCollapsed === true,
    };
  } catch {
    return { sidebarCollapsed: false, originalCollapsed: false, annotationCollapsed: false };
  }
}

let readerPanelState = loadReaderPanelState();

function applyReaderPanelState() {
  const { sidebarCollapsed, originalCollapsed, annotationCollapsed } = readerPanelState;
  readerLayout?.classList.toggle("is-sidebar-collapsed", sidebarCollapsed);
  if (readerSidebarStack) readerSidebarStack.hidden = sidebarCollapsed;
  if (readerSidebarToggle) {
    const label = sidebarCollapsed ? "展开工具栏" : "折叠工具栏";
    readerSidebarToggle.setAttribute("aria-expanded", String(!sidebarCollapsed));
    readerSidebarToggle.setAttribute("aria-label", label);
  }
  readerCompare?.classList.toggle("is-original-collapsed", originalCollapsed);
  readerCompare?.classList.toggle("is-annotation-collapsed", annotationCollapsed);
  readerOriginalPanel?.classList.toggle("reader-panel-collapsed", originalCollapsed);
  readerAnnotationPanel?.classList.toggle("reader-panel-collapsed", annotationCollapsed);

  if (readerOriginalToggle) {
    readerOriginalToggle.setAttribute("aria-expanded", String(!originalCollapsed));
    readerOriginalToggle.setAttribute("aria-label", originalCollapsed ? "展开原始资料" : "折叠原始资料");
  }
  if (readerAnnotationToggle) {
    readerAnnotationToggle.setAttribute("aria-expanded", String(!annotationCollapsed));
    readerAnnotationToggle.setAttribute("aria-label", annotationCollapsed ? "展开笺注" : "折叠笺注");
  }
}

function toggleReaderPanel(panel) {
  if (panel === "sidebar") {
    readerPanelState.sidebarCollapsed = !readerPanelState.sidebarCollapsed;
  } else if (panel === "original") {
    readerPanelState.originalCollapsed = !readerPanelState.originalCollapsed;
  } else if (panel === "annotation") {
    readerPanelState.annotationCollapsed = !readerPanelState.annotationCollapsed;
  } else {
    return;
  }
  localStorage.setItem(READER_PANEL_STATE_STORAGE_KEY, JSON.stringify(readerPanelState));
  applyReaderPanelState();
}

readerSidebarToggle?.addEventListener("click", () => toggleReaderPanel("sidebar"));
readerOriginalToggle?.addEventListener("click", () => toggleReaderPanel("original"));
readerAnnotationToggle?.addEventListener("click", () => toggleReaderPanel("annotation"));
applyReaderPanelState();
const readerProgressCache = new Map();
const readerProgressSaveStates = new Map();
let readerProgressLoadRevision = 0;

function getReaderProgressKey(documentId) {
  const userId = typeof currentUser !== "undefined" ? currentUser?.id : "";
  return `${userId}\u0000${documentId}`;
}

function getReaderProgressUrl(documentId) {
  return `${DOCUMENT_ANNOTATION_API_URL}/${encodeURIComponent(documentId)}/reading-progress`;
}

function getReaderProgressLocalStorageKey(documentId) {
  const userId = typeof currentUser !== "undefined" ? currentUser?.id : "";
  return `${SITE_STORAGE_PREFIX}.readerProgress.user-${userId}.document-${documentId}`;
}

function loadCachedReaderProgress(documentId) {
  try {
    const value = JSON.parse(localStorage.getItem(getReaderProgressLocalStorageKey(documentId)) || "null");
    return value?.pageId ? value : null;
  } catch {
    return null;
  }
}

function cacheReaderProgress(documentId, progress) {
  if (!progress?.pageId) {
    return;
  }
  readerProgressCache.set(getReaderProgressKey(documentId), progress);
  localStorage.setItem(getReaderProgressLocalStorageKey(documentId), JSON.stringify(progress));
}

function getReaderProgressSaveState(key, documentId) {
  if (!readerProgressSaveStates.has(key)) {
    readerProgressSaveStates.set(key, {
      documentId,
      timer: null,
      inFlight: false,
      pendingPageId: null,
      inFlightPageId: null,
      lastSavedPageId: null,
    });
  }
  return readerProgressSaveStates.get(key);
}

function scheduleReaderProgressSave(state, key) {
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(() => flushReaderProgressSave(key), 150);
}

function recordReaderProgress(item, page) {
  if (document.body.dataset.page !== "reader" || !currentUser?.id || !item?.id || !page?.id) {
    return;
  }
  const key = getReaderProgressKey(item.id);
  const state = getReaderProgressSaveState(key, item.id);
  if (state.lastSavedPageId === page.id && !state.pendingPageId && state.inFlightPageId !== page.id) {
    return;
  }
  state.pendingPageId = page.id;
  cacheReaderProgress(item.id, { pageId: page.id, pageNumber: page.pageNumber, updatedAt: "" });
  scheduleReaderProgressSave(state, key);
}

async function flushReaderProgressSave(key) {
  const state = readerProgressSaveStates.get(key);
  if (!state || state.inFlight || !state.pendingPageId) {
    return false;
  }
  window.clearTimeout(state.timer);
  state.timer = null;
  const pageId = state.pendingPageId;
  state.pendingPageId = null;
  state.inFlight = true;
  state.inFlightPageId = pageId;
  try {
    const response = await fetch(getReaderProgressUrl(state.documentId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId }),
      keepalive: true,
    });
    if (!response.ok) {
      throw new Error(`Reader progress save failed: ${response.status}`);
    }
    const result = await response.json();
    state.lastSavedPageId = result.pageId || pageId;
    cacheReaderProgress(state.documentId, {
      pageId: state.lastSavedPageId,
      pageNumber: result.pageNumber,
      updatedAt: result.updatedAt || "",
    });
    return true;
  } catch {
    state.pendingPageId = state.pendingPageId || pageId;
    scheduleReaderProgressSave(state, key);
    return false;
  } finally {
    state.inFlight = false;
    state.inFlightPageId = null;
    if (state.pendingPageId && !state.timer) {
      scheduleReaderProgressSave(state, key);
    }
  }
}

async function initializeReaderProgress() {
  if (document.body.dataset.page !== "reader" || !currentUser?.id) {
    return;
  }
  const item = getSelectedDocument();
  if (!item) {
    return;
  }
  const params = new URL(window.location.href).searchParams;
  const explicitPageId = params.get("page");
  if (explicitPageId && item.pages.some((page) => page.id === explicitPageId)) {
    const key = getReaderProgressKey(item.id);
    const state = getReaderProgressSaveState(key, item.id);
    state.lastSavedPageId = null;
    cacheReaderProgress(item.id, { pageId: explicitPageId, updatedAt: "" });
    return;
  }

  const revision = ++readerProgressLoadRevision;
  const cached = readerProgressCache.get(getReaderProgressKey(item.id)) || loadCachedReaderProgress(item.id);
  let persistedPageId = null;
  try {
    const response = await fetch(getReaderProgressUrl(item.id));
    if (!response.ok) {
      throw new Error(`Reader progress load failed: ${response.status}`);
    }
    const result = await response.json();
    if (revision !== readerProgressLoadRevision) {
      return;
    }
    const savedPageById = item.pages.find((page) => page.id === result.pageId);
    const savedPage = savedPageById || item.pages.find((page) => Number(page.pageNumber) === Number(result.pageNumber));
    const fallbackPage = savedPage || (cached && item.pages.find((page) => page.id === cached.pageId));
    if (fallbackPage) {
      selectedPageId = fallbackPage.id;
    }
    if (savedPage) {
      cacheReaderProgress(item.id, { ...result, pageId: savedPage.id });
      if (savedPageById) {
        persistedPageId = savedPage.id;
      }
    }
  } catch {
    const fallbackPage = cached && item.pages.find((page) => page.id === cached.pageId);
    if (fallbackPage) {
      selectedPageId = fallbackPage.id;
    }
  }

  const key = getReaderProgressKey(item.id);
  const state = getReaderProgressSaveState(key, item.id);
  state.lastSavedPageId = persistedPageId;
}

window.addEventListener("pagehide", () => {
  readerProgressSaveStates.forEach((_, key) => flushReaderProgressSave(key));
});
window.addEventListener("online", () => {
  readerProgressSaveStates.forEach((_, key) => flushReaderProgressSave(key));
});

const readerAnnotationCache = new Map();
const readerAnnotationSaveStates = new Map();
let readerAnnotationLoadRevision = 0;

function getReaderAnnotationKey(documentId, pageId) {
  return `${documentId}\u0000${pageId}`;
}

function getReaderAnnotationUrl(documentId, pageId) {
  return `${DOCUMENT_ANNOTATION_API_URL}/${encodeURIComponent(documentId)}/pages/${encodeURIComponent(pageId)}/annotation`;
}

function setReaderAnnotationStatus(message) {
  if (readerAnnotationStatus) {
    readerAnnotationStatus.textContent = message;
  }
}

function getReaderAnnotationSaveState(key, documentId, pageId) {
  if (!readerAnnotationSaveStates.has(key)) {
    readerAnnotationSaveStates.set(key, {
      documentId,
      pageId,
      timer: null,
      inFlight: false,
      pendingContent: null,
    });
  }
  return readerAnnotationSaveStates.get(key);
}

function scheduleReaderAnnotationSave(documentId, pageId, content) {
  const key = getReaderAnnotationKey(documentId, pageId);
  const state = getReaderAnnotationSaveState(key, documentId, pageId);
  readerAnnotationCache.set(key, content);
  state.pendingContent = content;
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(() => flushReaderAnnotationSave(key), 500);
  setReaderAnnotationStatus("保存中");
}

async function flushReaderAnnotationSave(key) {
  const state = readerAnnotationSaveStates.get(key);
  if (!state || state.inFlight || state.pendingContent === null) {
    return;
  }

  window.clearTimeout(state.timer);
  state.timer = null;
  const content = state.pendingContent;
  state.pendingContent = null;
  state.inFlight = true;
  let failed = false;

  try {
    const response = await fetch(getReaderAnnotationUrl(state.documentId, state.pageId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      keepalive: true,
    });
    if (!response.ok) {
      throw new Error(`Annotation save failed: ${response.status}`);
    }
    const result = await response.json();
    if (state.pendingContent === null) {
      readerAnnotationCache.set(key, typeof result.content === "string" ? result.content : content);
    }
    if (
      readerAnnotation?.dataset.annotationKey === key &&
      state.pendingContent === null &&
      readerAnnotation.value === content
    ) {
      setReaderAnnotationStatus("已保存");
    }
  } catch {
    failed = true;
    if (state.pendingContent === null) {
      state.pendingContent = content;
    }
    if (readerAnnotation?.dataset.annotationKey === key) {
      setReaderAnnotationStatus("保存失败");
    }
  } finally {
    state.inFlight = false;
    if (!failed && state.pendingContent !== null) {
      flushReaderAnnotationSave(key);
    }
  }
}

async function renderReaderAnnotation(item, page) {
  if (!readerAnnotation) {
    return;
  }

  const previousKey = readerAnnotation.dataset.annotationKey || "";
  if (!item || !page) {
    if (previousKey) {
      flushReaderAnnotationSave(previousKey);
    }
    readerAnnotationLoadRevision += 1;
    readerAnnotation.dataset.annotationKey = "";
    readerAnnotation.dataset.documentId = "";
    readerAnnotation.dataset.pageId = "";
    readerAnnotation.value = "";
    readerAnnotation.disabled = true;
    setReaderAnnotationStatus("");
    return;
  }

  const key = getReaderAnnotationKey(item.id, page.id);
  if (previousKey === key) {
    return;
  }
  if (previousKey) {
    flushReaderAnnotationSave(previousKey);
  }

  const revision = ++readerAnnotationLoadRevision;
  readerAnnotation.dataset.annotationKey = key;
  readerAnnotation.dataset.documentId = item.id;
  readerAnnotation.dataset.pageId = page.id;

  if (readerAnnotationCache.has(key)) {
    readerAnnotation.value = readerAnnotationCache.get(key);
    readerAnnotation.disabled = false;
    const state = readerAnnotationSaveStates.get(key);
    setReaderAnnotationStatus(state && state.pendingContent !== null ? "保存中" : "已保存");
    return;
  }

  readerAnnotation.value = "";
  readerAnnotation.disabled = true;
  setReaderAnnotationStatus("加载中");

  try {
    const response = await fetch(getReaderAnnotationUrl(item.id, page.id));
    if (!response.ok) {
      throw new Error(`Annotation load failed: ${response.status}`);
    }
    const result = await response.json();
    if (revision !== readerAnnotationLoadRevision || readerAnnotation.dataset.annotationKey !== key) {
      return;
    }
    const content = typeof result.content === "string" ? result.content : "";
    readerAnnotationCache.set(key, content);
    readerAnnotation.value = content;
    readerAnnotation.disabled = false;
    setReaderAnnotationStatus(content ? "已保存" : "");
  } catch {
    if (revision !== readerAnnotationLoadRevision || readerAnnotation.dataset.annotationKey !== key) {
      return;
    }
    readerAnnotation.disabled = false;
    setReaderAnnotationStatus("加载失败");
  }
}

readerAnnotation?.addEventListener("input", () => {
  const documentId = readerAnnotation.dataset.documentId;
  const pageId = readerAnnotation.dataset.pageId;
  if (!documentId || !pageId) {
    return;
  }
  scheduleReaderAnnotationSave(documentId, pageId, readerAnnotation.value);
});

readerAnnotation?.addEventListener("blur", () => {
  const key = readerAnnotation.dataset.annotationKey;
  if (key) {
    flushReaderAnnotationSave(key);
  }
});

window.addEventListener("pagehide", () => {
  readerAnnotationSaveStates.forEach((_, key) => flushReaderAnnotationSave(key));
});


// 大型索引只缓存在内存；键包含正文，防止相同处理版本下的编辑复用旧坐标。
const readerIndexCache = new Map();
let readerLinkRenderRevision = 0;
let readerLinkSelectionTimer = null;
let readerEditingPageKey = "";

function getReaderIndexUrl(documentId, pageId) {
  return DATA_PROCESSING_URL + "/" + encodeURIComponent(documentId) + "/pages/" + encodeURIComponent(pageId) + "/reader-index";
}

function getReaderIndexKey(item, page) {
  return JSON.stringify([currentUser?.id || "", item.id, page.id, page.processingRevision,
    page.readerIndexStatus, page.readerIndexRevision, page.readerIndexUpdatedAt,
    page.readerIndexTextHash, getPageImageSource(page), getPagePrimaryText(page)]);
}

function isReaderIndexEligible(page) {
  return Boolean(page?.proofreadingDone && page.readerIndexStatus === "ready" &&
    page.readerIndexRevision === page.processingRevision);
}

function isReaderIndexValid(index, page) {
  if (!index || index.status !== "ready" || index.sourceRevision !== page.processingRevision ||
      index.displayedText !== getPagePrimaryText(page) || !(index.imageWidth > 0) || !(index.imageHeight > 0) ||
      !Array.isArray(index.sentences)) return false;
  // 检查偏移与文本，任何不完整索引都退回普通阅读，不丢字或重复渲染。
  let offset = 0;
  for (const sentence of index.sentences) {
    if (!sentence.id || sentence.start !== offset || sentence.end <= offset ||
        index.displayedText.slice(offset, sentence.end) !== sentence.text || !Array.isArray(sentence.boxes)) return false;
    offset = sentence.end;
  }
  return offset === index.displayedText.length;
}

function getCachedReaderIndex(item, page) {
  if (!isReaderIndexEligible(page)) return null;
  const value = readerIndexCache.get(getReaderIndexKey(item, page))?.value;
  return isReaderIndexValid(value, page) ? value : null;
}

async function loadReaderIndex(documentId, pageId) {
  const item = documents.find((entry) => entry.id === documentId);
  const page = item?.pages.find((entry) => entry.id === pageId);
  if (!isReaderIndexEligible(page)) return null;
  const key = getReaderIndexKey(item, page);
  if (readerIndexCache.has(key)) {
    const entry = readerIndexCache.get(key);
    return entry.promise || entry.value;
  }
  const entry = { value: null, promise: null };
  readerIndexCache.set(key, entry);
  while (readerIndexCache.size > 12) readerIndexCache.delete(readerIndexCache.keys().next().value);
  entry.promise = (async () => {
    try {
      const response = await fetch(getReaderIndexUrl(documentId, pageId), { cache: "no-store" });
      if (!response.ok) return null;
      const index = await response.json();
      if (getReaderIndexKey(item, page) !== key || !isReaderIndexValid(index, page)) return null;
      entry.value = index;
      return index;
    } catch {
      return null;
    } finally {
      entry.promise = null;
    }
  })();
  return entry.promise;
}

function resetReaderLink() {
  readerLinkRenderRevision += 1;
  window.clearTimeout(readerLinkSelectionTimer);
  setReaderLinkActive(null);
  return readerLinkRenderRevision;
}

function markReaderIndexStale(documentId, pageId) {
  const page = documents.find((item) => item.id === documentId)?.pages.find((entry) => entry.id === pageId);
  if (page?.readerIndexStatus) page.readerIndexStatus = "stale";
  resetReaderLink();
}

function scrollReaderRegionIntoView(element, container) {
  if (!element || !container || container.clientHeight === 0) return;
  const box = element.getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  if (box.top < viewport.top || box.bottom > viewport.bottom) {
    container.scrollTop += box.top - viewport.top - (container.clientHeight - box.height) / 2;
  }
}

function setReaderLinkActive(sentenceId, options = {}) {
  const textNodes = readerText?.querySelectorAll("[data-sentence-id]") || [];
  const imageNodes = readerOriginalPreview?.querySelectorAll("[data-sentence-id]") || [];
  let activeText = null;
  let activeRegion = null;
  for (const node of [...textNodes, ...imageNodes]) {
    const active = Boolean(sentenceId && node.dataset.sentenceId === sentenceId && !readerEditing);
    node.classList.toggle("is-active", active);
    node.classList.toggle("is-selected", active && options.selected === true);
    if (active && node.classList.contains("reader-sentence")) activeText = node;
    if (active && !activeRegion && node.classList.contains("reader-image-region")) activeRegion = node;
  }
  if (options.scrollText) scrollReaderRegionIntoView(activeText, readerText);
  if (options.scrollImage) scrollReaderRegionIntoView(activeRegion, readerOriginalPreview);
}

function activateReaderImageSentence(sentenceId) {
  window.clearTimeout(readerLinkSelectionTimer);
  setReaderLinkActive(sentenceId, { scrollText: true, selected: true });
  readerLinkSelectionTimer = window.setTimeout(() => setReaderLinkActive(null), 1800);
}

function bindReaderLinkEvents(container, imageSide = false) {
  if (!container) return;
  const sentenceFor = (target) => target?.closest?.("[data-sentence-id]");
  const activate = (event) => {
    const node = sentenceFor(event.target);
    if (node && !readerEditing) {
      window.clearTimeout(readerLinkSelectionTimer);
      setReaderLinkActive(node.dataset.sentenceId, { scrollImage: !imageSide });
    }
  };
  const deactivate = (event) => {
    if (!sentenceFor(event.target)) return;
    const related = sentenceFor(event.relatedTarget);
    if (related && container.contains(related)) {
      setReaderLinkActive(related.dataset.sentenceId);
      return;
    }
    const focused = sentenceFor(document.activeElement);
    if (event.type === "pointerout" && focused && container.contains(focused)) {
      setReaderLinkActive(focused.dataset.sentenceId);
    } else {
      setReaderLinkActive(null);
    }
  };
  container.addEventListener("pointerover", activate);
  container.addEventListener("focusin", activate);
  container.addEventListener("pointerout", deactivate);
  container.addEventListener("focusout", deactivate);
  if (imageSide) {
    container.addEventListener("click", (event) => {
      const node = sentenceFor(event.target);
      if (node && !readerEditing) activateReaderImageSentence(node.dataset.sentenceId);
    });
    container.addEventListener("keydown", (event) => {
      const node = sentenceFor(event.target);
      if (node && !readerEditing && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        activateReaderImageSentence(node.dataset.sentenceId);
      }
    });
  }
}

bindReaderLinkEvents(readerText);
bindReaderLinkEvents(readerOriginalPreview, true);


function createReaderImageOverlay(index, image) {
  const namespace = "http://www.w3.org/2000/svg";
  const overlay = document.createElementNS(namespace, "svg");
  overlay.classList.add("reader-image-overlay");
  overlay.setAttribute("viewBox", "0 0 " + index.imageWidth + " " + index.imageHeight);
  overlay.setAttribute("aria-label", "原文句子定位");
  overlay.style.visibility = "hidden";
  for (const sentence of index.sentences) {
    if (!["exact", "fuzzy"].includes(sentence.confidence)) continue;
    for (const box of sentence.boxes) {
      const bounds = box.bbox;
      if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) continue;
      const [x1, y1, x2, y2] = bounds;
      if (x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1 || x2 > index.imageWidth || y2 > index.imageHeight) continue;
      const polygon = box.polygon;
      const usePolygon = Array.isArray(polygon) && polygon.length >= 3 &&
        polygon.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
      const region = document.createElementNS(namespace, usePolygon ? "polygon" : "rect");
      if (usePolygon) {
        region.setAttribute("points", polygon.map((point) => point.join(",")).join(" "));
      } else {
        region.setAttribute("x", x1);
        region.setAttribute("y", y1);
        region.setAttribute("width", x2 - x1);
        region.setAttribute("height", y2 - y1);
      }
      region.classList.add("reader-image-region");
      region.dataset.sentenceId = sentence.id;
      region.setAttribute("tabindex", "0");
      region.setAttribute("role", "button");
      region.setAttribute("aria-label", "定位整理文本：" + sentence.text.trim());
      overlay.append(region);
    }
  }
  const show = () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const expected = index.imageWidth / index.imageHeight;
    const actual = image.naturalWidth / image.naturalHeight;
    if (Math.abs(expected / actual - 1) < 0.01) overlay.style.visibility = "visible";
  };
  image.addEventListener("load", show, { once: true });
  image.addEventListener("error", () => overlay.remove(), { once: true });
  if (image.complete) show();
  return overlay;
}
