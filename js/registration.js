// 文件只在本页上传；登记成功之前不创建文献和调度任务。
const UPLOAD_RETRY_DELAYS_MS = [1200, 3600];
const UPLOAD_STALL_TIMEOUT_MS = 180000;
let registrationBatch = null;
let draggedUploadId = "";

function getStoredAuthToken() {
  const key = typeof AUTH_TOKEN_KEY === "string" ? AUTH_TOKEN_KEY : `${SITE_STORAGE_PREFIX}.authToken`;
  return localStorage.getItem(key) || "";
}

function hasActiveDocumentUpload() {
  return Boolean(registrationBatch?.files.length);
}

function isCurrentUpload(state) {
  return Boolean(registrationBatch?.files.includes(state));
}

function uploadCancelled() {
  return new DOMException("上传已取消", "AbortError");
}

function uploadUrl(id, suffix = "") {
  return `${endpoint("/data/api/uploads")}/${encodeURIComponent(id)}${suffix}`;
}

async function uploadRequest(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) {
    let payload;
    try { payload = await response.json(); } catch {}
    const detail = payload?.detail;
    throw new Error(typeof detail === "string" ? detail : `请求失败（HTTP ${response.status}）`);
  }
  return response.json();
}

function sendTemporaryFile(state) {
  return new Promise((resolve, reject) => {
    const signal = state.controller.signal;
    if (signal.aborted) return reject(uploadCancelled());
    const xhr = new XMLHttpRequest();
    let watchdog;
    const armWatchdog = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => xhr.abort(), UPLOAD_STALL_TIMEOUT_MS);
    };
    const abort = () => xhr.abort();
    const finish = (error, result) => {
      window.clearTimeout(watchdog);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result);
    };
    xhr.open("POST", uploadUrl(state.id, "/file"));
    const token = getStoredAuthToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      armWatchdog();
      if (event.lengthComputable && event.total > 0 && isCurrentUpload(state)) {
        // 字节发送结束还需等待服务端确认，确认前不显示完成。
        state.percent = Math.min(99, Math.floor(event.loaded / event.total * 100));
        renderRegistrationUploads();
      }
    };
    xhr.upload.onload = armWatchdog;
    xhr.onload = () => {
      let result;
      try { result = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status < 200 || xhr.status >= 300 || result?.status !== "ready") {
        finish(new Error(typeof result?.detail === "string" ? result.detail : `上传失败（HTTP ${xhr.status}）`));
      } else finish(null, result);
    };
    xhr.onerror = () => finish(new Error("上传网络中断"));
    xhr.onabort = () => finish(signal.aborted ? uploadCancelled() : new Error("上传长时间无进展"));
    signal.addEventListener("abort", abort, { once: true });
    const body = new FormData();
    body.append("document", state.file, state.file.name);
    armWatchdog();
    xhr.send(body);
  });
}

