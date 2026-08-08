const DOCUMENT_COVER_VARIANT_COUNT = 6;
const CONVERSATION_STORAGE_KEY = "modernMilitaryHistory.conversations.v1";
const CLIENT_ID_STORAGE_KEY = "modernMilitaryHistory.clientId.v1";
const SYNC_CURSOR_STORAGE_KEY = "modernMilitaryHistory.syncCursor.v1";
const DELETED_DOCUMENT_IDS_STORAGE_KEY = "modernMilitaryHistory.deletedDocuments.v1";
const DELETED_CONVERSATION_IDS_STORAGE_KEY = "modernMilitaryHistory.deletedConversations.v1";
const SYNC_INTERVAL_MS = 30000;

let documents = normalizeDocuments(loadCachedDocuments());
let selectedDocumentId = documents[0]?.id || null;
let selectedPageId = documents[0]?.pages?.[0]?.id || null;
let conversations = loadCachedConversations();
let selectedConversationId = conversations[0]?.id || null;
let syncCursor = localStorage.getItem(SYNC_CURSOR_STORAGE_KEY) || "";
let syncReady = false;
let syncDirty = false;
let syncPushTimer = null;
let syncPushInFlight = null;
let syncPullInFlight = null;
let syncRevision = 0;
let deletedDocumentIds = loadCachedIdSet(DELETED_DOCUMENT_IDS_STORAGE_KEY);
let deletedConversationIds = loadCachedIdSet(DELETED_CONVERSATION_IDS_STORAGE_KEY);

function loadCachedDocuments() {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    return JSON.parse(current || legacy) || [];
  } catch {
    return [];
  }
}

function normalizeDocuments(items) {
  return items.map((item, index) => {
    const pages = Array.isArray(item.pages) && item.pages.length
      ? item.pages
      : [createPage(1, { cleanText: item.ocrText || "" })];

    const normalized = {
      ...item,
      title: item.title || "",
      author: item.author || "",
      year: item.year || "",
      publisher: item.publisher || "",
      rights: item.rights || "",
      source: item.source || "",
      tags: item.tags || "",
      metadataStatus: item.metadataStatus || "待自动识别",
      coverImageDataUrl: item.coverImageDataUrl || "",
      coverVariant: normalizeCoverVariant(item.coverVariant, index),
      coverStatus: item.coverStatus || "待识别封面",
      processMode: item.processMode || "online",
      offlineTask: item.offlineTask || null,
      pages: pages
        .map((page, index) => ({
          id: page.id || newId(),
          pageNumber: Number(page.pageNumber) || index + 1,
          ocrText: page.ocrText || page.rawText || "",
          cleanText: page.cleanText || page.text || "",
          punctuatedText: page.punctuatedText || page.readingText || "",
          text: page.cleanText || page.text || "",
          notes: page.notes || "",
          status: page.status || (hasPageText(page) ? "已保存文字" : "待整理"),
          imageDataUrl: page.imageDataUrl || "",
          imageUrl: page.imageUrl || "",
          imageName: page.imageName || "",
          ocr: page.ocr || null,
          updatedAt: page.updatedAt || item.updatedAt || item.createdAt || "",
        }))
        .sort((a, b) => a.pageNumber - b.pageNumber),
    };

    delete normalized.ocrText;
    normalized.status = summarizeDocumentStatus(normalized);
    return normalized;
  });
}

function loadCachedIdSet(key) {
  try {
    const values = JSON.parse(localStorage.getItem(key)) || [];
    return new Set(values.map((value) => String(value)).filter(Boolean));
  } catch {
    return new Set();
  }
}

function normalizeCoverVariant(value, fallbackIndex = 0) {
  const variant = Number(value);

  if (
    Number.isInteger(variant) &&
    variant >= 0 &&
    variant < DOCUMENT_COVER_VARIANT_COUNT
  ) {
    return variant;
  }

  return Math.abs(fallbackIndex) % DOCUMENT_COVER_VARIANT_COUNT;
}

function getNextDocumentCoverVariant() {
  return documents.length % DOCUMENT_COVER_VARIANT_COUNT;
}

function persist() {
  persistDocumentsCache();
  scheduleServerPush();
}

function persistDocumentsCache() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
}

function loadCachedConversations() {
  try {
    const items = JSON.parse(localStorage.getItem(CONVERSATION_STORAGE_KEY)) || [];
    return normalizeConversations(items);
  } catch {
    return [];
  }
}

function persistConversations() {
  persistConversationsCache();
  scheduleServerPush();
}

function persistConversationsCache() {
  localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(conversations));
}

function getClientId() {
  let clientId = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (!clientId) {
    clientId = newId();
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
  }
  return clientId;
}

