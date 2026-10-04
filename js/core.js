// —— 站点识别：按 URL 首段区分已发布子站（/history、/literature…）——
// 同一份静态代码可同时服务多个子站；/history 下所有行为与旧版完全一致。
const SITE_PATH_SEGMENT = (location.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
const SITE_ID = SITE_PATH_SEGMENT && SITE_PATH_SEGMENT !== "html" ? SITE_PATH_SEGMENT : "history";
const HISTORY_BASE = `/${SITE_ID}`;

// 各子站品牌名（首页大标题 / 页面 <title> 后缀 / PDF 导出署名）
const SITE_TITLES = {
  history: "近代军史数智平台",
  literature: "文献库",
};
const SITE_TITLE = SITE_TITLES[SITE_ID] || SITE_ID;

// localStorage 按站点隔离（/history 沿用旧前缀，既有用户数据不变）
const SITE_STORAGE_PREFIX = SITE_ID === "history" ? "modernMilitaryHistory" : `wenqu.${SITE_ID}`;

const STORAGE_KEY = `${SITE_STORAGE_PREFIX}.documents.schema4`;
const FONT_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.font.schema4`;
const DATA_SCHEMA_VERSION = 6;

function endpoint(proxiedPath) {
  return `${HISTORY_BASE}/api${proxiedPath}`;
}

const OCR_SERVICE_URL = endpoint("/ocr/ocr");
const OCR_COVER_SERVICE_URL = endpoint("/ocr/ocr/cover-candidate");
const OCR_STREAM_SERVICE_URL = endpoint("/ocr/ocr/stream");
const OCR_HEALTH_URL = endpoint("/ocr/health");
const DATA_BOOTSTRAP_URL = endpoint("/data/api/bootstrap");
const DATA_SYNC_URL = endpoint("/data/api/sync");
const DATA_PUSH_URL = endpoint("/data/api/sync/push");
const DATA_FILE_UPLOAD_URL = endpoint("/data/api/files/upload");
const DOCUMENT_ANNOTATION_API_URL = endpoint("/data/api/documents");
const CONVERSATION_FILE_UPLOAD_URL = endpoint("/data/api/conversation-files/upload");
const CONVERSATION_FILE_API_URL = endpoint("/data/api/conversation-files");
const LLM_SERVICE_URL = endpoint("/llm/llm");
const LLM_HEALTH_URL = endpoint("/llm/health");
const VERSION_STATUS_URL = endpoint("/version/version");
const VERSION_UPDATE_URL = endpoint("/version/update");

// —— 运行时品牌（config.js 在各页 body 末尾最先加载，可安全访问上方 DOM）——
// 首页“大标题”元素用 id="home-site-title" 标记，随站点显示对应名称；
// 非 /history 子站的页面 <title> 中旧品牌名自动替换为当前站点名。
const homeSiteTitle = document.getElementById("home-site-title");
if (homeSiteTitle) {
  homeSiteTitle.textContent = SITE_TITLE;
}
if (SITE_ID !== "history") {
  let nextTitle = document.title.replace(/近代军史数智平台/g, SITE_TITLE);
  if (nextTitle === `${SITE_TITLE} · ${SITE_TITLE}`) {
    nextTitle = SITE_TITLE;
  }
  document.title = nextTitle;
}

// —— 平台更新广播：任一页面执行「更新」发布后，全平台已打开的页面一起强制刷新 ——
// 机制：发布页写入 localStorage 信号，其它页通过 storage 事件立即刷新；标签页重新可见/
// 获得焦点时再比对一次信号，避免后台标签页错过事件。sessionStorage 记录本页已处理的信号，
// 防止刷新后循环触发。（信号按域名共享，故 /history 与 /literature 会同时刷新。）
const PLATFORM_RELOAD_KEY = "wenqu.platform.reload";
const PLATFORM_RELOAD_ACK_KEY = "wenqu.platform.reload.acked";

function acknowledgedReloadSignal() {
  try {
    return sessionStorage.getItem(PLATFORM_RELOAD_ACK_KEY);
  } catch (_) {
    return null;
  }
}

function acknowledgeReloadSignal(signal) {
  try {
    sessionStorage.setItem(PLATFORM_RELOAD_ACK_KEY, signal);
  } catch (_) {
    /* 隐私模式等存储不可用时忽略 */
  }
}

function applyPlatformReloadSignal(force = false) {
  let signal = null;
  try {
    signal = localStorage.getItem(PLATFORM_RELOAD_KEY);
  } catch (_) {
    return;
  }
  if (!signal) {
    return;
  }
  if (!force && acknowledgedReloadSignal() === signal) {
    return;
  }
  acknowledgeReloadSignal(signal);
  window.location.reload();
}

// 发布完成后调用：标记本页已处理，并通知其它页面刷新
function broadcastPlatformReload() {
  const signal = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  acknowledgeReloadSignal(signal);
  try {
    localStorage.setItem(PLATFORM_RELOAD_KEY, signal);
  } catch (_) {
    /* 存储不可用时仅本页刷新 */
  }
  return signal;
}

window.addEventListener("storage", (event) => {
  if (event.key === PLATFORM_RELOAD_KEY) {
    applyPlatformReloadSignal(true);
  }
});
window.addEventListener("focus", () => applyPlatformReloadSignal());
window.addEventListener("pageshow", () => applyPlatformReloadSignal());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    applyPlatformReloadSignal();
  }
});
function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDateTime(date) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
  const time = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ].join(":");

  return `${parts.join("-")} ${time}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return map[char];
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emptyState(message) {
  const node = document.createElement("div");
  node.className = "empty-state";
  node.textContent = message;
  return node;
}

function renderResultState(container, message) {
  container.innerHTML = "";
  container.classList.add("empty-result-list");
  const empty = emptyState(message);
  empty.classList.add("result-empty");
  container.append(empty);
}

function formatWarnings(warnings) {
  const node = document.createElement("p");
  node.className = "meta-line";
  node.textContent = `提示：${warnings.join("；")}`;
  return node;
}

function buildSnippet(text, query) {
  const haystack = text || "";
  const index = haystack.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) {
    return "";
  }

  const start = Math.max(0, index - 36);
  const end = Math.min(haystack.length, index + query.length + 72);
  return `${start > 0 ? "..." : ""}${haystack.slice(start, end)}${end < haystack.length ? "..." : ""}`;
}

