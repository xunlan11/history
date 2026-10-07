// 后端调度正文；浏览器轮询只用于显示，不触发 OCR/LLM 执行。
const PROCESSING_POLL_INTERVAL_MS = 1500;
const processingPollTimers = new Map();
const processingPollInFlight = new Set();
const processingRecoveryInFlight = new Set();

function isProcessingTaskPending(item) {
  const task = item?.processingTask;
  return Boolean(task?.backendManaged && !["已完成", "处理失败", "已取消"].includes(task.status));
}

function stopProcessingPolling(documentId) {
  const timer = processingPollTimers.get(documentId);
  if (timer) window.clearInterval(timer);
  processingPollTimers.delete(documentId);
}

function stopDocumentProcessing(documentId) {
  stopProcessingPolling(documentId);
  processingRecoveryInFlight.delete(documentId);
}

function startProcessingPolling(item) {
  if (!item?.id || !item.processingTask?.backendManaged) return;
  stopProcessingPolling(item.id);
  const timer = window.setInterval(() => {
    const current = getLiveDocument(item.id);
    if (!current) return stopProcessingPolling(item.id);
    refreshProcessingDocument(current, { silent: true });
  }, PROCESSING_POLL_INTERVAL_MS);
  processingPollTimers.set(item.id, timer);
}

function applyBackendProcessingDocument(documentId, payload) {
  if (!payload?.document || payload.document.id !== documentId) throw new Error("后端未返回有效的文献状态。");
  const index = documents.findIndex((entry) => entry.id === documentId);
  // Ignore responses for documents removed while the request was in flight.
  if (index < 0) return null;
  const previous = documents[index];
  const incoming = normalizeDocuments([payload.document])[0];
  if ((previous.processingTask?.revision || 0) > (incoming.processingTask?.revision || 0)) return previous;
  // Preserve unsynced local notes/text/metadata edits; the server also fences
  // stale processing snapshots. Never mark a polling response as a local edit.
  if (typeof syncDirty !== "undefined" && syncDirty) {
    for (const key of ["title", "author", "year", "publisher", "tags", "visibility"]) {
      const baseline = previous.processingTask?.metadataSnapshot;
      if (previous[key] !== undefined && (!baseline || !(key in baseline) || previous[key] !== baseline[key])) incoming[key] = previous[key];
    }
    const localPages = new Map(previous.pages.map((page) => [page.id, page]));
    for (const page of incoming.pages) {
      const local = localPages.get(page.id);
      if (!local) continue;
      page.notes = local.notes || "";
      if (local.llmDone && local.processingRevision === page.processingRevision) {
        page.cleanText = local.cleanText;
        page.punctuatedText = local.punctuatedText;
      }
    }
  }
  documents[index] = incoming;
  cacheCurrentState();
  return incoming;
}

