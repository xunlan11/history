// 识别能力由数据处理服务器（服务端）提供；这里把 503 detail 翻成人能看懂的提示。
async function describeOcrFailure(response) {
  let detail = null;
  try {
    const payload = await response.json();
    detail = payload ? payload.detail : null;
  } catch (error) {
    detail = null;
  }

  if (detail && typeof detail === "object" && detail.message) {
    return detail.message;
  }
  if (typeof detail === "string" && detail.trim()) {
    return detail;
  }
  if (response.status === 503) {
    return "识别能力尚未部署：请在数据处理服务器上部署 OCR 服务端后再试。";
  }
  return `识别服务返回 ${response.status}。`;
}

async function requestPageOcr(page) {
  const imageBlob = await getPageImageBlob(page);
  const body = new FormData();
  body.append("image", imageBlob, page.imageName || `page-${page.pageNumber}.png`);
  body.append("pageNumber", String(page.pageNumber));

  const response = await fetch(OCR_SERVICE_URL, {
    method: "POST",
    body,
  });

  if (!response.ok) {
    throw new Error(await describeOcrFailure(response));
  }

  return response.json();
}

async function getPageImageBlob(page) {
  if (page.imageDataUrl) {
    return dataUrlToBlob(page.imageDataUrl);
  }

  if (!page.imageUrl) {
    throw new Error("Page image is missing");
  }

  const response = await fetch(page.imageUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Page image fetch failed: ${response.status}`);
  }

  return response.blob();
}

async function recognizeCurrentPage() {
  const item = getSelectedDocument();
  const page = getSelectedPage();

  if (!item || !page) {
    alert("请先打开一项文献和页码。");
    return;
  }

  if (!canEditDocument(item)) {
    alert("只有创建者可以修改这份文献。");
    return;
  }

  if (!page.imageDataUrl && !page.imageUrl) {
    alert("请先为本页选择原始资料图片。");
    return;
  }

  recognizeStatus.textContent = "正在识别...";
  startPageStage(page, "本页识别中", 30);
  renderStreamProgress(item);

  try {
    const result = await requestPageOcr(page);
    const recognizedText = result.text || "";

    if (!recognizedText.trim()) {
      recognizeStatus.textContent = "未识别到文字";
      finishPageStage(page);
      renderStreamProgress(item);
      alert("本页没有识别出文字，请检查原图是否清晰。");
      return;
    }

    page.ocrText = recognizedText.trim();
    page.status = "已识别";
    page.ocr = buildOcrSummary(result);
    page.updatedAt = new Date().toISOString();
    item.status = summarizeDocumentStatus(item);
    item.updatedAt = new Date().toISOString();

    persist();
    renderAll();
    recognizeStatus.textContent = "已识别";
    startPageStage(page, "生成整理文本中", 65);
    renderStreamProgress(item);
    autoExtractDocumentMetadata(item, recognizedText, page, "ocr");
    if (typeof generateFinalText === "function") {
      await generateFinalText({ silent: true });
    }
  } catch (error) {
    recognizeStatus.textContent = "识别服务未连接";
    finishPageStage(page);
    renderStreamProgress(item);
    alert(error && error.message ? error.message : "暂时无法连接识别服务，请确认服务端识别能力已部署。");
  }
}

const PROCESSING_POLL_INTERVAL_MS = 1500;
// 仅大模型整理队列按页码顺序执行；OCR 在后端独立连续推进，不等待大模型。
const PROCESSING_LLM_MAX_CONCURRENT = 1;
const processingPollTimers = new Map();
const processingLlmStates = new Map();
const metadataAutoTriggered = new Set();

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

function enqueueProcessingFinalize(item, page) {
  if (!canEditDocument(item) || !page || !isProcessingPageOcrReady(page) || isProcessingPageFinalized(page)) {
    return;
  }

  page.status = "正在生成整理稿";
  const state = getProcessingLlmState(item.id);
  state.queue.push({ item, page });
  state.queue.sort((a, b) => a.page.pageNumber - b.page.pageNumber);
  drainProcessingLlmQueue(item.id);
}

function drainProcessingLlmQueue(documentId) {
  const state = processingLlmStates.get(documentId);
  if (!state) {
    return;
  }

  while (state.inFlight < PROCESSING_LLM_MAX_CONCURRENT && state.queue.length) {
    const next = state.queue.shift();
    state.inFlight += 1;
    state.attempted += 1;
    setStreamSubProgress(next.page.pageNumber, "大模型整理中", 65);
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
  try {
    const result = await requestFinalTextForPage(item, page);
    if (result.ready) {
      applyFinalTextResult(item, page, result);
    } else {
      page.status = "生成失败";
    }
  } catch (error) {
    page.status = "生成失败";
  }

  item.status = summarizeDocumentStatus(item);
  item.updatedAt = new Date().toISOString();
  persist();
}

function refreshProcessingLlmProgress(item) {
  const state = processingLlmStates.get(item.id);
  if (state && (state.inFlight > 0 || state.queue.length > 0)) {
    renderStreamProgress(item);
    if (streamStatus) streamStatus.textContent = getProcessingTaskLabel(item);
    if (selectedStatus) selectedStatus.textContent = item.status;
    return;
  }

  clearStreamSubProgress();
  renderStreamProgress(item);
  if (streamStatus) streamStatus.textContent = getProcessingTaskLabel(item);
  if (selectedStatus) selectedStatus.textContent = item.status;
  maybeFinishProcessingPipeline(item);
}

function enqueueNewProcessingPages(item) {
  if (!canEditDocument(item)) return false;
  let count = 0;
  item.pages.forEach((page) => {
    if (isProcessingPageOcrReady(page) && !isProcessingPageFinalized(page)) {
      enqueueProcessingFinalize(item, page);
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

async function submitProcessingTask(item, file) {
  if (!canEditDocument(item)) return;
  try {
    const body = new FormData();
    body.append("document", file, file.name);
    body.append("documentId", item.id);
    body.append("title", item.title || file.name);

    const response = await fetch(OCR_STREAM_SERVICE_URL, {
      method: "POST",
      body,
    });

    if (!response.ok) {
      throw new Error(await describeOcrFailure(response));
    }

    const result = await response.json();
    item.processingTask = {
      ...item.processingTask,
      remoteTaskId: result.taskId || result.id || item.processingTask.id,
      status: result.status || "处理中",
      submittedAt: new Date().toISOString(),
      totalPages: Number(result.totalPages) || item.processingTask.totalPages || 0,
      completedPages: Number(result.completedPages) || 0,
      currentPage: Number(result.currentPage) || 0,
      currentPageStage: result.currentPageStage || "",
      currentPageProgress: Number(result.currentPageProgress) || 0,
      message: result.message || "已提交逐页流式处理任务",
    };

    if (Array.isArray(result.pages) && result.pages.length) {
      mergeProcessingPages(item, result.pages);
      item.processingTask.status = result.status || "已回填";
      item.processingTask.finishedAt = result.finishedAt || new Date().toISOString();
      triggerProcessingMetadata(item);
    }

    item.status = item.processingTask.status;
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();

    if (isProcessingTaskPending(item)) {
      startProcessingPolling(item);
    } else if (["已完成", "已回填"].includes(item.processingTask.status)) {
      enqueueNewProcessingPages(item);
      maybeFinishProcessingPipeline(item);
    }
  } catch (error) {
    item.processingTask = {
      ...item.processingTask,
      status: "提交失败",
      message: error && error.message
        ? error.message
        : "无法连接逐页处理服务，请确认服务端识别能力已部署后重新导入。",
    };
    item.status = "逐页处理提交失败";
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  }
}

async function refreshProcessingTask() {
  const item = getSelectedDocument();

  if (!item || !canEditDocument(item)) {
    return;
  }

  const taskId = item.processingTask?.remoteTaskId;
  if (!taskId) {
    alert("当前文献还没有处理任务编号。请确认导入时逐页处理服务与服务端识别能力均可用。");
    return;
  }

  await refreshProcessingDocument(item);
}

async function refreshProcessingDocument(item, options = {}) {
  if (!canEditDocument(item)) return;
  const taskId = item.processingTask?.remoteTaskId;
  if (!taskId) {
    if (!options.silent) {
      alert("当前文献还没有处理任务编号。请确认导入时逐页处理服务与服务端识别能力均可用。");
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
        if (selectedStatus) selectedStatus.textContent = item.status;
      }
      return;
    }

    renderStreamProgress(item);
    if (streamStatus) streamStatus.textContent = getProcessingTaskLabel(item);
    if (selectedStatus) selectedStatus.textContent = item.status;
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