function waitForUploadRetry(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(uploadCancelled());
    const abort = () => { window.clearTimeout(timer); reject(uploadCancelled()); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function createUploadRow(state) {
  const row = document.querySelector("#upload-file-template").content.firstElementChild.cloneNode(true);
  row.dataset.uploadId = state.id;
  row.querySelector(".file-picker-name").textContent = state.file.name;
  row.querySelector(".file-picker-name").title = state.file.name;
  row.querySelector(".file-upload-remove").addEventListener("click", () => removeRegistrationUpload(state.id));
  const handle = row.querySelector(".file-upload-drag");
  handle.addEventListener("dragstart", (event) => {
    if (registrationBatch?.status === "submitting") return event.preventDefault();
    draggedUploadId = state.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.id);
    row.classList.add("is-dragging");
  });
  handle.addEventListener("dragend", () => {
    draggedUploadId = "";
    row.classList.remove("is-dragging");
    document.querySelectorAll(".file-upload-row").forEach((entry) => entry.classList.remove("is-drop-target"));
  });
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key) || registrationBatch?.status === "submitting") return;
    event.preventDefault();
    const files = registrationBatch.files;
    const index = files.indexOf(state);
    const target = files[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (target) moveRegistrationUpload(state.id, target.id, event.key === "ArrowDown");
    handle.focus();
  });
  row.addEventListener("dragover", (event) => {
    if (!draggedUploadId || registrationBatch?.status === "submitting") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    row.classList.add("is-drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
  row.addEventListener("drop", (event) => {
    if (!draggedUploadId || registrationBatch?.status === "submitting") return;
    event.preventDefault();
    const bounds = row.getBoundingClientRect();
    moveRegistrationUpload(draggedUploadId, state.id, event.clientY > bounds.top + bounds.height / 2);
    row.classList.remove("is-drop-target");
  });
  return row;
}

function renderRegistrationUploads() {
  const list = document.querySelector("#upload-file-list");
  if (!list) return;
  const batch = registrationBatch;
  const submitting = batch?.status === "submitting";
  for (const state of batch?.files || []) {
    if (!state.row) state.row = createUploadRow(state);
    if (state.row.parentNode !== list) list.append(state.row);
    const row = state.row;
    const failed = state.status === "failed";
    row.querySelector(".file-upload-meter").classList.toggle("hidden", failed);
    row.querySelector(".file-upload-failed").classList.toggle("hidden", !failed);
    row.querySelector(".file-upload-status").title = failed ? `${state.error}；请删除后重新上传` : "";
    row.querySelector("progress").value = state.percent;
    row.querySelector("progress").title = `${state.percent}%`;
    row.querySelector(".file-upload-remove").disabled = Boolean(submitting);
    row.querySelector(".file-upload-drag").disabled = Boolean(submitting);
    row.querySelector(".file-upload-drag").draggable = !submitting;
  }
  document.querySelector("#file-input").disabled = Boolean(submitting);
  document.querySelector("#close-document-form").disabled = Boolean(submitting);
  document.querySelector("#register-document").disabled = !batch?.files.length || submitting || batch.files.some((state) => state.status !== "ready");
  document.querySelector("#registration-error").textContent = batch?.error || "";
}

function moveRegistrationUpload(id, targetId, after = false) {
  const batch = registrationBatch;
  if (!batch || batch.status === "submitting" || id === targetId) return;
  const source = batch.files.find((state) => state.id === id);
  if (!source || !batch.files.some((state) => state.id === targetId)) return;
  const files = batch.files.filter((state) => state !== source);
  files.splice(files.findIndex((state) => state.id === targetId) + Number(after), 0, source);
  batch.files = files;
  batch.error = "";
  const list = document.querySelector("#upload-file-list");
  files.forEach((state) => list.append(state.row));
  renderRegistrationUploads();
}

function cancelTemporaryUpload(state) {
  state.controller.abort();
  fetch(uploadUrl(state.id), { method: "DELETE", keepalive: true }).catch(() => {});
  state.row?.remove();
}

function removeRegistrationUpload(id) {
  const batch = registrationBatch;
  if (!batch || batch.status === "submitting") return;
  const state = batch.files.find((entry) => entry.id === id);
  if (!state) return;
  batch.files = batch.files.filter((entry) => entry !== state);
  cancelTemporaryUpload(state);
  batch.error = "";
  if (!batch.files.length) registrationBatch = null;
  renderRegistrationUploads();
}

function cancelRegistrationUpload() {
  const batch = registrationBatch;
  registrationBatch = null;
  draggedUploadId = "";
  if (batch) {
    batch.controller.abort();
    batch.files.forEach(cancelTemporaryUpload);
  }
  const input = document.querySelector("#file-input");
  if (input) input.value = "";
  renderRegistrationUploads();
}

function startRegistrationUploads(files) {
  if (registrationBatch?.status === "submitting") return;
  const selected = Array.from(files).filter((file) => file.name);
  if (!selected.length) return;
  if (!registrationBatch) registrationBatch = { id: newId(), files: [], status: "editing", controller: new AbortController(), error: "" };
  const states = selected.map((file) => ({ id: newId(), file, controller: new AbortController(), status: "uploading", percent: 0, error: "" }));
  registrationBatch.files.push(...states);
  registrationBatch.error = "";
  renderRegistrationUploads();
  return Promise.all(states.map(uploadRegistrationFile));
}

async function uploadRegistrationFile(state) {
  const file = state.file;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (state.controller.signal.aborted) return;
      state.percent = 0;
      renderRegistrationUploads();
      const initialized = await uploadRequest(endpoint("/data/api/uploads"), {
        method: "POST", signal: state.controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: state.id, fileName: file.name, size: file.size, mimeType: file.type || "application/octet-stream" }),
      });
      if (initialized.status !== "ready") await sendTemporaryFile(state);
      if (!isCurrentUpload(state)) return;
      state.status = "ready";
      state.percent = 100;
      renderRegistrationUploads();
      return;
    } catch (error) {
      if (state.controller.signal.aborted || !isCurrentUpload(state)) return;
      if (attempt === 2) {
        state.status = "failed";
        state.error = error.message;
        renderRegistrationUploads();
        return;
      }
      try { await waitForUploadRetry(UPLOAD_RETRY_DELAYS_MS[attempt], state.controller.signal); }
      catch { return; }
    }
  }
}

function acceptRegisteredDocument(payload) {
  const incoming = normalizeDocuments([payload.document])[0];
  if (!incoming?.processingTask?.backendManaged) throw new Error("服务端未确认登记成功");
  const index = documents.findIndex((item) => item.id === incoming.id);
  if (index < 0) documents.unshift(incoming); else documents[index] = incoming;
  if (formSheet?.dataset.shelfFolderId) moveShelfDocument(incoming.id, formSheet.dataset.shelfFolderId);
  selectedDocumentId = incoming.id;
  selectedPageId = incoming.pages[0]?.id || null;
  cacheCurrentState();
  registrationBatch = null;
  document.querySelector("#upload-file-list").replaceChildren();
  form.reset();
  renderRegistrationUploads();
  closeDocumentForm();
  startProcessingPolling(incoming);
  renderAll();
}