async function requestBackendProcessing(documentId, options = {}) {
  const response = await fetch(`${DATA_PROCESSING_URL}/${encodeURIComponent(documentId)}/processing${options.suffix || ""}`, {
    cache: "no-store", method: options.method || "GET",
    ...(options.body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).detail || ""; } catch {}
    const error = new Error(typeof detail === "string" && detail ? detail : `后端任务请求失败：${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function submitBackendDocument(item) {
  const result = await requestBackendProcessing(item.id, {
    method: "POST", body: { mode: item.processingMode === "parallel" ? "parallel" : "serial" },
  });
  return applyBackendProcessingDocument(item.id, result);
}

async function refreshProcessingDocument(item, options = {}) {
  if (!item?.processingTask?.backendManaged || processingPollInFlight.has(item.id)) return;
  processingPollInFlight.add(item.id);
  try {
    const result = await requestBackendProcessing(item.id);
    const current = applyBackendProcessingDocument(item.id, result);
    if (!current) return;
    if (!isProcessingTaskPending(current)) stopProcessingPolling(current.id);
    if (typeof renderAll === "function") renderAll();
  } catch (error) {
    // Browser/network errors do not mutate server-owned job states.
    if ([401, 403, 404].includes(error.status)) stopProcessingPolling(item.id);
    if (!options.silent && typeof showUploadToast === "function") showUploadToast(error.message);
  } finally {
    processingPollInFlight.delete(item.id);
  }
}

async function resumeMissingProcessingTask(item, options = {}) {
  if (!canEditDocument(item) || processingRecoveryInFlight.has(item.id) || isDocumentUploadActive(item.id)) return false;
  if (item.processingTask?.backendManaged) {
    if (options.interactive && item.registration?.status === "failed") {
      if (!window.confirm("登记处理失败。是否重试失败阶段？已保存成果和原件会保留，处理方式不会改变。")) return false;
      applyBackendProcessingDocument(item.id, await requestBackendProcessing(item.id, { method: "POST", suffix: "/retry" }));
    } else {
      await refreshProcessingDocument(item, { silent: !options.interactive });
    }
    const current = getLiveDocument(item.id);
    if (current && isProcessingTaskPending(current)) startProcessingPolling(current);
    if (isDocumentRegistrationPending(current)) {
      if (options.interactive && typeof showUploadToast === "function") {
        showUploadToast(current?.status === "等待服务恢复" ? "原件已归档，后端等待服务恢复；无需保持浏览器打开。" : "后端正在准备登记，完成后正文按队列处理。");
      }
      return false;
    }
    return Boolean(current);
  }
  processingRecoveryInFlight.add(item.id);
  try {
    // An archived source can be handed back to the backend without download,
    // rerunning OCR or creating a second task. Only interrupted uploads need a file.
    if (item.fileUrl) {
      await saveRegistrationCheckpoint(item.id);
      const current = await submitBackendDocument(getRegistrationDocument(item.id));
      if (current) startProcessingPolling(current);
      return current && !isDocumentRegistrationPending(current);
    }
    const stashed = await readPendingUpload(item.id);
    const file = stashed ? pendingUploadToFile(stashed) : null;
    if (!file) {
      updateDocumentUploadState(item.id, { active: false, error: "原件上传未完成，请重新导入原件" }, { force: true });
      return false;
    }
    await runDocumentUploadPipeline(item, file);
    return !isDocumentRegistrationPending(getLiveDocument(item.id));
  } catch (error) {
    if (options.interactive && !error.registrationCancelled && typeof showUploadToast === "function") showUploadToast(error.message);
    return false;
  } finally {
    processingRecoveryInFlight.delete(item.id);
  }
}

// 非正文的对话/检索仍使用原 LLM API，不参与文献正文调度。
async function requestLlmTask(path, payload, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 0;
  const controller = timeoutMs > 0 && typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : 0;
  try {
    const response = await fetch(`${LLM_SERVICE_URL}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("大模型请求超时，请稍后重试。");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function buildLlmMetadata(item) {
  return { title: item.title || "", author: item.author || "", year: item.year || "", publisher: item.publisher || "" };
}

let streamProgressMainFill, streamProgressSubFill, streamProgressOcrPages, streamProgressLlmPages;
let streamProgressTotalNodes, streamOcrMarker, streamLlmMarker, streamOcrRingFill, streamLlmRingFill;
let backendProgressStatus, failedPageMarkers;

function setupCombinedProgress() {
  if (!streamProgress) return;
  streamStatus?.remove();
  streamProgressMainFill = streamProgress.querySelector(".progress-fill-ocr");
  streamProgressSubFill = streamProgress.querySelector(".progress-fill-llm");
  streamProgressOcrPages = streamProgress.querySelector(".progress-ocr-pages");
  streamProgressLlmPages = streamProgress.querySelector(".progress-llm-pages");
  streamProgressTotalNodes = streamProgress.querySelectorAll(".progress-total-pages");
  streamOcrMarker = streamProgress.querySelector(".progress-marker-ocr");
  streamLlmMarker = streamProgress.querySelector(".progress-marker-llm");
  streamOcrRingFill = streamProgress.querySelector(".progress-ring-fill-ocr");
  streamLlmRingFill = streamProgress.querySelector(".progress-ring-fill-llm");
  backendProgressStatus = document.createElement("p");
  backendProgressStatus.className = "backend-processing-status";
  backendProgressStatus.setAttribute("aria-live", "polite");
  failedPageMarkers = document.createElement("div");
  failedPageMarkers.className = "processing-failed-pages";
  streamProgress.append(backendProgressStatus, failedPageMarkers);
}
setupCombinedProgress();

function clampPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
}
function setRingProgress(node, percent) {
  if (!node) return;
  const length = typeof node.getTotalLength === "function" ? node.getTotalLength() : 97.39;
  node.style.strokeDasharray = `${length}`;
  node.style.strokeDashoffset = `${length * (1 - clampPercent(percent) / 100)}`;
}
function setMarkerPosition(node, percent) {
  if (node) node.style.left = `${Math.min(88, Math.max(4, clampPercent(percent)))}%`;
}

function renderFailedProcessingPages(item) {
  if (!failedPageMarkers) return;
  failedPageMarkers.replaceChildren();
  for (const failed of item.processingTask?.failedPages || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `processing-failed-page is-${failed.stage === "ocr" ? "ocr" : "llm"}`;
    button.textContent = `${failed.stage === "ocr" ? "识别" : "整理"}失败：第 ${failed.pageNumber} 页`;
    button.title = `${failed.message || "处理失败"}；左键跳转，右键删除失败页`;
    button.addEventListener("click", () => {
      const current = getLiveDocument(item.id);
      const page = current?.pages.find((entry) => entry.pageNumber === failed.pageNumber);
      if (!page) return;
      selectedDocumentId = current.id;
      selectedPageId = page.id;
      renderAll();
    });
    button.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      if (!canEditDocument(getLiveDocument(item.id))) return;
      if (!window.confirm(`确认删除第 ${failed.pageNumber} 页的失败页记录？该页已保存的识别和整理文字将被删除，归档原件不受影响。`)) return;
      try {
        await flushPendingSync();
        if (syncDirty) throw new Error("本地修改尚未同步，请稍后再删除。");
        const result = await requestBackendProcessing(item.id, { method: "DELETE", suffix: `/failed-pages/${failed.pageNumber}` });
        const current = applyBackendProcessingDocument(item.id, result);
        if (current) ensureSelectedPage(current);
        renderAll();
      } catch (error) {
        window.alert(error.message);
      }
    });
    failedPageMarkers.append(button);
  }
}

