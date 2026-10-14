const READER_PANEL_STATE_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.readerPanels`;

function loadReaderPanelState() {
  try {
    const value = JSON.parse(localStorage.getItem(READER_PANEL_STATE_STORAGE_KEY)) || {};
    return {
      originalCollapsed: value.originalCollapsed === true,
      annotationCollapsed: value.annotationCollapsed === true,
    };
  } catch {
    return { originalCollapsed: false, annotationCollapsed: false };
  }
}

let readerPanelState = loadReaderPanelState();

function applyReaderPanelState() {
  const { originalCollapsed, annotationCollapsed } = readerPanelState;
  readerCompare?.classList.toggle("is-original-collapsed", originalCollapsed);
  readerCompare?.classList.toggle("is-annotation-collapsed", annotationCollapsed);
  readerOriginalPanel?.classList.toggle("reader-panel-collapsed", originalCollapsed);
  readerAnnotationPanel?.classList.toggle("reader-panel-collapsed", annotationCollapsed);

  if (readerOriginalToggle) {
    readerOriginalToggle.setAttribute("aria-expanded", String(!originalCollapsed));
    readerOriginalToggle.setAttribute("aria-label", originalCollapsed ? "展开原始资料" : "折叠原始资料");
    readerOriginalToggle.title = originalCollapsed ? "展开原始资料" : "折叠原始资料";
  }
  if (readerAnnotationToggle) {
    readerAnnotationToggle.setAttribute("aria-expanded", String(!annotationCollapsed));
    readerAnnotationToggle.setAttribute("aria-label", annotationCollapsed ? "展开笺注" : "折叠笺注");
    readerAnnotationToggle.title = annotationCollapsed ? "展开笺注" : "折叠笺注";
  }
}

function toggleReaderPanel(panel) {
  if (panel === "original") {
    readerPanelState.originalCollapsed = !readerPanelState.originalCollapsed;
  } else if (panel === "annotation") {
    readerPanelState.annotationCollapsed = !readerPanelState.annotationCollapsed;
  } else {
    return;
  }
  localStorage.setItem(READER_PANEL_STATE_STORAGE_KEY, JSON.stringify(readerPanelState));
  applyReaderPanelState();
}

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
