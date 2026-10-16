// 下载副本的后台重建进度。
// 下载请求内已完成的部分（复制文件、重建阅览器索引、建立语义分块）由服务端计入基准百分比，
// 所以这里显示的是「点击下载 → 重建完成」整段过程的进度；服务端只汇报尚未完成的下载副本，
// 因此没有待办时会自动停止轮询。
const DOCUMENT_PREPARATION_POLL_MS = 4000;
// 与服务端 service/data.py 的 PREPARATION_SYNC_PERCENT 保持一致。
const DOCUMENT_PREPARATION_SYNC_PERCENT = 25;

const documentPreparationStates = new Map();
let documentPreparationTimer = 0;
let documentPreparationRequest = null;

const PREPARATION_STAGE_TEXT = {
  queued: "语义索引排队中",
  running: "重建语义索引中",
  waiting: "嵌入服务未就绪，语义索引等候中",
  failed: "语义索引失败",
};

function getDocumentPreparationState(documentId) {
  return documentPreparationStates.get(documentId) || null;
}

function describeDocumentPreparation(documentId) {
  const state = getDocumentPreparationState(documentId);
  if (!state) {
    return "";
  }
  const head = PREPARATION_STAGE_TEXT[state.stage] || PREPARATION_STAGE_TEXT.running;
  if (state.stage === "failed") {
    return state.message ? `${head}：${state.message}未能重建，稍后自动重试` : `${head}，稍后自动重试`;
  }
  return `${head} ${state.percent}%`;
}

function normalizePreparationState(item) {
  if (!item || typeof item.documentId !== "string" || !item.documentId) {
    return null;
  }
  const percent = Number(item.percent);
  return {
    documentId: item.documentId,
    stage: PREPARATION_STAGE_TEXT[item.stage] ? item.stage : "running",
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0,
    ready: Number(item.ready) || 0,
    total: Number(item.total) || 0,
    message: typeof item.message === "string" ? item.message : "",
  };
}

function applyDocumentPreparationItems(items) {
  // 服务端返回的是完整清单，本地乐观记录（刚下载、服务端还没排上队）也随之失效。
  const touched = new Set(documentPreparationStates.keys());
  const next = new Map();
  for (const item of items) {
    const state = normalizePreparationState(item);
    if (!state) continue;
    next.set(state.documentId, state);
    touched.add(state.documentId);
  }
  documentPreparationStates.clear();
  next.forEach((state, documentId) => documentPreparationStates.set(documentId, state));
  touched.forEach((documentId) => {
    if (typeof refreshDocumentCardStatusIndicators === "function") {
      refreshDocumentCardStatusIndicators(documentId);
    }
  });
  if (next.size) {
    startDocumentPreparationPolling();
  } else {
    stopDocumentPreparationPolling();
  }
}

function startDocumentPreparationPolling() {
  if (documentPreparationTimer) return;
  documentPreparationTimer = window.setInterval(refreshDocumentPreparation, DOCUMENT_PREPARATION_POLL_MS);
}

function stopDocumentPreparationPolling() {
  if (!documentPreparationTimer) return;
  window.clearInterval(documentPreparationTimer);
  documentPreparationTimer = 0;
}

function refreshDocumentPreparation() {
  if (documentPreparationRequest) {
    return documentPreparationRequest;
  }
  documentPreparationRequest = (async () => {
    const response = await fetch(DOCUMENT_PREPARATION_URL, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`后台重建进度读取失败（${response.status}）`);
    }
    const payload = await response.json().catch(() => ({}));
    applyDocumentPreparationItems(Array.isArray(payload?.items) ? payload.items : []);
  })().catch((error) => {
    // 进度只是提示：读取失败时保留上一次状态，等下一轮再试。
    console.warn("下载副本重建进度读取失败", error);
  }).finally(() => {
    documentPreparationRequest = null;
  });
  return documentPreparationRequest;
}

// 下载成功、卡片刚生成时先按基准进度显示，避免在首次轮询返回前闪回「N 页」。
function markDocumentPreparationPending(documentId) {
  if (!documentId) return;
  if (!documentPreparationStates.has(documentId)) {
    documentPreparationStates.set(documentId, {
      documentId,
      stage: "queued",
      percent: DOCUMENT_PREPARATION_SYNC_PERCENT,
      ready: 0,
      total: 0,
      message: "",
    });
  }
  if (typeof refreshDocumentCardStatusIndicators === "function") {
    refreshDocumentCardStatusIndicators(documentId);
  }
  startDocumentPreparationPolling();
  refreshDocumentPreparation();
}

function initializeDocumentPreparation() {
  // 首次探测；只有确实存在未完成的下载副本时才会继续轮询。
  refreshDocumentPreparation();
}