function highlight(text, query) {
  const escaped = escapeRegExp(query);
  return escapeHtml(text).replace(new RegExp(escaped, "gi"), (match) => `<mark>${match}</mark>`);
}

function scoreTextRelevance(text, query) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/[\s,，、；;]+/)
    .map((term) => term.trim())
    .filter(Boolean);
  const normalizedText = String(text || "").toLowerCase();
  return terms.reduce((score, term) => score + (normalizedText.includes(term) ? 3 : 0), 1);
}
const form = document.querySelector("#document-form");
const formSheet = document.querySelector("#document-form-sheet");
const documentList = document.querySelector("#document-list");
const documentCount = document.querySelector("#document-count");
const allDocumentList = document.querySelector("#all-document-list");
const allDocumentCount = document.querySelector("#all-document-count");
const readerTitle = document.querySelector("#reader-title");
const readerPageStatus = document.querySelector("#reader-page-status");
const readerPageInput = document.querySelector("#reader-page-input");
const readerPageTotal = document.querySelector("#reader-page-total");
const readerCompare = document.querySelector("#reader-compare");
const readerOriginalPanel = document.querySelector("#reader-original-panel");
const readerOriginalPreview = document.querySelector("#reader-original-preview");
const readerText = document.querySelector("#reader-text");
const readerNotes = document.querySelector("#reader-notes");
const readerAnnotationPanel = document.querySelector("#reader-annotation-panel");
const readerAnnotation = document.querySelector("#reader-annotation");
const readerAnnotationStatus = document.querySelector("#reader-annotation-status");
const readerOriginalToggle = document.querySelector("#reader-original-toggle");
const readerAnnotationToggle = document.querySelector("#reader-annotation-toggle");
const readerPrevPageButton = document.querySelector("#reader-prev-page");
const readerNextPageButton = document.querySelector("#reader-next-page");
const readerBackButton = document.querySelector("#reader-back");
const exportDocumentPdfButton = document.querySelector("#export-document-pdf");
const editDocumentButton = document.querySelector("#edit-document");
const editDocumentLabel = document.querySelector("#edit-document-label");
const readerDetailNode = document.querySelector("#reader-document-detail");
const streamStatus = document.querySelector("#stream-status, #reader-stream-status");
const streamProgress = document.querySelector("#stream-progress, #reader-stream-progress");
const searchInput = document.querySelector("#search-input");
const searchResults = document.querySelector("#search-results");
const chronicleTopic = document.querySelector("#chronicle-topic");
const chronicleResults = document.querySelector("#chronicle-results");
const resultToolbar = document.querySelector("#result-toolbar");
const resultToolbarStatus = document.querySelector("#result-toolbar-status");
const resultRegenerateButton = document.querySelector("#result-regenerate");
const resultUpdateButton = document.querySelector("#result-update");
const cardTemplate = document.querySelector("#document-card-template");
const versionServiceStatus = document.querySelector("#version-service-status");
const versionUpdateButton = document.querySelector("#version-update-button");
const ocrServiceStatus = document.querySelector("#ocr-service-status");
const llmServiceStatus = document.querySelector("#llm-service-status");
const conversationList = document.querySelector("#conversation-list");
const newConversationButton = document.querySelector("#new-conversation");
const chatTitle = document.querySelector("#chat-title");
const chatHint = document.querySelector("#chat-hint");
const messageFeed = document.querySelector("#message-feed");
const deleteConversationDialog = document.querySelector("#delete-conversation-dialog");
const deleteConversationTitle = document.querySelector("#delete-conversation-title");
const deleteConversationMessage = document.querySelector("#delete-conversation-message");
const cancelDeleteConversation = document.querySelector("#cancel-delete-conversation");
const confirmDeleteConversation = document.querySelector("#confirm-delete-conversation");
const openReferenceDocumentsButton = document.querySelector("#open-reference-documents");
const referenceDocumentCount = document.querySelector("#reference-document-count");
const referenceDocumentChips = document.querySelector("#reference-document-chips");
const referenceScopeStatus = document.querySelector("#reference-scope-status");
const referenceDocumentDialog = document.querySelector("#reference-document-dialog");
const referenceDocumentSearch = document.querySelector("#reference-document-search");
const referenceDocumentList = document.querySelector("#reference-document-list");
const referenceSelectionSummary = document.querySelector("#reference-selection-summary");
const closeReferenceDocumentsButton = document.querySelector("#close-reference-documents");
const cancelReferenceDocumentsButton = document.querySelector("#cancel-reference-documents");
const confirmReferenceDocumentsButton = document.querySelector("#confirm-reference-documents");
const uploadConversationFilesButton = document.querySelector("#upload-conversation-files");
const conversationFileInput = document.querySelector("#conversation-file-input");
const conversationAttachmentChips = document.querySelector("#conversation-attachment-chips");
const conversationAttachmentStatus = document.querySelector("#conversation-attachment-status");
const fontOptionButtons = document.querySelectorAll("[data-font-option]");
const openSettingsButton = document.querySelector("#open-settings");
const settingsDialog = document.querySelector("#settings-dialog");
const closeSettingsButton = document.querySelector("#close-settings");
const DOCUMENT_COVER_VARIANT_COUNT = 6;
const CONVERSATION_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.conversations.schema4`;
const CLIENT_ID_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.clientId.schema4`;
const SYNC_CURSOR_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.syncCursor.schema4`;
const SYNC_DIRTY_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.syncDirty.schema4`;
const DELETED_DOCUMENT_IDS_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.deletedDocuments.schema4`;
const DELETED_CONVERSATION_IDS_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.deletedConversations.schema4`;
// 待向 OCR 服务确认的“删除文献 → 终止处理”请求（成功后从队列里移除）
const PENDING_PROCESSING_CANCELS_KEY = `${SITE_STORAGE_PREFIX}.processingCancels.schema4`;
const SYNC_INTERVAL_MS = 30000;

