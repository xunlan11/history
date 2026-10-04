const PROCESSING_POLL_INTERVAL_MS = 1500;
// 封面判断是后台任务（OCR 完成前就能先给出封面），给大模型一个上限，避免一直挂着。
const COVER_RECOGNITION_TIMEOUT_MS = 90000;
// 仅大模型整理队列按页码顺序执行；OCR 在后端独立连续推进，不等待大模型。
const PROCESSING_LLM_MAX_CONCURRENT = 1;
const processingPollTimers = new Map();
const processingLlmStates = new Map();
const metadataAutoTriggered = new Set();
const processingRecoveryInFlight = new Set();
const coverRecognitionInFlight = new Set();

function isProcessingTaskPending(item) {
  const task = item?.processingTask;
  if (!task?.remoteTaskId) {
    return false;
  }

  return ["提交中", "排队中", "处理中", "准备中"].includes(task.status);
}

function stopProcessingPolling(documentId) {
  const timer = processingPollTimers.get(documentId);
  if (timer) {
    window.clearInterval(timer);
    processingPollTimers.delete(documentId);
  }
}

// 文献被删除时调用：停轮询、把还没跑的整页整理任务丢掉，
// 别让已经不存在的文献继续占着大模型（单路执行，会拖住后登记的文献）。
function stopDocumentProcessing(documentId) {
  if (!documentId) {
    return;
  }

  stopProcessingPolling(documentId);

  const state = processingLlmStates.get(documentId);
  if (state) {
    if (state.queue.length) {
      state.queue = state.queue.filter((entry) => entry.item?.id !== documentId);
    }
    if (!state.inFlight) {
      processingLlmStates.delete(documentId);
    }
  }

  metadataAutoTriggered.delete(documentId);
  processingRecoveryInFlight.delete(documentId);
  coverRecognitionInFlight.delete(documentId);

  if (streamLlmRingItem?.id === documentId) {
    stopLlmRingTimer();
    streamLlmRingPercent = 0;
    streamSubState = { pageNumber: null, text: "", percent: 0, active: false };
  }
}

// 逐页任务没提交成功时的恢复入口：
//   1. 浏览器里还暂存着原件（上传被打断）→ 直接续传整条上传流水线；
//   2. 原件已归档、只是逐页任务没提交上→ 从服务端取回原件重新提交；
//   3. 两者都没有 → 明确提示「原件上传未完成，请重新导入」，不再静默卡住。
async function resumeMissingProcessingTask(item) {
  if (
    !canEditDocument(item) ||
    item?.processingTask?.remoteTaskId ||
    isDocumentUploadActive(item.id) ||
    processingRecoveryInFlight.has(item.id)
  ) {
    return;
  }

  processingRecoveryInFlight.add(item.id);
  try {
    const stashed = await readPendingUpload(item.id);
    const file = stashed ? pendingUploadToFile(stashed) : await downloadArchivedSource(item);
    if (!file) {
      if (!item.processingTask || isDocumentUploadActive(item.id)) {
        return;
      }
      updateDocumentUploadState(
        item.id,
        { active: false, error: "原件未上传完成，请重新导入" },
        { force: true },
      );
      if (streamStatus) {
        streamStatus.textContent = "原件上传未完成，请重新导入原件";
      }
      return;
    }

    await runDocumentUploadPipeline(item, file);
  } catch (error) {
    const target = getLiveDocument(item.id) || item;
    if (target.processingTask) {
      target.processingTask.status = "提交失败";
      target.processingTask.message = error?.message || "无法恢复逐页处理任务。";
    }
    target.status = "逐页处理提交失败";
    target.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  } finally {
    processingRecoveryInFlight.delete(item.id);
  }
}

