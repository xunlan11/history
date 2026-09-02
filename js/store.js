const DOCUMENT_COVER_VARIANT_COUNT = 6;
const CONVERSATION_STORAGE_KEY = "modernMilitaryHistory.conversations.schema4";
const CLIENT_ID_STORAGE_KEY = "modernMilitaryHistory.clientId.schema4";
const SYNC_CURSOR_STORAGE_KEY = "modernMilitaryHistory.syncCursor.schema4";
const DELETED_DOCUMENT_IDS_STORAGE_KEY = "modernMilitaryHistory.deletedDocuments.schema4";
const DELETED_CONVERSATION_IDS_STORAGE_KEY = "modernMilitaryHistory.deletedConversations.schema4";
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
    const items = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function normalizeDocuments(items) {
  return items
    .filter((item) => item?.id && Array.isArray(item.pages))
    .map((item, index) => {
      const normalized = {
        id: item.id,
        title: item.title || "",
        author: item.author || "",
        year: item.year || "",
        publisher: item.publisher || "",
        tags: item.tags || "",
        fileName: item.fileName || "",
        fileType: item.fileType || "unknown",
        fileSize: Number(item.fileSize) || 0,
        filePath: item.filePath || "",
        fileUrl: item.fileUrl || "",
        fileHash: item.fileHash || "",
        fileMimeType: item.fileMimeType || "",
        sourceFile: item.sourceFile || null,
        metadataStatus: item.metadataStatus || "待自动识别",
        coverImageDataUrl: item.coverImageDataUrl || "",
        coverImageUrl: item.coverImageUrl || "",
        coverImageFile: item.coverImageFile || null,
        coverVariant: normalizeCoverVariant(item.coverVariant, index),
        coverStatus: item.coverStatus || "待识别封面",
        processingTask: normalizeProcessingTask(item.processingTask),
        createdAt: item.createdAt || "",
        updatedAt: item.updatedAt || "",
        status: item.status || "待整理",
        pages: item.pages
          .filter((page) => page?.id)
          .map((page) => ({
            id: page.id,
            pageNumber: Number(page.pageNumber),
            ocrText: page.ocrText || "",
            cleanText: page.cleanText || "",
            punctuatedText: page.punctuatedText || "",
            notes: page.notes || "",
            status: page.status || "待整理",
            imageDataUrl: page.imageDataUrl || "",
            imageUrl: page.imageUrl || "",
            imageName: page.imageName || "",
            imageFile: page.imageFile || null,
            imageHash: page.imageHash || "",
            imageMimeType: page.imageMimeType || "",
            imageSize: Number(page.imageSize) || 0,
            ocr: page.ocr || null,
            updatedAt: page.updatedAt || "",
          }))
          .sort((a, b) => a.pageNumber - b.pageNumber),
      };

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
  if (payload.schemaVersion !== DATA_SCHEMA_VERSION) {
    throw new Error(`Data schema mismatch: expected ${DATA_SCHEMA_VERSION}, received ${payload.schemaVersion}`);
  }

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
  return items
    .filter((item) => item?.id)
    .map((item) => ({
      id: item.id,
      title: item.title || "新对话",
      mode: item.mode || "chat",
      locked: Boolean(item.locked),
      referenceDocumentIds: normalizeReferenceDocumentIds(item.referenceDocumentIds),
      attachments: normalizeConversationAttachments(item.attachments),
      createdAt: item.createdAt || "",
      updatedAt: item.updatedAt || "",
    }));
}

function normalizeReferenceDocumentIds(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean)));
}

function normalizeConversationAttachments(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set();
  return values
    .filter((item) => item?.id && !seen.has(item.id) && seen.add(item.id))
    .map((item) => ({
      id: String(item.id),
      fileName: item.fileName || "未命名文件",
      fileType: item.fileType || "application/octet-stream",
      fileSize: Number(item.fileSize) || 0,
      fileUrl: item.fileUrl || "",
      filePath: item.filePath || "",
      fileHash: item.fileHash || "",
      kind: item.kind || "document",
      extractedText: String(item.extractedText || "").slice(0, 60000),
      status: item.status || "uploading",
      warnings: Array.isArray(item.warnings) ? item.warnings.map(String).filter(Boolean) : [],
      createdAt: item.createdAt || "",
      updatedAt: item.updatedAt || "",
    }));
}

