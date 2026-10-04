const PROCESSING_POLL_INTERVAL_MS = 1500;
// 仅大模型整理队列按页码顺序执行；OCR 在后端独立连续推进，不等待大模型。
const PROCESSING_LLM_MAX_CONCURRENT = 1;
const processingPollTimers = new Map();
const processingLlmStates = new Map();
const metadataAutoTriggered = new Set();
const processingRecoveryInFlight = new Set();

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

async function resumeMissingProcessingTask(item) {
  const task = item?.processingTask;
  if (
    !canEditDocument(item) ||
    !task ||
    task.remoteTaskId ||
    !["提交中", "提交逐页处理中"].includes(item.status || task.status) ||
    !item.fileUrl ||
    processingRecoveryInFlight.has(item.id)
  ) {
    return;
  }

  processingRecoveryInFlight.add(item.id);
  try {
    const response = await fetch(item.fileUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`原始文献下载失败：${response.status}`);
    }

    const blob = await response.blob();
    const file = new File([blob], item.fileName || task.sourceFileName || "document", {
      type: item.fileMimeType || blob.type || "application/octet-stream",
    });
    await submitProcessingTask(item, file);
  } catch (error) {
    task.status = "提交失败";
    task.message = error?.message || "无法恢复逐页处理任务。";
    item.status = "逐页处理提交失败";
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  } finally {
    processingRecoveryInFlight.delete(item.id);
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
  if (!canEditDocument(item)) {
    throw new Error("当前用户没有该文献的编辑权限，无法提交处理任务。请重新登录后重试。");
  }
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
    const remoteTaskId = result.taskId || result.id;
    if (!remoteTaskId) {
      throw new Error("处理服务未返回任务编号，文献未进入处理队列。");
    }
    item.processingTask = {
      ...item.processingTask,
      remoteTaskId,
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
    if (item.fileUrl) {
      await resumeMissingProcessingTask(item);
      return;
    }
    if (streamStatus) {
      streamStatus.textContent = "等待处理任务提交...";
    }
    return;
  }

  await refreshProcessingDocument(item);
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
async function requestLlmTask(path, payload) {
  const response = await fetch(`${LLM_SERVICE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status}`);
  }

  return response.json();
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

  item.metadataStatus = "正在自动识别";
  item.updatedAt = new Date().toISOString();
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

    if (!result.ready || !result.metadata) {
      item.metadataStatus = "自动识别未连接";
      item.updatedAt = new Date().toISOString();
      persist();
      renderAll();
      return;
    }

    const changed = applyExtractedMetadata(item, result.metadata);
    item.metadataStatus = changed ? "已自动识别" : "未识别到文献信息";
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  } catch (error) {
    item.metadataStatus = "自动识别失败";
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  }
}

async function detectDocumentCover(item, file) {
  if (!item || !canEditDocument(item) || !file || !file.name) {
    return;
  }

  item.coverStatus = "正在识别封面";
  item.updatedAt = new Date().toISOString();
  persist();
  renderAll();

  try {
    const candidate = await requestCoverCandidate(file);
    if (!candidate.imageDataUrl) {
      item.coverStatus = "未提取到候选封面";
      item.updatedAt = new Date().toISOString();
      persist();
      renderAll();
      return;
    }

    const result = await requestLlmTask("/detect-cover", {
      imageDataUrl: candidate.imageDataUrl,
      fileName: file.name,
      metadata: buildLlmMetadata(item),
    });

    if (result.ready && result.hasCover) {
      item.coverImageDataUrl = candidate.imageDataUrl;
      item.coverStatus = "已使用上传封面";
    } else if (result.ready) {
      item.coverStatus = "未识别到封面";
    } else {
      item.coverStatus = "封面识别未连接";
    }

    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  } catch (error) {
    item.coverStatus = "封面识别失败";
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  }
}

async function requestCoverCandidate(file) {
  const body = new FormData();
  body.append("document", file, file.name);

  const response = await fetch(OCR_COVER_SERVICE_URL, {
    method: "POST",
    body,
  });

  if (!response.ok) {
    throw new Error(`Cover candidate request failed: ${response.status}`);
  }

  return response.json();
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
// 单一逐页流式处理进度：主进度按已生成整理稿页数推进，
// 子进度显示当前正在 OCR 或由大模型整理的页面。

let streamSubState = { pageNumber: null, text: "", percent: 0, active: false };
let streamProgressMainFill;
let streamProgressSubFill;
let streamProgressOcrPages;
let streamProgressLlmPages;

function setupCombinedProgress() {
  if (!streamProgress) return;
  streamStatus?.remove();
  streamProgressMainFill = streamProgress.querySelector(".progress-fill-ocr");
  streamProgressSubFill = streamProgress.querySelector(".progress-fill-llm");
  streamProgressOcrPages = streamProgress.querySelector(".progress-ocr-pages");
  streamProgressLlmPages = streamProgress.querySelector(".progress-llm-pages");
}

setupCombinedProgress();

function setStreamSubProgress(pageNumber, text, percent) {
  streamSubState = {
    pageNumber,
    text,
    percent: clampPercent(percent),
    active: true,
  };
}

function clearStreamSubProgress() {
  streamSubState = { pageNumber: null, text: "", percent: 0, active: false };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(100, Math.max(0, number));
}

function setProgressRow(labelNode, fillNode, valueNode, label, percent, valueText) {
  if (labelNode) {
    labelNode.textContent = label;
  }

  if (fillNode) {
    fillNode.style.width = `${clampPercent(percent)}%`;
  }

  if (valueNode) {
    valueNode.textContent = valueText;
  }
}

function renderStreamProgress(item) {
  const task = item?.processingTask;

  if (!item || !task) {
    streamProgress?.classList.add("hidden");
    return;
  }

  const total = task.totalPages || item.pages.length || 0;
  const finalized = countFinalizedPages(item);
  const ocrDone = Math.min(total, Number(task.completedPages) || 0);
  const finished = task.status === "已完成" || task.status === "已回填";
  const failed = task.status === "处理失败" || task.status === "提交失败";
  const mainPercent = total > 0 ? (finalized / total) * 100 : finished ? 100 : 0;
  const sub = streamSubState.active
    ? {
        label: `第 ${streamSubState.pageNumber} 页`,
        percent: streamSubState.percent,
        text: streamSubState.text,
      }
    : {
        label: `第 ${task.currentPage || streamSubState.pageNumber || 0} 页`,
        percent: task.currentPageProgress || streamSubState.percent || 0,
        text: task.currentPageStage || streamSubState.text || (finished ? "已完成" : failed ? "失败" : "等待"),
      };

  streamProgress?.classList.remove("hidden");
  setProgressRow(
    streamMainLabel,
    streamMainFill,
    streamMainValue,
    "逐页整理进度",
    mainPercent,
    `${finalized} / ${total} 页`,
  );
  setProgressRow(
    streamSubLabel,
    streamSubFill,
    streamSubValue,
    sub.label,
    sub.percent,
    sub.text,
  );
  const ocrPercent = total > 0 ? (ocrDone / total) * 100 : finished ? 100 : 0;
  const llmPercent = total > 0 ? (finalized / total) * 100 : finished ? 100 : 0;
  if (streamProgressMainFill) streamProgressMainFill.style.width = `${ocrPercent}%`;
  if (streamProgressSubFill) streamProgressSubFill.style.width = `${llmPercent}%`;
  if (streamProgressOcrPages) streamProgressOcrPages.textContent = `${ocrDone}`;
  if (streamProgressLlmPages) streamProgressLlmPages.textContent = `${finalized}`;
}