async function downloadArchivedSource(item) {
  if (!item?.fileUrl) {
    return null;
  }

  const response = await fetch(item.fileUrl, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  const blob = await response.blob();
  return new File([blob], item.fileName || item.processingTask?.sourceFileName || "document", {
    type: item.fileMimeType || blob.type || "application/octet-stream",
  });
}

// 上传流水线：原件归档 → 逐页任务提交（登记只在等这两段，各占一半进度）。
// 开始前先把原件暂存进 IndexedDB；封面识别等“识别”类工作全部放在登记之后后台跑，
// 不阻塞进入阅读页（大模型在 CPU 上可能要几分钟）。任一环节失败/页面被刷新，
// 下次打开页面时 resumeMissingProcessingTask() 会从暂存里接着传，不会丢原件。
async function runDocumentUploadPipeline(item, file) {
  if (!canEditDocument(item)) {
    throw new Error("当前用户没有该文献的编辑权限，无法上传原件。请重新登录后重试。");
  }
  if (!file || !file.name) {
    throw new Error("没有可上传的原件文件。");
  }

  const documentId = item.id;
  // 服务端快照同步会整体替换 documents 数组，这里始终取数组里的当前实例。
  const liveItem = () => documents.find((entry) => entry.id === documentId) || item;

  if (!item.processingTask) {
    item.processingTask = createProcessingTask(file);
  }

  beginDocumentUpload(item, file);
  item.status = "提交逐页处理中";
  item.updatedAt = new Date().toISOString();
  persist();
  renderAll();

  try {
    await stashPendingUpload(documentId, file);

    setUploadStage(documentId, 0, "上传原件", 0);
    await archiveDocumentSource(liveItem(), file, (fraction) => {
      setUploadStage(documentId, 0, "上传原件", fraction);
    });

    setUploadStage(documentId, 1, "提交逐页任务", 0);
    await submitProcessingTask(liveItem(), file, (fraction) => {
      setUploadStage(documentId, 1, "提交逐页任务", fraction);
    });

    // 到这一步登记就算完成了（原件已归档、逐页任务已提交），可以进阅读页。
    // 封面识别要跑大模型（CPU 上可能几分钟），一律放到阅读页后台做，
    // 所以暂存的原件先不删：resumePendingRecognition() 还要用它。
    markDocumentUploadFinished(documentId);
    return true;
  } catch (error) {
    // 4xx 是永久性拒绝（体积超限 / 无权限），不再保留暂存反复重试。
    const status = Number(error?.status) || 0;
    if (status >= 400 && status < 500) {
      await dropPendingUpload(documentId);
    }
    markDocumentUploadFailed(documentId, error);
    const current = liveItem();
    current.status = summarizeDocumentStatus(current);
    current.updatedAt = new Date().toISOString();
    persist();
    renderAll();
    throw error;
  }
}

// 登记只等【原件归档】+【逐页任务提交】两段，各占一半进度。
function setUploadStage(documentId, stageIndex, stage, fraction) {
  const total = 2;
  const percent = Math.min(100, Math.max(0, ((stageIndex + (Number(fraction) || 0)) / total) * 100));
  updateDocumentUploadState(documentId, { active: true, stageIndex, stage, percent });
}

// 封面识别：不属于登记流程，登记完成后在任意页面后台跑（用浏览器暂存的原件）。
// 单页残片这类没有标题信息的文件也走同一条路：识别不到就置为未识别，不影响文献本身。
async function resumePendingRecognition(item) {
  const target = getLiveDocument(item.id) || item;
  if (!canEditDocument(target) || isDocumentUploadActive(target.id) || coverRecognitionInFlight.has(target.id)) {
    return;
  }

  if (target.coverImageDataUrl || target.coverImageUrl) {
    await dropPendingUpload(target.id);
    return;
  }

  const record = await readPendingUpload(target.id);
  const file = pendingUploadToFile(record);
  if (!file) {
    if (target.coverStatus === "正在识别封面") {
      target.coverStatus = "未识别到封面";
      target.updatedAt = new Date().toISOString();
      persist();
      renderAll();
    }
    return;
  }

  coverRecognitionInFlight.add(target.id);
  try {
    await detectDocumentCover(getLiveDocument(target.id) || target, file);
  } catch (error) {
    // 封面只是书架展示，失败不影响文献与识别结果。
  } finally {
    coverRecognitionInFlight.delete(target.id);
    await dropPendingUpload(target.id);
  }
}

function startProcessingPolling(item) {
  if (!item?.id || !canEditDocument(item)) {
    return;
  }

  stopProcessingPolling(item.id);
  const timer = window.setInterval(() => {
    const current = documents.find((entry) => entry.id === item.id);
    if (!current) {
      stopProcessingPolling(item.id);
      return;
    }

    refreshProcessingDocument(current, { silent: true });
  }, PROCESSING_POLL_INTERVAL_MS);
  processingPollTimers.set(item.id, timer);
}

// ---- 逐页流水线：OCR 是生产者，大模型整理队列是消费者 ----
// OCR 可领先任意多页；大模型只要求目标页已完成 OCR，并按页码顺序消费结果。

function getProcessingLlmState(documentId) {
  if (!processingLlmStates.has(documentId)) {
    processingLlmStates.set(documentId, { inFlight: 0, queue: [], attempted: 0 });
  }
  return processingLlmStates.get(documentId);
}

function isProcessingPageOcrReady(page) {
  return Boolean(page.ocrText) && page.status !== "待整理";
}

function isProcessingPageFinalized(page) {
  return Boolean(page.cleanText) ||
    ["已生成整理稿", "正在生成整理稿", "生成失败"].includes(page.status);
}

// 页 id → 本次页面会话里的整理尝试次数（刷新页面会重置）
const finalizeAttempts = new Map();
// 「生成失败」最多自动重试几次：中途刷新/网络抖动导致的失败不该让整理文本永远空着
const FINALIZE_MAX_ATTEMPTS = 3;

// 返回是否真的排进了队列。
function enqueueProcessingFinalize(item, page) {
  if (!canEditDocument(item) || !page || !isProcessingPageOcrReady(page)) {
    return false;
  }

  const attempts = finalizeAttempts.get(page.id) || 0;
  if (isProcessingPageFinalized(page)) {
    // 只有「生成失败」且没超次数才重试，其余（有整理稿/正在跑）一律不重复排队。
    if (page.status !== "生成失败" || attempts >= FINALIZE_MAX_ATTEMPTS) {
      return false;
    }
  }

  finalizeAttempts.set(page.id, attempts + 1);
  page.status = "正在生成整理稿";
  const state = getProcessingLlmState(item.id);
  state.queue.push({ item, page });
  state.queue.sort((a, b) => a.page.pageNumber - b.page.pageNumber);
  drainProcessingLlmQueue(item.id);
  return true;
}

function drainProcessingLlmQueue(documentId) {
  const state = processingLlmStates.get(documentId);
  if (!state) {
    return;
  }

  while (state.inFlight < PROCESSING_LLM_MAX_CONCURRENT && state.queue.length) {
    const next = state.queue.shift();
    // 文献已经被删除（可能来自其它标签页）：丢掉该项，不要占用大模型。
    if (!documents.some((entry) => entry.id === next.item?.id)) {
      continue;
    }
    state.inFlight += 1;
    state.attempted += 1;
    startLlmPageProgress(next.item, next.page.pageNumber);
    renderStreamProgress(next.item);
    finalizeProcessingPage(next.item, next.page).finally(() => {
      state.inFlight -= 1;
      if (state.queue.length) {
        drainProcessingLlmQueue(documentId);
      } else {
        refreshProcessingLlmProgress(next.item);
      }
    });
  }
}

async function finalizeProcessingPage(item, page) {
  if (!canEditDocument(item)) return;
  const livePage = () => {
    const target = getLiveDocument(item.id) || item;
    return target.pages.find((candidate) => candidate.id === page.id) || page;
  };
  try {
    const result = await requestFinalTextForPage(item, page);
    if (result.ready) {
      applyFinalTextResult(getLiveDocument(item.id) || item, livePage(), result);
    } else {
      livePage().status = "生成失败";
    }
  } catch (error) {
    livePage().status = "生成失败";
  }

  const target = getLiveDocument(item.id) || item;
  target.status = summarizeDocumentStatus(target);
  target.updatedAt = new Date().toISOString();
  persist();
}

function refreshProcessingLlmProgress(item) {
  const state = processingLlmStates.get(item.id);
  if (state && (state.inFlight > 0 || state.queue.length > 0)) {
    renderStreamProgress(item);
    if (streamStatus) streamStatus.textContent = getProcessingTaskLabel(item);
    return;
  }

  clearStreamSubProgress();
  renderStreamProgress(item);
  if (streamStatus) streamStatus.textContent = getProcessingTaskLabel(item);
  maybeFinishProcessingPipeline(item);
}

function enqueueNewProcessingPages(item) {
  if (!canEditDocument(item)) return false;
  let count = 0;
  item.pages.forEach((page) => {
    if (isProcessingPageOcrReady(page) && enqueueProcessingFinalize(item, page)) {
      count += 1;
    }
  });
  return count > 0;
}

function isProcessingLlmComplete(item) {
  const task = item.processingTask;
  if (!task) {
    return false;
  }

  const total = task.totalPages || 0;
  if (!total) {
    return false;
  }

  const state = processingLlmStates.get(item.id);
  if (!state) {
    return true;
  }

  if (state.inFlight > 0 || state.queue.length > 0) {
    return false;
  }

  const needs = item.pages.filter((page) => isProcessingPageOcrReady(page)).length;
  return state.attempted >= needs;
}

function maybeFinishProcessingPipeline(item) {
  const task = item.processingTask;
  if (!task) {
    return;
  }

  const ocrDone = ["已完成", "已回填"].includes(task.status);
  if (!ocrDone || !isProcessingLlmComplete(item)) {
    return;
  }

  stopProcessingPolling(item.id);
  renderAll();
}

function triggerProcessingMetadata(item) {
  if (!canEditDocument(item) || metadataAutoTriggered.has(item.id)) {
    return;
  }

  const candidate = collectMetadataCandidateText(item);
  if (!candidate) {
    return;
  }

  metadataAutoTriggered.add(item.id);
  autoExtractDocumentMetadata(item, candidate, item.pages[0], "ocr");
}

async function submitProcessingTask(item, file, onProgress) {
  if (!canEditDocument(item)) {
    throw new Error("当前用户没有该文献的编辑权限，无法提交处理任务。请重新登录后重试。");
  }
  try {
    const body = new FormData();
    body.append("document", file, file.name);
    body.append("documentId", item.id);
    body.append("title", item.title || file.name);

    const result = await postFormDataWithProgress(OCR_STREAM_SERVICE_URL, body, { onProgress });

    if (!result) {
      throw new Error("处理服务返回空响应，文献未进入处理队列。");
    }

    const remoteTaskId = result.taskId || result.id;
    if (!remoteTaskId) {
      throw new Error("处理服务未返回任务编号，文献未进入处理队列。");
    }

    // 上传/识别期间可能发生过服务端快照同步，必须写回数组里的当前实例。
    const target = getLiveDocument(item.id) || item;
    target.processingTask = {
      ...target.processingTask,
      remoteTaskId,
      status: result.status || "处理中",
      submittedAt: new Date().toISOString(),
      totalPages: Number(result.totalPages) || target.processingTask.totalPages || 0,
      completedPages: Number(result.completedPages) || 0,
      currentPage: Number(result.currentPage) || 0,
      currentPageStage: result.currentPageStage || "",
      currentPageProgress: Number(result.currentPageProgress) || 0,
      message: result.message || "已提交逐页流式处理任务",
    };

    if (Array.isArray(result.pages) && result.pages.length) {
      mergeProcessingPages(target, result.pages);
      target.processingTask.status = result.status || "已回填";
      target.processingTask.finishedAt = result.finishedAt || new Date().toISOString();
      triggerProcessingMetadata(target);
    }

    target.status = target.processingTask.status;
    target.updatedAt = new Date().toISOString();
    persist();
    renderAll();

    if (isProcessingTaskPending(target)) {
      startProcessingPolling(target);
    } else if (["已完成", "已回填"].includes(target.processingTask.status)) {
      enqueueNewProcessingPages(target);
      maybeFinishProcessingPipeline(target);
    }
  } catch (error) {
    const target = getLiveDocument(item.id) || item;
    target.processingTask = {
      ...target.processingTask,
      status: "提交失败",
      message: error && error.message
        ? error.message
        : "无法连接逐页处理服务，请确认服务端识别能力已部署后重新导入。",
    };
    target.status = "逐页处理提交失败";
    target.updatedAt = new Date().toISOString();
    persist();
    renderAll();
    throw error instanceof Error ? error : new Error("逐页处理任务提交失败。");
  }
}

async function refreshProcessingDocument(item, options = {}) {
  if (!canEditDocument(item)) return;
  const taskId = item.processingTask?.remoteTaskId;
  if (!taskId) {
    if (item.fileUrl) {
      await resumeMissingProcessingTask(item);
    } else if (!options.silent && streamStatus) {
      streamStatus.textContent = "等待处理任务提交...";
    }
    return;
  }

  if (!options.silent) {
    if (streamStatus) streamStatus.textContent = "正在刷新...";
  }

  try {
    const response = await fetch(`${OCR_STREAM_SERVICE_URL}/${encodeURIComponent(taskId)}`);
    if (!response.ok) {
      throw new Error(`Streaming OCR refresh failed: ${response.status}`);
    }

    const result = await response.json();
    const previous = item.processingTask || {};
    item.processingTask = {
      ...previous,
      status: result.status || previous.status,
      totalPages: Number(result.totalPages) || previous.totalPages || 0,
      completedPages: Number(result.completedPages) || 0,
      currentPage: Number(result.currentPage) || 0,
      currentPageStage: result.currentPageStage || "",
      currentPageProgress: Number(result.currentPageProgress) || 0,
      message: result.message || previous.message,
      finishedAt: result.finishedAt || previous.finishedAt,
    };

    const ocrFailed = ["处理失败", "提交失败"].includes(item.processingTask.status);
    const ocrDone = ["已完成", "已回填"].includes(item.processingTask.status);

    if (Array.isArray(result.pages) && result.pages.length) {
      const added = mergeProcessingPages(item, result.pages);
      if (ocrDone) {
        item.processingTask.finishedAt = result.finishedAt || new Date().toISOString();
      }

      // 将新识别页加入大模型队列；OCR 不等待队列处理，继续识别后续页。
      const hasPending = enqueueNewProcessingPages(item);
      if (added || hasPending || ocrDone) {
        triggerProcessingMetadata(item);
      }
    }

    item.status = item.processingTask.status;
    item.updatedAt = new Date().toISOString();
    persist();

    if (ocrFailed) {
      stopProcessingPolling(item.id);
      renderAll();
      return;
    }

    if (ocrDone) {
      // OCR 已完成，停止轮询；剩余工作由前端大模型队列继续推进。
      stopProcessingPolling(item.id);
      maybeFinishProcessingPipeline(item);
      if (!isProcessingLlmComplete(item)) {
        renderStreamProgress(item);
        if (streamStatus) streamStatus.textContent = getProcessingTaskLabel(item);
      }
      return;
    }

    renderStreamProgress(item);
    if (streamStatus) streamStatus.textContent = getProcessingTaskLabel(item);
  } catch (error) {
    if (streamStatus) streamStatus.textContent = "刷新失败";
    if (!options.silent) {
      alert("暂时无法刷新处理结果。请确认逐页处理服务与服务端识别能力均可用。");
    }
  }
}

function collectMetadataCandidateText(item) {
  return item.pages
    .slice()
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .slice(0, 3)
    .map((page) => page.ocrText || page.cleanText || page.punctuatedText || "")
    .filter(Boolean)
    .join("\n\n");
}
async function requestLlmTask(path, payload, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 0;
  const controller = timeoutMs > 0 && typeof AbortController === "function"
    ? new AbortController()
    : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : 0;

  try {
    const response = await fetch(`${LLM_SERVICE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status}`);
    }

    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

async function requestFinalTextForPage(item, page) {
  const previousPages = item.pages
    .filter((candidate) => candidate.pageNumber < page.pageNumber)
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .filter((candidate) => candidate.cleanText || candidate.punctuatedText)
    .slice(-2)
    .map((candidate) => ({
      pageNumber: candidate.pageNumber,
      text: candidate.punctuatedText || candidate.cleanText,
    }));

  return requestLlmTask("/finalize-page", {
    documentId: item.id,
    pageId: page.id,
    pageNumber: page.pageNumber,
    metadata: buildLlmMetadata(item),
    ocrText: page.ocrText || "",
    cleanText: page.cleanText || "",
    punctuatedText: page.punctuatedText || "",
    previousPages,
  });
}

function applyFinalTextResult(item, page, result) {
  if (result.cleanText) {
    page.cleanText = result.cleanText.trim();
  }

  if (result.punctuatedText) {
    page.punctuatedText = result.punctuatedText.trim();
  }

  page.status = "已生成整理稿";
  page.updatedAt = new Date().toISOString();
  item.status = summarizeDocumentStatus(item);
  item.updatedAt = new Date().toISOString();
}

async function autoExtractDocumentMetadata(item, text, page, source = "ocr") {
  if (!item || !canEditDocument(item) || !text || !needsMetadataAutoFill(item)) {
    return;
  }

  const startTarget = getLiveDocument(item.id) || item;
  startTarget.metadataStatus = "正在自动识别";
  startTarget.updatedAt = new Date().toISOString();
  persist();
  renderAll();

  try {
    const result = await requestLlmTask("/extract-metadata", {
      documentId: item.id,
      pageId: page?.id || "",
      pageNumber: page?.pageNumber || null,
      metadata: buildLlmMetadata(item),
      text: text.slice(0, 6000),
      source,
    });

    const target = getLiveDocument(item.id) || item;
    if (!result.ready || !result.metadata) {
      target.metadataStatus = "自动识别未连接";
      target.updatedAt = new Date().toISOString();
      persist();
      renderAll();
      return;
    }

    const changed = applyExtractedMetadata(target, result.metadata);
    target.metadataStatus = changed ? "已自动识别" : "未识别到文献信息";
    target.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  } catch (error) {
    const target = getLiveDocument(item.id) || item;
    target.metadataStatus = "自动识别失败";
    target.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  }
}

// 封面识别不在登记流程里等待：登记完成后由 resumePendingRecognition() 在后台调用。
// 这里要传原图给服务端渲染/归一化，再让大模型判断是否“像封面”。
async function detectDocumentCover(item, file, onProgress) {
  if (!item || !canEditDocument(item) || !file || !file.name) {
    return;
  }

  const initialTarget = getLiveDocument(item.id) || item;
  initialTarget.coverStatus = "正在识别封面";
  initialTarget.updatedAt = new Date().toISOString();
  persist();
  renderAll();

  try {
    const candidate = await requestCoverCandidate(file, onProgress);
    if (!candidate.imageDataUrl) {
      const target = getLiveDocument(item.id) || item;
      target.coverStatus = "未提取到候选封面";
      target.updatedAt = new Date().toISOString();
      persist();
      renderAll();
      return;
    }

    const result = await requestLlmTask("/detect-cover", {
      imageDataUrl: candidate.imageDataUrl,
      fileName: file.name,
      metadata: buildLlmMetadata(item),
    }, { timeoutMs: COVER_RECOGNITION_TIMEOUT_MS });

    const target = getLiveDocument(item.id) || item;
    if (result.ready && result.hasCover) {
      target.coverImageDataUrl = candidate.imageDataUrl;
      target.coverStatus = "已使用上传封面";
    } else if (result.ready) {
      target.coverStatus = "未识别到封面";
    } else {
      target.coverStatus = "封面识别未连接";
    }

    target.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  } catch (error) {
    const target = getLiveDocument(item.id) || item;
    target.coverStatus = "封面识别失败";
    target.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  }
}

async function requestCoverCandidate(file, onProgress) {
  const body = new FormData();
  body.append("document", file, file.name);

  return postFormDataWithProgress(OCR_COVER_SERVICE_URL, body, { onProgress, retries: 1 });
}

function needsMetadataAutoFill(item) {
  return ["title", "author", "year", "publisher"].some((field) => {
    return !String(item[field] || "").trim();
  });
}

function applyExtractedMetadata(item, metadata) {
  let changed = false;
  ["title", "author", "year", "publisher"].forEach((field) => {
    const value = String(metadata[field] || "").trim();
    if (!String(item[field] || "").trim() && value) {
      item[field] = value;
      changed = true;
    }
  });
  return changed;
}

function buildLlmMetadata(item) {
  return {
    title: item.title || "",
    author: item.author || "",
    year: item.year || "",
    publisher: item.publisher || "",
  };
}
// 逐页流式处理进度：同一行内左侧为主进度条（识别 / 整理两条按页数叠加显示，
// 识别必然领先于整理，所以两种颜色不会互相遮挡），右侧两个进度环分别表示
// 识别服务与整理服务当前单页的处理进度。

let streamSubState = { pageNumber: null, text: "", percent: 0, active: false };
let streamLlmRingPercent = 0;
let streamLlmRingTimer = null;
let streamLlmRingItem = null;
let streamProgressMainFill;
let streamProgressSubFill;
let streamProgressOcrPages;
let streamProgressLlmPages;
let streamProgressTotalNodes;
let streamOcrMarker;
let streamLlmMarker;
let streamOcrRingFill;
let streamLlmRingFill;

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
}

setupCombinedProgress();

function stopLlmRingTimer() {
  if (streamLlmRingTimer) {
    window.clearInterval(streamLlmRingTimer);
    streamLlmRingTimer = null;
  }
}

// 整理接口是一次性返回、没有逐段进度，这里在单页处理期间用渐进逼近模拟实时进度，
// 接口返回后由 clearStreamSubProgress() 直接置满。
function startLlmPageProgress(item, pageNumber) {
  streamSubState = {
    pageNumber,
    text: "大模型整理中",
    percent: 8,
    active: true,
  };
  streamLlmRingPercent = 8;
  streamLlmRingItem = item;
  stopLlmRingTimer();
  streamLlmRingTimer = window.setInterval(() => {
    if (!streamSubState.active) {
      return;
    }
    streamLlmRingPercent = clampPercent(
      streamLlmRingPercent + Math.max(1, (94 - streamLlmRingPercent) * 0.08),
    );
    streamSubState.percent = streamLlmRingPercent;
    renderStreamProgress(streamLlmRingItem);
  }, 450);
}

function clearStreamSubProgress() {
  stopLlmRingTimer();
  streamLlmRingPercent = streamLlmRingPercent > 0 ? 100 : 0;
  streamSubState = { pageNumber: null, text: "", percent: 0, active: false };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(100, Math.max(0, number));
}

function setRingProgress(fillNode, percent) {
  if (!fillNode) {
    return;
  }

  const length = typeof fillNode.getTotalLength === "function"
    ? fillNode.getTotalLength()
    : 97.39;
  const clamped = clampPercent(percent);
  fillNode.style.strokeDasharray = `${length}`;
  fillNode.style.strokeDashoffset = `${length * (1 - clamped / 100)}`;
}

// 页数标签跟随对应进度条的推进位置，显示在进度条下方。
function setMarkerPosition(node, percent) {
  if (!node) {
    return;
  }

  const clamped = Math.min(88, Math.max(4, clampPercent(percent)));
  node.style.left = `${clamped}%`;
}

function renderStreamProgress(item) {
  const task = item?.processingTask;

  if (!item || !task) {
    stopLlmRingTimer();
    streamLlmRingPercent = 0;
    streamSubState = { pageNumber: null, text: "", percent: 0, active: false };
    streamProgress?.classList.add("hidden");
    return;
  }

  const total = task.totalPages || item.pages.length || 0;
  const finalized = countFinalizedPages(item);
  const ocrDone = Math.min(total, Number(task.completedPages) || 0);
  const finished = task.status === "已完成" || task.status === "已回填";
  const ocrRunning = ["提交中", "排队中", "处理中", "准备中"].includes(task.status);
  const ocrPercent = total > 0 ? (ocrDone / total) * 100 : finished ? 100 : 0;
  const llmPercent = total > 0 ? (finalized / total) * 100 : finished ? 100 : 0;

  // 识别环：识别进行中时直接使用后端上报的单页进度，识别完成后置满。
  const ocrRingPercent = finished
    ? 100
    : ocrRunning
      ? Number(task.currentPageProgress) || 0
      : ocrPercent;
  // 整理环：正在整理的页面使用模拟进度，空闲时保留上一次结果。
  const llmRingPercent = streamSubState.active
    ? streamSubState.percent
    : streamLlmRingPercent;

  streamProgress?.classList.remove("hidden");
  if (streamProgressMainFill) streamProgressMainFill.style.width = `${clampPercent(ocrPercent)}%`;
  if (streamProgressSubFill) streamProgressSubFill.style.width = `${clampPercent(llmPercent)}%`;
  if (streamProgressOcrPages) streamProgressOcrPages.textContent = `${ocrDone}`;
  if (streamProgressLlmPages) streamProgressLlmPages.textContent = `${finalized}`;
  streamProgressTotalNodes?.forEach((node) => {
    node.textContent = `${total}`;
  });
  setMarkerPosition(streamLlmMarker, llmPercent);
  setMarkerPosition(streamOcrMarker, ocrPercent);
  setRingProgress(streamOcrRingFill, ocrRingPercent);
  setRingProgress(streamLlmRingFill, llmRingPercent);
}