async function registerSelectedUploads() {
  const batch = registrationBatch;
  if (!batch?.files.length || batch.status === "submitting" || batch.files.some((state) => state.status !== "ready")) return;
  const fields = new FormData(form);
  const body = Object.fromEntries(["title", "author", "publisher", "year", "tags"].map((key) => [key, textValue(key)]));
  Object.assign(body, { uploadIds: batch.files.map((state) => state.id), coverVariant: getNextDocumentCoverVariant(), processingMode: normalizeProcessingMode(fields.get("processingMode")), processingChunkSize: clampChunkSize(fields.get("chunkSize")) });
  batch.status = "submitting";
  batch.error = "";
  renderRegistrationUploads();
  try {
    let result;
    try {
      result = await uploadRequest(uploadUrl(batch.id, "/register"), {
        method: "POST", signal: batch.controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } catch (error) {
      if (batch.controller.signal.aborted) return;
      const status = await uploadRequest(uploadUrl("registrations", `/${encodeURIComponent(batch.id)}`)).catch(() => null);
      if (status?.status !== "registered") throw error;
      result = status;
    }
    if (registrationBatch === batch) acceptRegisteredDocument(result);
  } catch (error) {
    if (registrationBatch !== batch) return;
    batch.status = "editing";
    batch.error = `合并登记失败：${error.message}。可调整文件后重新登记或取消。`;
    renderRegistrationUploads();
  }
}

window.addEventListener("pagehide", cancelRegistrationUpload);

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
  } else if (/语义索引失败/.test(base)) {
    label = "索引失败";
  } else if (/重建语义索引中/.test(base)) {
    label = "索引中";
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
// 登记从上传完成后开始：候选页 OCR 0→50%，元数据识别 50→100%。
// 保存记录、落库排队很短，不单独占用百分比；没有实测值时退回各阶段起点值。
const BACKEND_REGISTRATION_STAGES = {
  "": { percent: 0 },
  metadata_candidate: { percent: 0 },
  metadata: { percent: 50 },
};
const REGISTRATION_STAGE_RANGES = {
  metadata_candidate: { from: 0, to: 50 },
  metadata: { from: 50, to: 100 },
};

function describeBackendRegistration(item) {
  const registration = item.registration || {};
  if (registration.status === "failed") {
    return "登记失败，点击继续";
  }
  const task = item.processingTask || {};
  const live = task.registrationProgress;
  const range = live ? REGISTRATION_STAGE_RANGES[live.stage] : null;
  if (range) {
    const percent = range.from + (range.to - range.from) * (Number(live.percent) || 0) / 100;
    const detail = live.stage === "metadata_candidate" ? describeOcrProgressDetail(live.detail, true) : "";
    const ocr = live.stage === "metadata_candidate" ? `候选 OCR ${Math.round(Number(live.percent) || 0)}%` : "";
    return [`登记中 ${Math.round(percent)}%`, ocr, detail].filter(Boolean).join(" · ");
  }
  const stage = BACKEND_REGISTRATION_STAGES[task.currentPageStage || ""] || BACKEND_REGISTRATION_STAGES[""];
  return `登记中 ${stage.percent}%`;
}

function describeDocumentProcessingState(documentId) {
  const item = getLiveDocument(documentId);
  if (item?.processingTask?.backendManaged && item.registration?.status === "completed" && item.status === "排队中") return "排队中 100%";
  return item?.processingTask?.backendManaged && isDocumentRegistrationPending(item) ? describeBackendRegistration(item) : "";
}

function refreshDocumentCardStatusIndicators(documentId) {
  const uploadText = describeDocumentProcessingState(documentId);
  // 另一处来源是下载副本的后台重建进度（js/preparation.js）；上传/登记优先级更高。
  const preparationText = typeof describeDocumentPreparation === "function" ? describeDocumentPreparation(documentId) : "";
  const text = uploadText || preparationText;

  document.querySelectorAll(".book-card").forEach((card) => {
    if (card.dataset.documentId !== documentId) {
      return;
    }
    card.classList.toggle("is-preparing", Boolean(!uploadText && preparationText));
    const pages = card.querySelector(".book-pages");
    if (pages) {
      pages.classList.toggle("is-status", Boolean(text));
      if (text) {
        pages.textContent = shortenDocumentCardStatus(text);
        pages.title = text;
      } else {
        // 文案清空后必须把「N 页」放回去：进度来源（下载副本重建）消失时不会触发整列表重绘。
        pages.removeAttribute("title");
        const item = getLiveDocument(documentId);
        pages.textContent = `${item?.pages?.length || 0} 页`;
      }
    }
  });

  if (typeof selectedDocumentId === "string" && selectedDocumentId === documentId) {
    const item = getLiveDocument(documentId);
    renderReaderDetailActions(item, canEditDocument(item), readerDetailEditing);
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
