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
  // 忽略请求执行期间已被删除文献的响应。
  if (index < 0) return null;
  const previous = documents[index];
  const incoming = normalizeDocuments([payload.document])[0];
  if ((previous.processingTask?.revision || 0) > (incoming.processingTask?.revision || 0)) return previous;
  // 保留尚未同步的本地备注、文本和元数据编辑；服务端也会拦截过期的处理快照。
  // 轮询响应绝不能标记为本地编辑。
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
    // 浏览器或网络错误不能修改服务端负责的任务状态。
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
        showUploadToast(current?.status === "等候中" ? "原件已归档，当前等候中；无需保持浏览器打开。" : "后端正在准备登记，完成后正文按队列处理。");
      }
      return false;
    }
    return Boolean(current);
  }
  processingRecoveryInFlight.add(item.id);
  try {
    // 已归档原件可以直接交回后端，无需下载、重新执行 OCR 或创建第二个任务。
    // 只有中断的上传需要文件。
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

const PROCESSING_STAGE_CONFIG = [
  { key: "ocr", label: "文字识别", short: "识别", color: "ocr" },
  { key: "variant", label: "简繁转换", short: "简繁", color: "variant" },
  { key: "punctuation", label: "标点符号", short: "标点", color: "punctuation" },
  { key: "proofreading", label: "校对", short: "校对", color: "proofreading" },
];
let progressStageNodes = new Map();
let progressStageFills = new Map();
let progressTotalNode, progressModeNode, progressFailedNode, failedPageMarkers;

function setupCombinedProgress() {
  if (!streamProgress) return;
  streamStatus?.remove();
  progressStageNodes = new Map([...streamProgress.querySelectorAll("[data-progress-stage]")].map((node) => [node.dataset.progressStage, {
    root: node,
    pages: node.querySelector("[data-progress-pages]"),
    ring: node.querySelector("[data-progress-ring]"),
  }]));
  progressStageFills = new Map([...streamProgress.querySelectorAll("[data-progress-fill]")].map((node) => [node.dataset.progressFill, node]));
  progressTotalNode = streamProgress.querySelector("[data-progress-total]");
  progressModeNode = streamProgress.querySelector("[data-progress-mode]");
  progressFailedNode = streamProgress.querySelector("[data-progress-failed]");
  failedPageMarkers = streamProgress.querySelector("[data-progress-failed-pages]");
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

// 失败页统一用一个标题，条目只写两字阶段名 + 页码；完整报错在 title 提示里。
function renderFailedProcessingPages(item) {
  if (!failedPageMarkers || !progressFailedNode) return;
  const stages = Object.fromEntries(PROCESSING_STAGE_CONFIG.map((stage) => [stage.key, stage]));
  const failed = item.processingTask?.failedPages || [];
  failedPageMarkers.replaceChildren();
  progressFailedNode.classList.toggle("hidden", failed.length === 0);
  for (const entry of failed) {
    const stage = stages[entry.stage];
    const button = document.createElement("button");
    button.type = "button";
    button.className = `processing-failed-page is-${entry.stage || "proofreading"}`;
    button.textContent = `${stage?.short || "处理"} ${entry.pageNumber}`;
    // 悬停只显示失败原因（阶段名/页码看 chip 本身、跳转与删除看操作）；无原因则不设提示
    if (entry.message) {
      button.title = entry.message;
    }
    button.addEventListener("click", () => {
      const current = getLiveDocument(item.id);
      const page = current?.pages.find((pageEntry) => pageEntry.pageNumber === entry.pageNumber);
      if (!page) return;
      selectedDocumentId = current.id;
      selectedPageId = page.id;
      renderAll();
    });
    button.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      if (!canEditDocument(getLiveDocument(item.id))) return;
      if (!window.confirm(`确认删除第 ${entry.pageNumber} 页的失败页记录？该页已保存的识别和整理文字将被删除，归档原件不受影响。`)) return;
      try {
        await flushPendingSync();
        if (syncDirty) throw new Error("本地修改尚未同步，请稍后再删除。");
        const result = await requestBackendProcessing(item.id, { method: "DELETE", suffix: `/failed-pages/${entry.pageNumber}` });
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
  const total = Number(task.totalPages) || 0;
  const legacyProgress = {
    ocr: { done: Number(task.completedPages) || 0, total },
    variant: { done: 0, total },
    punctuation: { done: 0, total },
    proofreading: { done: Number(task.finalizedPages) || countFinalizedPages(item), total },
  };
  const progress = task.stageProgress || legacyProgress;
  const finished = task.status === "已完成";
  streamProgress?.classList.remove("hidden");
  if (progressTotalNode) progressTotalNode.textContent = `${total}`;
  if (progressModeNode) progressModeNode.textContent = task.mode === "parallel" ? "并行" : "串行";
  for (const stage of PROCESSING_STAGE_CONFIG) {
    const nodes = progressStageNodes.get(stage.key);
    const fill = progressStageFills.get(stage.key);
    const entry = progress[stage.key] || legacyProgress[stage.key];
    const done = Math.min(total, Number(entry?.done) || 0);
    const percent = total > 0 ? done / total * 100 : 0;
    const active = Boolean(task.activeStages?.[stage.key]);
    if (fill) fill.style.width = `${clampPercent(percent)}%`;
    if (nodes) {
      if (nodes.pages) nodes.pages.textContent = `${done}`;
      setRingProgress(nodes.ring, finished ? 100 : active ? 5 : percent);
    }
  }
  renderFailedProcessingPages(item);
}
