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