function hasLocalCacheData() {
  return documents.length > 0 || conversations.length > 0;
}

function cacheCurrentState() {
  persistDocumentsCache();
  persistConversationsCache();
  persistDeletedIdCache();
}

function persistDeletedIdCache() {
  localStorage.setItem(DELETED_DOCUMENT_IDS_STORAGE_KEY, JSON.stringify(Array.from(deletedDocumentIds)));
  localStorage.setItem(DELETED_CONVERSATION_IDS_STORAGE_KEY, JSON.stringify(Array.from(deletedConversationIds)));
}

function applyServerState(payload) {
  const nextDocuments = normalizeDocuments(payload.documents || []);
  const nextConversations = normalizeConversations(payload.conversations || []);

  documents = nextDocuments;
  conversations = nextConversations;

  selectedDocumentId = documents.some((item) => item.id === selectedDocumentId)
    ? selectedDocumentId
    : documents[0]?.id || null;

  const selectedDocument = getSelectedDocument();
  selectedPageId = selectedDocument?.pages?.some((page) => page.id === selectedPageId)
    ? selectedPageId
    : selectedDocument?.pages?.[0]?.id || null;

  selectedConversationId = conversations.some((item) => item.id === selectedConversationId)
    ? selectedConversationId
    : conversations[0]?.id || null;

  syncCursor = String(payload.syncCursor || "");
  localStorage.setItem(SYNC_CURSOR_STORAGE_KEY, syncCursor);
  cacheCurrentState();
}

function normalizeConversations(items) {
  return items.map((item) => {
    const fallbackDate = item.updatedAt || item.createdAt || new Date().toISOString();
    return {
      ...item,
      mode: item.mode || "chat",
      locked: Boolean(item.locked || (item.title && item.title !== "新对话")),
      createdAt: item.createdAt || fallbackDate,
      updatedAt: item.updatedAt || fallbackDate,
    };
  });
}

async function initializeServerData() {
  const localHadData = hasLocalCacheData();

  try {
    const response = await fetch(DATA_BOOTSTRAP_URL);
    if (!response.ok) {
      throw new Error(`Bootstrap failed: ${response.status}`);
    }

    const payload = await response.json();
    const serverHasData = (payload.documents || []).length > 0 || (payload.conversations || []).length > 0;

    syncReady = true;
    if (syncDirty) {
      await pushServerSnapshot();
      return true;
    }

    if (serverHasData || !localHadData) {
      applyServerState(payload);
      syncDirty = false;
      return true;
    }

    await pushServerSnapshot();
    return true;
  } catch (error) {
    syncReady = false;
    return false;
  }
}

function scheduleServerPush() {
  syncDirty = true;
  syncRevision += 1;
  persistDeletedIdCache();

  if (!syncReady) {
    return;
  }

  window.clearTimeout(syncPushTimer);
  syncPushTimer = window.setTimeout(() => {
    pushServerSnapshot();
  }, 600);
}

async function pushServerSnapshot() {
  if (!syncReady) {
    return false;
  }

  if (syncPushInFlight) {
    return syncPushInFlight;
  }

  const pushedRevision = syncRevision;
  const payload = {
    clientId: getClientId(),
    documents,
    conversations,
    deletedDocumentIds: Array.from(deletedDocumentIds),
    deletedConversationIds: Array.from(deletedConversationIds),
  };

  syncPushInFlight = fetch(DATA_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Push failed: ${response.status}`);
      }

      const result = await response.json();
      syncCursor = String(result.syncCursor || syncCursor);
      localStorage.setItem(SYNC_CURSOR_STORAGE_KEY, syncCursor);

      if (syncRevision === pushedRevision) {
        syncDirty = false;
        deletedDocumentIds.clear();
        deletedConversationIds.clear();
        cacheCurrentState();
      } else {
        scheduleServerPush();
      }

      return true;
    })
    .catch(() => false)
    .finally(() => {
      syncPushInFlight = null;
    });

  return syncPushInFlight;
}

async function syncFromServer(options = {}) {
  if (!syncReady || syncDirty || syncPullInFlight) {
    return false;
  }

  const url = `${DATA_SYNC_URL}?cursor=${encodeURIComponent(syncCursor)}`;
  syncPullInFlight = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Sync failed: ${response.status}`);
      }

      const payload = await response.json();
      if (payload.changed === false) {
        syncCursor = String(payload.syncCursor || syncCursor);
        localStorage.setItem(SYNC_CURSOR_STORAGE_KEY, syncCursor);
        return false;
      }

      applyServerState(payload);
      if (options.render && typeof renderAll === "function") {
        renderAll();
        renderSmartModeButtons();
      }
      return true;
    })
    .catch(() => false)
    .finally(() => {
      syncPullInFlight = null;
    });

  return syncPullInFlight;
}