async function initializeServerData() {
  try {
    const response = await fetch(DATA_BOOTSTRAP_URL);
    if (!response.ok) {
      throw new Error(`Bootstrap failed: ${response.status}`);
    }

    const payload = await response.json();
    syncReady = true;
    if (syncDirty) {
      await pushServerSnapshot();
      return true;
    }

    applyServerState(payload);
    syncDirty = false;
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
        if (Array.isArray(result.documents) || Array.isArray(result.conversations)) {
          applyServerState(result);
        } else {
          cacheCurrentState();
        }
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

async function archiveDocumentSource(item, file) {
  if (!item?.id || !file?.name) {
    return false;
  }

  try {
    const body = new FormData();
    body.append("document", file, file.name);
    body.append("documentId", item.id);
    body.append("role", "source");

    const response = await fetch(DATA_FILE_UPLOAD_URL, {
      method: "POST",
      body,
    });

    if (!response.ok) {
      throw new Error(`File upload failed: ${response.status}`);
    }

    const result = await response.json();
    if (!result.file) {
      return false;
    }

    item.sourceFile = result.file;
    item.filePath = result.file.path;
    item.fileUrl = result.file.url;
    item.fileHash = result.file.sha256;
    item.fileMimeType = result.file.mimeType;
    item.fileSize = result.file.size;
    item.updatedAt = new Date().toISOString();
    syncCursor = String(result.syncCursor || syncCursor);
    localStorage.setItem(SYNC_CURSOR_STORAGE_KEY, syncCursor);
    persist();
    return true;
  } catch (error) {
    return false;
  }
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
    referenceDocumentIds: [],
    attachments: [],
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

function setConversationReferenceDocumentIds(values, conversation = getSelectedConversation()) {
  if (!conversation) {
    return false;
  }

  conversation.referenceDocumentIds = normalizeReferenceDocumentIds(values);
  conversation.updatedAt = new Date().toISOString();
  persistConversations();
  return true;
}

function getConversationReferenceDocumentIds(conversation = getSelectedConversation()) {
  return normalizeReferenceDocumentIds(conversation?.referenceDocumentIds);
}

function getConversationAttachments(conversation = getSelectedConversation()) {
  return normalizeConversationAttachments(conversation?.attachments);
}

function addConversationAttachment(attachment, conversation = getSelectedConversation()) {
  if (!conversation?.id || !attachment?.id) {
    return false;
  }
  conversation.attachments = normalizeConversationAttachments([
    ...(conversation.attachments || []),
    attachment,
  ]);
  conversation.updatedAt = new Date().toISOString();
  persistConversations();
  return true;
}

function updateConversationAttachment(attachmentId, changes, conversation = getSelectedConversation()) {
  if (!conversation?.id) {
    return null;
  }
  const attachment = (conversation.attachments || []).find((item) => item.id === attachmentId);
  if (!attachment) {
    return null;
  }
  Object.assign(attachment, changes, { updatedAt: new Date().toISOString() });
  conversation.attachments = normalizeConversationAttachments(conversation.attachments);
  conversation.updatedAt = new Date().toISOString();
  persistConversations();
  return conversation.attachments.find((item) => item.id === attachmentId) || null;
}

function removeConversationAttachment(attachmentId, conversation = getSelectedConversation()) {
  if (!conversation?.id) {
    return false;
  }
  const nextAttachments = (conversation.attachments || []).filter((item) => item.id !== attachmentId);
  if (nextAttachments.length === (conversation.attachments || []).length) {
    return false;
  }
  conversation.attachments = normalizeConversationAttachments(nextAttachments);
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

function createPage(pageNumber) {
  return {
    id: newId(),
    pageNumber,
    ocrText: "",
    cleanText: "",
    punctuatedText: "",
    notes: "",
    status: "待整理",
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

  if (item.pages.some((page) => page.status === "正在生成整理稿")) {
    return "正在生成整理稿";
  }

  if (item.pages.some((page) => hasPageText(page))) {
    return "已保存文字";
  }

  return "待整理";
}

function normalizePageStatus(status) {
  return status || "待整理";
}

function hasPageText(page) {
  return Boolean(page.ocrText || page.cleanText || page.punctuatedText);
}

function getPagePrimaryText(page) {
  return page?.punctuatedText || page?.cleanText || page?.ocrText || "";
}

function getPageProcessedText(page) {
  return page?.cleanText || page?.punctuatedText || "";
}

function getPageProcessedSearchText(page) {
  return [
    page?.cleanText,
    page?.punctuatedText,
    page?.notes,
  ].filter(Boolean).join("\n");
}

function getPageSearchText(page) {
  return [
    page?.ocrText,
    page?.cleanText,
    page?.punctuatedText,
    page?.notes,
  ].filter(Boolean).join("\n");
}

function createProcessingTask(file) {
  return {
    id: newId(),
    status: "提交中",
    createdAt: new Date().toISOString(),
    submittedAt: "",
    finishedAt: "",
    remoteTaskId: "",
    totalPages: 0,
    completedPages: 0,
    currentPage: 0,
    currentPageStage: "",
    currentPageProgress: 0,
    sourceFileName: file.name,
    serviceUrl: OCR_STREAM_SERVICE_URL,
    message: "正在提交逐页流式处理任务",
  };
}

function normalizeProcessingTask(task) {
  if (!task) {
    return null;
  }

  return {
    id: task.id,
    status: task.status || "提交中",
    createdAt: task.createdAt || "",
    submittedAt: task.submittedAt || "",
    finishedAt: task.finishedAt || "",
    remoteTaskId: task.remoteTaskId || "",
    totalPages: Number(task.totalPages) || 0,
    completedPages: Number(task.completedPages) || 0,
    currentPage: Number(task.currentPage) || 0,
    currentPageStage: task.currentPageStage || "",
    currentPageProgress: Number(task.currentPageProgress) || 0,
    sourceFileName: task.sourceFileName || "",
    serviceUrl: task.serviceUrl || OCR_STREAM_SERVICE_URL,
    message: task.message || "",
  };
}

function getProcessingTaskLabel(item) {
  const task = item.processingTask;
  if (!task) {
    return "等待处理";
  }

  const total = task.totalPages || 0;
  const ocrDone = task.completedPages || 0;
  const finalized = countFinalizedPages(item);

  if (total > 0 && (task.status === "处理中" || task.status === "排队中")) {
    return `${task.status} 识别 ${ocrDone}/${total} · 整理 ${finalized}/${total}`;
  }

  if (total > 0 && (task.status === "已完成" || task.status === "已回填")) {
    if (finalized < total) {
      return `识别完成 · 整理 ${finalized}/${total}`;
    }
    return `处理完成 识别 ${ocrDone}/${total} · 整理 ${finalized}/${total}`;
  }

  return task.status || "等待处理";
}

function countFinalizedPages(item) {
  return item.pages.filter((page) => page.cleanText || page.status === "已生成整理稿").length;
}

function getProcessingHelp() {
  return "OCR 连续按页识别，大模型按页码顺序消费已有结果；OCR 无需等待大模型。";
}

function mergeProcessingPages(item, incomingPages) {
  if (!Array.isArray(incomingPages) || !incomingPages.length) {
    return false;
  }

  const byNumber = new Map(item.pages.map((page) => [page.pageNumber, page]));
  let added = false;

  incomingPages.forEach((raw, index) => {
    const incoming = normalizeProcessingPage(raw, index);
    const existing = byNumber.get(incoming.pageNumber);

    if (existing) {
      // 保留已由大模型生成的整理文本，仅更新 OCR 结果。
      const ocrChanged = existing.ocrText !== incoming.ocrText;
      existing.ocrText = incoming.ocrText;
      existing.imageDataUrl = existing.imageDataUrl || incoming.imageDataUrl;
      existing.imageUrl = incoming.imageUrl || existing.imageUrl;
      existing.imageName = existing.imageName || incoming.imageName;
      existing.ocr = incoming.ocr;
      if (ocrChanged && existing.status !== "正在生成整理稿") {
        existing.status = existing.cleanText ? "已生成整理稿" : "已识别";
        existing.updatedAt = new Date().toISOString();
      }
      return;
    }

    item.pages.push(incoming);
    byNumber.set(incoming.pageNumber, incoming);
    added = true;
  });

  item.pages.sort((a, b) => a.pageNumber - b.pageNumber);
  item.status = summarizeDocumentStatus(item);
  item.updatedAt = new Date().toISOString();
  return added;
}

function normalizeProcessingPage(page, index) {
  const text = page.text || "";
  const warnings = Array.isArray(page.warnings) ? page.warnings : [];

  return {
    id: page.id || newId(),
    pageNumber: Number(page.pageNumber) || index + 1,
    ocrText: text,
    cleanText: "",
    punctuatedText: "",
    notes: page.notes || "",
    status: normalizePageStatus(page.status || (text ? "已识别" : "待整理")),
    imageDataUrl: page.imageDataUrl || "",
    imageUrl: page.imageUrl || "",
    imageName: page.imageName || `第 ${Number(page.pageNumber) || index + 1} 页`,
    ocr: {
      confidence: page.confidence ?? null,
      engine: page.engine || "本机逐页处理服务",
      preprocessing: page.preprocessing || null,
      layout: page.layout || null,
      warnings,
      recognizedAt: page.recognizedAt || new Date().toISOString(),
    },
    updatedAt: page.updatedAt || new Date().toISOString(),
  };
}
