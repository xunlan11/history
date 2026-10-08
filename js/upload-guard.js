// 大文件上传守护：进度上报 / 离开页面拦截 / 原件暂存与续传。
//
// 背景：整本 PDF 动辄几十 MB，上传期间只要页面被跳转或刷新，浏览器就会 abort 在途 POST，
// nginx 记为 499 —— 结果「文献记录已建、原件与逐页任务都没提交」，阅读页只剩一个本地占位页，
// 进度永远停在 0/1。这里保证「要么传完，要么下次接着传」：
//   1. 上传中点开其它文献会被拦住，刷新/关页会弹浏览器确认；
//   2. 用 XHR 上报上传进度，界面显示「上传原件 42%」；
//   3. 原件先存进 IndexedDB，四个登记阶段完成并同步后才删除；
//      中途失败或页面被刷新后，下一次打开任意页面会自动从暂存续传。
//
// 说明：请求走 XHR 是为了拿到 upload.onprogress（fetch 拿不到上传进度），
// 因此需要手动带上 Authorization 头（auth.js 只包装了 window.fetch）。

const PENDING_UPLOAD_DB_NAME = "wenqu.pendingUploads";
const PENDING_UPLOAD_STORE = "documents";
const PENDING_UPLOAD_RETRY_DELAYS_MS = [1200, 3600];
const UPLOAD_PROGRESS_PAINT_INTERVAL_MS = 120;
// 多久完全没有上传进展就判定链路已断（大文件用，避免一个卡死的请求永远占着页面）
const UPLOAD_STALL_TIMEOUT_MS = 180000;

const documentUploadStates = new Map();

let pendingUploadDbPromise = null;

function getStoredAuthToken() {
  const key = typeof AUTH_TOKEN_KEY === "string" ? AUTH_TOKEN_KEY : `${SITE_STORAGE_PREFIX}.authToken`;
  return localStorage.getItem(key) || "";
}

function formatUploadSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${size} B`;
}

// ---- XHR 上传（带进度）----
// options.onProgress: 0~1；options.retries: 网络类错误的重试次数（幂等接口才用）。
// 失败时抛出的 Error 会带 status / payload（服务端 detail）/ networkError 三个附加属性。
function postFormDataWithProgress(url, formData, options = {}) {
  const { onProgress, retries = 0 } = options;
  const delays = Array.isArray(options.retryDelays) ? options.retryDelays : PENDING_UPLOAD_RETRY_DELAYS_MS;
  let attempt = 0;

  const sendOnce = () => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let watchdog = 0;
    let stalled = false;
    let uploadFinished = false;
    const armWatchdog = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, uploadFinished ? (Number(options.responseTimeoutMs) || UPLOAD_STALL_TIMEOUT_MS) : UPLOAD_STALL_TIMEOUT_MS);
    };

    xhr.open("POST", url);
    const token = getStoredAuthToken();
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }
    // 大文件上传不设总超时，改用“无进展即中断”的看门狗。
    xhr.timeout = 0;
    if (xhr.upload && typeof onProgress === "function") {
      xhr.upload.onprogress = (event) => {
        armWatchdog();
        if (event.lengthComputable && event.total > 0) {
          onProgress(event.loaded / event.total);
        }
      };
    }
    if (xhr.upload) {
      xhr.upload.onload = () => {
        uploadFinished = true;
        armWatchdog();
      };
    }
    xhr.onload = () => {
      window.clearTimeout(watchdog);
      let payload = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch (error) {
        payload = null;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const detail = payload && payload.detail
          ? (typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail))
          : "";
        const error = new Error(detail || `上传失败（HTTP ${xhr.status}）`);
        error.status = xhr.status;
        error.payload = payload;
        reject(error);
        return;
      }
      resolve(payload);
    };
    xhr.onerror = () => {
      window.clearTimeout(watchdog);
      const error = new Error("网络中断，原件未上传完成");
      error.networkError = true;
      reject(error);
    };
    xhr.onabort = () => {
      window.clearTimeout(watchdog);
      const error = new Error(stalled ? "上传长时间无进展，已中断" : "上传被中断");
      error.networkError = true;
      reject(error);
    };
    xhr.ontimeout = () => {
      window.clearTimeout(watchdog);
      const error = new Error("上传超时");
      error.networkError = true;
      reject(error);
    };
    armWatchdog();
    xhr.send(formData);
  });

  const runWithRetry = () => sendOnce().catch((error) => {
    if (attempt >= retries || !error.networkError) {
      throw error;
    }
    const delay = delays[Math.min(attempt, delays.length - 1)];
    attempt += 1;
    if (typeof onProgress === "function") {
      onProgress(0);
    }
    return new Promise((resolve) => window.setTimeout(resolve, delay)).then(runWithRetry);
  });

  return runWithRetry();
}

// ---- 上传状态（按文献 id 记录，不写进 documents，避免被服务端快照覆盖）----
function getDocumentUploadState(documentId) {
  return documentUploadStates.get(documentId) || null;
}

function isDocumentUploadActive(documentId) {
  const state = documentUploadStates.get(documentId);
  return Boolean(state && state.active);
}

function hasActiveDocumentUpload() {
  for (const state of documentUploadStates.values()) {
    if (state.active) {
      return true;
    }
  }
  return false;
}

function shortenDocumentCardStatus(text) {
  const value = String(text || "").trim();
  if (!value) {
    return "";
  }
  const percent = value.match(/\d+(?:\.\d+)?%/)?.[0] || "";
  const base = value.replace(/\d+(?:\.\d+)?%/, "").trim();
  let label = base;
  if (/准备上传/.test(base)) {
    label = "准备中";
  } else if (/保存文献记录/.test(base)) {
    label = "保存中";
  } else if (/上传原件/.test(base)) {
    label = "上传中";
  } else if (/已交给后端准备登记|登记中/.test(base)) {
    label = "登记中";
  } else if (/等待后端登记/.test(base)) {
    label = "等待登记";
  } else if (/读取登记候选页/.test(base)) {
    label = "读候选页";
  } else if (/识别文献信息/.test(base)) {
    label = "识别信息";
  } else if (/登记已暂停/.test(base)) {
    label = "已暂停";
  } else if (/登记未完成/.test(base)) {
    label = "未完成";
  } else if (/登记失败|处理失败/.test(base)) {
    label = "处理失败";
  } else if (/等待服务恢复|等候中/.test(base)) {
    label = "等候中";
  } else if (/排队中/.test(base)) {
    label = "排队中";
  } else if (/处理中/.test(base)) {
    label = "处理中";
  } else if (/已完成/.test(base)) {
    label = "已完成";
  }
  if (label.length > 4) {
    label = label.slice(0, 4);
  }
  return percent ? `${label} ${percent}` : label;
}
// 后端登记只剩元数据识别：沿用客户端 4 段进度（归档上传占 0~25%），后两步按后端阶段推进。
const BACKEND_REGISTRATION_STAGES = {
  "": { label: "等待后端登记", percent: 25 },
  metadata_candidate: { label: "读取登记候选页", percent: 40 },
  metadata: { label: "识别文献信息", percent: 75 },
};

function describeBackendRegistration(item) {
  const registration = item.registration || {};
  if (registration.status === "failed") {
    return "登记失败，点击继续";
  }
  const stage = BACKEND_REGISTRATION_STAGES[item.processingTask?.currentPageStage || ""] || BACKEND_REGISTRATION_STAGES[""];
  if (registration.status === "waiting") {
    return `等候中 ${stage.percent}%`;
  }
  return `${stage.label} ${stage.percent}%`;
}

function describeDocumentUploadState(documentId) {
  const state = documentUploadStates.get(documentId);
  if (!state) {
    const item = getLiveDocument(documentId);
    if (isDocumentRegistrationPending(item)) {
      if (item.processingTask?.backendManaged) {
        return describeBackendRegistration(item);
      }
      return item.registration.status === "paused" ? "登记已暂停，点击继续" : "登记未完成，点击继续";
    }
    return "";
  }
  if (state.active) {
    return `${state.stage || "上传中"} ${Math.round(Number(state.percent) || 0)}%`;
  }
  if (state.error) {
    return state.permanent ? "登记失败，请重新导入" : "登记未完成，点击继续";
  }
  return "";
}

function updateDocumentUploadState(documentId, patch, options = {}) {
  const previous = documentUploadStates.get(documentId) || {};
  const next = { ...previous, ...patch };
  documentUploadStates.set(documentId, next);
  window.clearTimeout(next.paintTimer);
  next.paintTimer = 0;

  const now = Date.now();
  const paintedRecently = now - (previous.lastPaintAt || 0) < UPLOAD_PROGRESS_PAINT_INTERVAL_MS;
  if (options.force || !next.active || !paintedRecently) {
    next.lastPaintAt = now;
    refreshDocumentUploadIndicators(documentId);
    return next;
  }

  // 被节流跳过的那次更新补一次尾随绘制，避免界面停在旧进度上。
  next.paintTimer = window.setTimeout(() => {
    const current = documentUploadStates.get(documentId);
    if (!current || current !== next) {
      return;
    }
    current.lastPaintAt = Date.now();
    current.paintTimer = 0;
    refreshDocumentUploadIndicators(documentId);
  }, UPLOAD_PROGRESS_PAINT_INTERVAL_MS);

  return next;
}

function beginDocumentUpload(item, file) {
  documentUploadStates.set(item.id, {
    active: true,
    stage: "准备上传",
    stageIndex: 0,
    percent: 0,
    fileName: file?.name || item.fileName || "",
    fileSize: Number(file?.size) || Number(item.fileSize) || 0,
    error: "",
    startedAt: new Date().toISOString(),
    lastPaintAt: 0,
  });
  refreshDocumentUploadIndicators(item.id);
}

function markDocumentUploadFinished(documentId) {
  const state = documentUploadStates.get(documentId);
  if (state) {
    window.clearTimeout(state.paintTimer);
  }
  documentUploadStates.delete(documentId);
  if (typeof renderAll === "function") {
    renderAll();
  } else {
    refreshDocumentUploadIndicators(documentId);
  }
}

function markDocumentUploadFailed(documentId, error) {
  const message = error && error.message ? error.message : "文献登记未完成";
  const status = Number(error && error.status) || 0;
  const permanent = status >= 400 && status < 500 && getLiveDocument(documentId)?.registration?.stage === "archive";
  updateDocumentUploadState(
    documentId,
    { active: false, percent: 0, error: message, permanent },
    { force: true },
  );
  showUploadToast(
    permanent
      ? `文献登记失败：${message}`
      : `文献登记未完成：${message}（已保留，可点击文献继续）`,
    6000,
  );
}

// 卡片 / 侧栏上的进度显示。
function refreshDocumentUploadIndicators(documentId) {
  const state = getDocumentUploadState(documentId);
  const text = describeDocumentUploadState(documentId);

  document.querySelectorAll(".book-card").forEach((card) => {
    if (card.dataset.documentId !== documentId) {
      return;
    }
    card.classList.toggle("is-uploading", Boolean(state && state.active));
    card.classList.toggle("is-upload-failed", Boolean(state && !state.active && state.error));
    const pages = card.querySelector(".book-pages");
    if (pages) {
      pages.classList.toggle("is-status", Boolean(text));
      if (text) {
        pages.textContent = shortenDocumentCardStatus(text);
        pages.title = text;
      } else {
        pages.removeAttribute("title");
      }
    }
  });

  if (typeof selectedDocumentId === "string" && selectedDocumentId === documentId) {
    const statusNode = document.querySelector("#reader-stream-status");
    if (statusNode && text) {
      statusNode.textContent = text;
    }
  }
}

function showUploadToast(message, duration = 3200) {
  if (!message || !document.body) {
    return;
  }
  let node = document.querySelector(".upload-toast");
  if (!node) {
    node = document.createElement("div");
    node.className = "upload-toast";
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.remove("hidden");
  window.clearTimeout(showUploadToast.timer);
  showUploadToast.timer = window.setTimeout(() => {
    node.classList.add("hidden");
  }, duration);
}

// 上传未完成时拦截刷新 / 关页（浏览器只显示通用提示，无法自定义文案）。
window.addEventListener("beforeunload", (event) => {
  if (!hasActiveDocumentUpload()) {
    return;
  }
  event.preventDefault();
  event.returnValue = "文献正在登记，离开会中断登记。";
  return event.returnValue;
});

// ---- IndexedDB 暂存（原件续传用）----
function openPendingUploadDb() {
  if (pendingUploadDbPromise) {
    return pendingUploadDbPromise;
  }

  pendingUploadDbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(PENDING_UPLOAD_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PENDING_UPLOAD_STORE)) {
          db.createObjectStore(PENDING_UPLOAD_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch (error) {
      resolve(null);
    }
  });

  return pendingUploadDbPromise;
}

// 暂存失败（隐私模式 / 配额不足）不算致命：只是失去续传能力。
async function stashPendingUpload(documentId, file) {
  const db = await openPendingUploadDb();
  if (!db) {
    return false;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PENDING_UPLOAD_STORE, "readwrite");
      tx.objectStore(PENDING_UPLOAD_STORE).put({
        id: documentId,
        blob: file,
        fileName: file.name || "",
        fileSize: Number(file.size) || 0,
        stashedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (error) {
      resolve(false);
    }
  });
}

async function readPendingUpload(documentId) {
  const db = await openPendingUploadDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve) => {
    try {
      const request = db.transaction(PENDING_UPLOAD_STORE, "readonly")
        .objectStore(PENDING_UPLOAD_STORE)
        .get(documentId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    } catch (error) {
      resolve(null);
    }
  });
}

async function dropPendingUpload(documentId) {
  const db = await openPendingUploadDb();
  if (!db) {
    return false;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PENDING_UPLOAD_STORE, "readwrite");
      tx.objectStore(PENDING_UPLOAD_STORE).delete(documentId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (error) {
      resolve(false);
    }
  });
}

function pendingUploadToFile(record) {
  if (!record || !record.blob) {
    return null;
  }
  const name = record.fileName || "document";
  const type = record.blob.type || "application/octet-stream";
  return new File([record.blob], name, { type });
}