function startPeriodicSync() {
  const syncTick = async () => {
    if (!syncReady) {
      const connected = await initializeServerData();
      if (connected && typeof renderAll === "function") {
        renderAll();
        renderSmartModeButtons();
      }
      return;
    }

    syncFromServer({ render: true });
  };

  window.setInterval(() => {
    syncTick();
  }, SYNC_INTERVAL_MS);

  window.addEventListener("focus", () => {
    syncTick();
  });
}

function getSelectedConversation() {
  return conversations.find((item) => item.id === selectedConversationId) || null;
}

function createConversation(title = "新对话", mode = "chat") {
  const conversation = {
    id: newId(),
    title,
    mode,
    locked: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  conversations.unshift(conversation);
  selectedConversationId = conversation.id;
  persistConversations();
  return conversation;
}

function upsertConversationFromPrompt(prompt, mode) {
  const title = prompt || "新对话";
  let conversation = getSelectedConversation();

  if (!conversation) {
    conversation = createConversation(title, mode);
  } else {
    conversation.title = title;
    conversation.mode = mode;
    conversation.locked = true;
    conversation.updatedAt = new Date().toISOString();
    conversations = [
      conversation,
      ...conversations.filter((item) => item.id !== conversation.id),
    ];
    selectedConversationId = conversation.id;
    persistConversations();
  }

  return conversation;
}

function setDraftConversationMode(mode) {
  const conversation = getSelectedConversation();

  if (!conversation || conversation.locked) {
    return false;
  }

  conversation.mode = mode;
  conversation.updatedAt = new Date().toISOString();
  persistConversations();
  return true;
}

function deleteConversation(id) {
  const index = conversations.findIndex((item) => item.id === id);

  if (index === -1) {
    return;
  }

  conversations.splice(index, 1);
  deletedConversationIds.add(id);

  if (selectedConversationId === id) {
    selectedConversationId = conversations[index]?.id || conversations[index - 1]?.id || null;
  }

  persistConversations();
}

function deleteDocument(id) {
  const index = documents.findIndex((item) => item.id === id);

  if (index === -1) {
    return;
  }

  documents.splice(index, 1);
  deletedDocumentIds.add(id);

  if (selectedDocumentId === id) {
    const nextDocument = documents[index] || documents[index - 1] || null;
    selectedDocumentId = nextDocument?.id || null;
    selectedPageId = nextDocument?.pages?.[0]?.id || null;
  }

  persist();
}

function getDocumentDisplayTitle(item) {
  return item?.title || item?.fileName || "未命名文献";
}

function createPage(pageNumber, textLayers = "") {
  const layers = typeof textLayers === "string"
    ? { cleanText: textLayers }
    : textLayers || {};
  const initialText = layers.cleanText || layers.ocrText || layers.punctuatedText || "";

  return {
    id: newId(),
    pageNumber,
    ocrText: layers.ocrText || "",
    cleanText: layers.cleanText || "",
    punctuatedText: layers.punctuatedText || "",
    text: layers.cleanText || "",
    notes: "",
    status: initialText ? "已保存文字" : "待整理",
    imageDataUrl: "",
    imageUrl: "",
    imageName: "",
    ocr: null,
    updatedAt: "",
  };
}

function getSelectedDocument() {
  return documents.find((item) => item.id === selectedDocumentId) || null;
}

function getSelectedPage() {
  const item = getSelectedDocument();
  if (!item) {
    return null;
  }

  return item.pages.find((page) => page.id === selectedPageId) || item.pages[0] || null;
}

function ensureSelectedPage(item) {
  if (!item.pages.length) {
    const page = createPage(1);
    item.pages.push(page);
    selectedPageId = page.id;
  }

  if (!item.pages.some((page) => page.id === selectedPageId)) {
    selectedPageId = item.pages[0].id;
  }
}

function nextPageNumber(item) {
  return Math.max(0, ...item.pages.map((page) => page.pageNumber)) + 1;
}

function saveCurrentPage(statusOverride) {
  const item = getSelectedDocument();
  const page = getSelectedPage();
  if (!item || !page) {
    return false;
  }

  page.ocrText = ocrRawText.value.trim();
  page.cleanText = cleanText.value.trim();
  page.punctuatedText = punctuatedText.value.trim();
  page.text = page.cleanText;
  page.notes = pageNotes.value.trim();
  page.status = statusOverride || (hasPageText(page) ? "已保存文字" : "待整理");
  page.updatedAt = new Date().toISOString();
  item.status = summarizeDocumentStatus(item);
  item.updatedAt = new Date().toISOString();
  persist();
  return true;
}

function moveToAdjacentPage(direction, options = {}) {
  const item = getSelectedDocument();
  if (!item) {
    return;
  }

  ensureSelectedPage(item);
  const pages = item.pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
  const currentIndex = Math.max(0, pages.findIndex((page) => page.id === selectedPageId));
  const nextIndex = currentIndex + direction;

  if (pages[nextIndex]) {
    selectedPageId = pages[nextIndex].id;
    renderAll();
    return;
  }

  if (direction > 0 && options.createIfMissing) {
    const page = createPage(nextPageNumber(item));
    item.pages.push(page);
    item.pages.sort((a, b) => a.pageNumber - b.pageNumber);
    selectedPageId = page.id;
    item.status = summarizeDocumentStatus(item);
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
    return;
  }

  renderAll();
}

function summarizeDocumentStatus(item) {
  if (!item.pages.length || item.pages.every((page) => !hasPageText(page))) {
    return "待整理";
  }

  if (item.pages.some((page) => page.status === "待核对")) {
    return "有文字待核对";
  }

  if (item.pages.some((page) => hasPageText(page))) {
    return "已保存文字";
  }

  return "待整理";
}

function hasPageText(page) {
  return Boolean(page.ocrText || page.cleanText || page.punctuatedText || page.text);
}

function getPagePrimaryText(page) {
  return page?.punctuatedText || page?.cleanText || page?.ocrText || page?.text || "";
}

function getPageSearchText(page) {
  return [
    page?.ocrText,
    page?.cleanText,
    page?.punctuatedText,
    page?.text,
    page?.notes,
  ].filter(Boolean).join("\n");
}

function createOfflineTask(file) {
  return {
    id: newId(),
    status: "提交中",
    createdAt: new Date().toISOString(),
    submittedAt: "",
    finishedAt: "",
    remoteTaskId: "",
    totalPages: 0,
    sourceFileName: file.name,
    serviceUrl: OCR_BATCH_SERVICE_URL,
    message: "正在提交给本机整本处理服务",
  };
}

function getOfflineTaskLabel(item) {
  if (item.processMode !== "offline") {
    return "不适用";
  }

  return item.offlineTask?.status || "等待处理";
}

function getProcessModeHelp(item) {
  if (item.processMode === "offline") {
    return "导入后由本机整本处理服务统一识别，完成后再进入逐页核对。";
  }

  return "在整理工作台中逐页选择原图，并逐页自动识别、核对。";
}

function applyBatchPages(item, pages) {
  item.pages = pages
    .map((page, index) => normalizeBatchPage(page, index))
    .sort((a, b) => a.pageNumber - b.pageNumber);
  selectedPageId = item.pages[0]?.id || null;
}

function normalizeBatchPage(page, index) {
  const text = page.ocrText || page.text || "";
  const warnings = Array.isArray(page.warnings) ? page.warnings : [];
  const notes = [
    page.notes || "",
    typeof page.confidence === "number" ? `自动识别置信度：${Math.round(page.confidence * 100)}%。` : "",
    warnings.length ? `识别提示：${warnings.join("；")}` : "",
    "本页由离线整本处理生成，需对照原图逐字核对。",
  ].filter(Boolean).join("\n");

  return {
    id: page.id || newId(),
    pageNumber: Number(page.pageNumber) || index + 1,
    ocrText: text,
    cleanText: page.cleanText || "",
    punctuatedText: page.punctuatedText || "",
    text: page.cleanText || "",
    notes,
    status: page.status || (text ? "待核对" : "待整理"),
    imageDataUrl: page.imageDataUrl || "",
    imageUrl: page.imageUrl || "",
    imageName: page.imageName || `第 ${Number(page.pageNumber) || index + 1} 页`,
    ocr: {
      confidence: page.confidence ?? null,
      engine: page.engine || "本机整本处理服务",
      recognizedAt: page.recognizedAt || new Date().toISOString(),
    },
    updatedAt: page.updatedAt || new Date().toISOString(),
  };
}

function buildOcrNote(result) {
  const notes = [];

  if (typeof result.confidence === "number") {
    notes.push(`自动识别置信度：${Math.round(result.confidence * 100)}%。`);
  }

  if (Array.isArray(result.warnings) && result.warnings.length) {
    notes.push(`识别提示：${result.warnings.join("；")}`);
  }

  notes.push("本页文字由自动识别生成，需对照原图逐字核对。");
  return notes.join("\n");
}

function mergeNotes(existing, addition) {
  if (!existing) {
    return addition;
  }

  if (!addition) {
    return existing;
  }

  return `${existing}\n\n${addition}`;
}