function renderStreamProgress(item) {
  const task = item?.processingTask;
  if (!item || !task) {
    streamProgress?.classList.add("hidden");
    return;
  }
  const total = task.totalPages || 0;
  const ocrDone = Math.min(total, Number(task.completedPages) || 0);
  const finalized = Math.min(total, Number(task.finalizedPages) || countFinalizedPages(item));
  const finished = task.status === "已完成";
  const ocrPercent = total > 0 ? ocrDone / total * 100 : 0;
  const llmPercent = total > 0 ? finalized / total * 100 : 0;
  streamProgress?.classList.remove("hidden");
  if (streamProgressMainFill) streamProgressMainFill.style.width = `${clampPercent(ocrPercent)}%`;
  if (streamProgressSubFill) streamProgressSubFill.style.width = `${clampPercent(llmPercent)}%`;
  if (streamProgressOcrPages) streamProgressOcrPages.textContent = `${ocrDone}`;
  if (streamProgressLlmPages) streamProgressLlmPages.textContent = `${finalized}`;
  streamProgressTotalNodes?.forEach((node) => { node.textContent = `${total}`; });
  setMarkerPosition(streamLlmMarker, llmPercent);
  setMarkerPosition(streamOcrMarker, ocrPercent);
  // No browser timers simulate processing or drive execution.
  setRingProgress(streamOcrRingFill, finished ? 100 : task.activeStages?.ocr ? 5 : ocrPercent);
  setRingProgress(streamLlmRingFill, finished ? 100 : task.activeStages?.llm ? 5 : llmPercent);
  if (backendProgressStatus) {
    const mode = task.mode === "parallel" ? "并行" : "串行";
    backendProgressStatus.textContent = `${mode} · ${getProcessingTaskLabel(item)}${task.status === "等待服务恢复" ? "（后端自动续跑，无需保持浏览器打开）" : ""}`;
  }
  renderFailedProcessingPages(item);
}