let documents = normalizeDocuments(loadCachedDocuments());
let selectedDocumentId = documents[0]?.id || null;
let selectedPageId = documents[0]?.pages?.[0]?.id || null;
let conversations = loadCachedConversations();
let selectedConversationId = conversations[0]?.id || null;
let syncCursor = localStorage.getItem(SYNC_CURSOR_STORAGE_KEY) || "";
let syncReady = false;
// 脏标记跨页面保留：若本地改动尚未成功推送就发生跳转（如登记后进入阅读页），
// 下一页加载时会先把本地快照推送上去，而不是直接拉取服务端快照覆盖本地。
let syncDirty = localStorage.getItem(SYNC_DIRTY_STORAGE_KEY) === "1";
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
        creator: item.creator && item.creator.username ? { username: String(item.creator.username) } : null,
        ownerId: item.ownerId ?? null,
        canEdit: item.canEdit === true,
        tags: item.tags || "",
        visibility: item.visibility === "public" ? "public" : "private",
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
            ocr: normalizeStoredOcr(page.ocr),
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
      result: normalizeConversationResult(item.result),
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

function normalizeConversationResult(value) {
  if (!value || typeof value !== "object" || !value.mode) {
    return null;
  }

  return {
    mode: String(value.mode),
    prompt: String(value.prompt || ""),
    payload: value.payload && typeof value.payload === "object" ? value.payload : {},
    warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : [],
    sourceDocumentIds: normalizeReferenceDocumentIds(value.sourceDocumentIds),
    generatedAt: value.generatedAt || "",
  };
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
  localStorage.setItem(SYNC_DIRTY_STORAGE_KEY, "1");
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
        localStorage.removeItem(SYNC_DIRTY_STORAGE_KEY);
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

// 立即把本地改动推送到服务端并等待完成（取消防抖）。
// 用于跳转前确保数据已落服务端，避免下一页拉取快照时覆盖本地未同步内容。
// 注意：pushServerSnapshot() 在有在途请求时会直接返回那个请求（它带的可能是旧快照），
// 所以这里要循环推到「确实没有新改动」为止，否则刚落库的任务号/原件地址会被旧快照覆盖。
async function flushPendingSync() {
  window.clearTimeout(syncPushTimer);
  syncPushTimer = null;

  if (!syncReady || !syncDirty) {
    return false;
  }

  let pushed = false;
  for (let attempt = 0; attempt < 5 && syncDirty; attempt += 1) {
    window.clearTimeout(syncPushTimer);
    syncPushTimer = null;
    pushed = (await pushServerSnapshot()) || pushed;
  }
  return pushed;
}

// 归档原件。onProgress(0~1) 可选，用于界面上报上传进度。
// 上传走 XHR + 重试（幂等接口），失败时抛错，由调用方（上传流水线）决定如何提示与续传。
async function archiveDocumentSource(item, file, onProgress) {
  if (!item?.id || !canEditDocument(item) || !file?.name) {
    return false;
  }

  try {
    const body = new FormData();
    body.append("document", file, file.name);
    body.append("documentId", item.id);
    body.append("role", "source");

    const result = await postFormDataWithProgress(DATA_FILE_UPLOAD_URL, body, {
      onProgress,
      retries: 2,
    });
    if (!result || !result.file) {
      throw new Error("原件上传未完成：服务端未返回文件记录。");
    }

    const target = getLiveDocument(item.id) || item;
    target.sourceFile = result.file;
    target.filePath = result.file.path;
    target.fileUrl = result.file.url;
    target.fileHash = result.file.sha256;
    target.fileMimeType = result.file.mimeType;
    target.fileSize = result.file.size;
    if (target.pages?.[0] && result.file.mimeType?.startsWith("image/")) {
      target.pages[0].imageUrl = result.file.url;
      target.pages[0].imageName = target.fileName || file.name;
    }
    target.updatedAt = new Date().toISOString();
    syncCursor = String(result.syncCursor || syncCursor);
    localStorage.setItem(SYNC_CURSOR_STORAGE_KEY, syncCursor);
    persist();
    if (typeof renderAll === "function") {
      renderAll();
    }
    return true;
  } catch (error) {
    throw error instanceof Error ? error : new Error("原件上传失败。");
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
    result: null,
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

  if (index === -1 || !canEditDocument(documents[index])) {
    return;
  }

  documents.splice(index, 1);
  deletedDocumentIds.add(id);

  if (selectedDocumentId === id) {
    const nextDocument = documents[index] || documents[index - 1] || null;
    selectedDocumentId = nextDocument?.id || null;
    selectedPageId = nextDocument?.pages?.[0]?.id || null;
  }

  cancelDocumentProcessing(id);
  if (typeof stopDocumentProcessing === "function") {
    stopDocumentProcessing(id);
  }
  persist();
}

// 删除文献时让 OCR 服务终止它的任务并清掉缓存（原件 + 逐页图），
// 否则那个任务会一直占着唯一的处理槽，后面的文献排不进来。
// 待取消的 id 记在 localStorage 里，请求失败或页面提前关闭时下次打开页面补发，直到服务端确认。
function cancelDocumentProcessing(documentId) {
  if (!documentId) {
    return;
  }

  const pending = loadPendingProcessingCancels();
  pending.add(documentId);
  savePendingProcessingCancels(pending);
  void flushProcessingCancel(documentId);
}

function loadPendingProcessingCancels() {
  try {
    const values = JSON.parse(localStorage.getItem(PENDING_PROCESSING_CANCELS_KEY)) || [];
    return new Set(values.map((value) => String(value)).filter(Boolean));
  } catch (error) {
    return new Set();
  }
}

function savePendingProcessingCancels(ids) {
  localStorage.setItem(PENDING_PROCESSING_CANCELS_KEY, JSON.stringify(Array.from(ids)));
}

async function flushProcessingCancel(documentId) {
  try {
    const response = await fetch(
      `${OCR_STREAM_SERVICE_URL}?documentId=${encodeURIComponent(documentId)}`,
      { method: "DELETE", keepalive: true },
    );
    if (!response.ok) {
      return false;
    }
  } catch (error) {
    return false;
  }

  const pending = loadPendingProcessingCancels();
  if (pending.delete(documentId)) {
    savePendingProcessingCancels(pending);
  }
  return true;
}

// 页面每次启动补发一遍未确认的取消请求（幂等，服务端查不到就是空操作）。
async function flushPendingProcessingCancels() {
  const pending = Array.from(loadPendingProcessingCancels());
  for (const documentId of pending) {
    await flushProcessingCancel(documentId);
  }
}

function getDocumentDisplayTitle(item) {
  return item?.title || item?.fileName || "未命名文献";
}

function resolveDocumentSource(source) {
  const item = source.documentId
    ? documents.find((documentItem) => documentItem.id === source.documentId)
    : documents.find((documentItem) => {
        return getDocumentDisplayTitle(documentItem) === source.title || documentItem.title === source.title;
      });
  if (!item) {
    return null;
  }

  const page = source.pageId
    ? item.pages.find((pageItem) => pageItem.id === source.pageId)
    : item.pages.find((pageItem) => pageItem.pageNumber === Number(source.pageNumber));
  return { item, page: page || null };
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

// 服务端快照同步（applyServerState）会整体替换 documents 里的对象，
// 所以任何 await 之后要写回文献时必须用 id 重新取当前实例，否则改动会落到已被丢弃的旧对象上。
function getLiveDocument(documentId) {
  return documents.find((item) => item.id === documentId) || null;
}

function canEditDocument(item) {
  if (!item?.canEdit || !currentUser || item.ownerId === null || item.ownerId === undefined) {
    return false;
  }
  return Number(item.ownerId) === Number(currentUser.id);
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
    if (!canEditDocument(item)) {
      selectedPageId = null;
      return;
    }
    const page = createPage(1);
    item.pages.push(page);
    selectedPageId = page.id;
  }

  if (!item.pages.some((page) => page.id === selectedPageId)) {
    selectedPageId = item.pages[0].id;
  }
}

function summarizeDocumentStatus(item) {
  if (item.pages.every((page) => !hasPageText(page))) {
    return "待整理";
  }

  if (item.pages.some((page) => page.status === "正在生成整理稿")) {
    return "正在生成整理稿";
  }

  return "已保存文字";
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

// 早期版本在 page.ocr 里存过 layout（自研版面分析）与 preprocessing（自研图像预处理），
// 这里读取时顺带瘦身，只保留摘要字段，避免历史数据继续占用 localStorage。
function normalizeStoredOcr(ocr) {
  if (!ocr) {
    return null;
  }

  return {
    confidence: ocr.confidence ?? null,
    engine: ocr.engine || "识别服务",
    width: ocr.width ?? null,
    height: ocr.height ?? null,
    blockCount: Number(ocr.blockCount) || 0,
    blockTypes: Array.isArray(ocr.blockTypes) ? ocr.blockTypes : [],
    hasMarkdown: Boolean(ocr.hasMarkdown),
    upstream: ocr.upstream || null,
    warnings: Array.isArray(ocr.warnings) ? ocr.warnings : [],
    recognizedAt: ocr.recognizedAt || "",
  };
}

// 页面对象会整体同步到数据服务并写入 localStorage，因此 OCR 只保存轻量摘要：
// 版面块与行的坐标体量很大（一本书可达上万行），详情留在 OCR 服务的任务记录里。
function buildOcrSummary(result) {
  const source = result || {};
  const blocks = Array.isArray(source.blocks) ? source.blocks : [];
  const blockTypes = Array.from(
    new Set(blocks.map((block) => block && block.type).filter(Boolean)),
  );

  return {
    confidence: source.confidence ?? null,
    engine: source.engine || "识别服务",
    width: source.width ?? null,
    height: source.height ?? null,
    blockCount: blocks.length,
    blockTypes,
    hasMarkdown: Boolean(source.markdown),
    upstream: source.upstream || null,
    warnings: Array.isArray(source.warnings) ? source.warnings : [],
    recognizedAt: source.recognizedAt || new Date().toISOString(),
  };
}

function normalizeProcessingPage(page, index) {
  const text = page.text || "";

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
    ocr: buildOcrSummary(page),
    updatedAt: page.updatedAt || new Date().toISOString(),
  };
}
