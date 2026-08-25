async function requestPageOcr(page) {
  const imageBlob = dataUrlToBlob(page.imageDataUrl);
  const body = new FormData();
  body.append("image", imageBlob, page.imageName || `page-${page.pageNumber}.png`);
  body.append("pageNumber", String(page.pageNumber));

  const response = await fetch(OCR_SERVICE_URL, {
    method: "POST",
    body,
  });

  if (!response.ok) {
    throw new Error(`OCR request failed: ${response.status}`);
  }

  return response.json();
}

async function recognizeCurrentPage() {
  const item = getSelectedDocument();
  const page = getSelectedPage();

  if (!item || !page) {
    alert("请先打开一项文献和页码。");
    return;
  }

  if (!page.imageDataUrl) {
    alert("请先为本页选择原始资料图片。");
    return;
  }

  recognizeStatus.textContent = "正在识别...";
  startOnlinePageStage(page, "本页识别中", 30);
  renderOnlineProgress(item);

  try {
    const result = await requestPageOcr(page);
    const recognizedText = result.text || "";

    if (!recognizedText.trim()) {
      recognizeStatus.textContent = "未识别到文字";
      finishOnlinePageStage(page);
      renderOnlineProgress(item);
      alert("本页没有识别出文字，请检查原图是否清晰。");
      return;
    }

    page.ocrText = recognizedText.trim();
    page.text = page.cleanText || "";
    page.status = "已识别";
    page.ocr = {
      confidence: result.confidence ?? null,
      engine: result.engine || "本机识别服务",
      preprocessing: result.preprocessing || null,
      layout: result.layout || null,
      warnings: result.warnings || [],
      recognizedAt: new Date().toISOString(),
    };
    page.updatedAt = new Date().toISOString();
    item.status = summarizeDocumentStatus(item);
    item.updatedAt = new Date().toISOString();

    persist();
    renderAll();
    recognizeStatus.textContent = "已识别";
    startOnlinePageStage(page, "生成整理文本中", 65);
    renderOnlineProgress(item);
    autoExtractDocumentMetadata(item, recognizedText, page, "ocr");
    if (typeof generateFinalText === "function") {
      await generateFinalText({ silent: true });
    }
  } catch (error) {
    recognizeStatus.textContent = "识别服务未连接";
    finishOnlinePageStage(page);
    renderOnlineProgress(item);
    alert("暂时无法连接本机识别服务。请确认技术人员已在本机启动 OCR 服务后再试。");
  }
}

const OFFLINE_POLL_INTERVAL_MS = 1500;
const OFFLINE_LLM_MAX_CONCURRENT = 2;
const offlinePollTimers = new Map();
const offlineLlmStates = new Map();
const metadataAutoTriggered = new Set();

function isOfflineTaskPending(item) {
  const task = item?.offlineTask;
  if (!task?.remoteTaskId) {
    return false;
  }

  return ["提交中", "排队中", "处理中", "准备中"].includes(task.status);
}

function stopOfflinePolling(documentId) {
  const timer = offlinePollTimers.get(documentId);
  if (timer) {
    window.clearInterval(timer);
    offlinePollTimers.delete(documentId);
  }
}

function startOfflinePolling(item) {
  if (!item?.id) {
    return;
  }

  stopOfflinePolling(item.id);
  const timer = window.setInterval(() => {
    const current = documents.find((entry) => entry.id === item.id);
    if (!current) {
      stopOfflinePolling(item.id);
      return;
    }

    refreshOfflineDocument(current, { silent: true });
  }, OFFLINE_POLL_INTERVAL_MS);
  offlinePollTimers.set(item.id, timer);
}

// ---- 离线流水线：OCR 每完成一页，前端随即把该页交给大模型整理 ----
// OCR 在后台继续处理后续页，大模型与本机 OCR 并行推进，实现流式处理。

function getOfflineLlmState(documentId) {
  if (!offlineLlmStates.has(documentId)) {
    offlineLlmStates.set(documentId, { inFlight: 0, queue: [], attempted: 0 });
  }
  return offlineLlmStates.get(documentId);
}

function isOfflinePageOcrReady(page) {
  return Boolean(page.ocrText) && page.status !== "待整理";
}

function isOfflinePageFinalized(page) {
  return Boolean(page.cleanText) ||
    ["已生成整理稿", "正在生成整理稿", "生成失败"].includes(page.status);
}

function enqueueOfflineFinalize(item, page) {
  if (!page || !isOfflinePageOcrReady(page) || isOfflinePageFinalized(page)) {
    return;
  }

  page.status = "正在生成整理稿";
  const state = getOfflineLlmState(item.id);
  state.queue.push({ item, page });
  drainOfflineLlmQueue(item.id);
}

function drainOfflineLlmQueue(documentId) {
  const state = offlineLlmStates.get(documentId);
  if (!state) {
    return;
  }

  while (state.inFlight < OFFLINE_LLM_MAX_CONCURRENT && state.queue.length) {
    const next = state.queue.shift();
    state.inFlight += 1;
    state.attempted += 1;
    setOfflineSubProgress(next.page.pageNumber, "大模型整理中", 65);
    renderOfflineProgress(next.item);
    finalizeOfflinePage(next.item, next.page).finally(() => {
      state.inFlight -= 1;
      drainOfflineLlmQueue(documentId);
    });
  }
}

async function finalizeOfflinePage(item, page) {
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
  refreshOfflineLlmProgress(item);
}

function refreshOfflineLlmProgress(item) {
  const state = offlineLlmStates.get(item.id);
  if (state && (state.inFlight > 0 || state.queue.length > 0)) {
    renderOfflineProgress(item);
    offlineStatus.textContent = getOfflineTaskLabel(item);
    selectedStatus.textContent = item.status;
    return;
  }

  clearOfflineSubProgress();
  renderOfflineProgress(item);
  offlineStatus.textContent = getOfflineTaskLabel(item);
  selectedStatus.textContent = item.status;
  maybeFinishOfflinePipeline(item);
}

function enqueueNewOfflinePages(item) {
  let count = 0;
  item.pages.forEach((page) => {
    if (isOfflinePageOcrReady(page) && !isOfflinePageFinalized(page)) {
      enqueueOfflineFinalize(item, page);
      count += 1;
    }
  });
  return count > 0;
}

function isOfflineLlmComplete(item) {
  const task = item.offlineTask;
  if (!task) {
    return false;
  }

  const total = task.totalPages || 0;
  if (!total) {
    return false;
  }

  const state = offlineLlmStates.get(item.id);
  if (!state) {
    return true;
  }

  if (state.inFlight > 0 || state.queue.length > 0) {
    return false;
  }

  const needs = item.pages.filter((page) => isOfflinePageOcrReady(page)).length;
  return state.attempted >= needs;
}

function maybeFinishOfflinePipeline(item) {
  const task = item.offlineTask;
  if (!task) {
    return;
  }

  const ocrDone = ["已完成", "已回填"].includes(task.status);
  if (!ocrDone || !isOfflineLlmComplete(item)) {
    return;
  }

  stopOfflinePolling(item.id);
  renderAll();
}

function triggerOfflineMetadata(item) {
  if (metadataAutoTriggered.has(item.id)) {
    return;
  }

  const candidate = collectMetadataCandidateText(item);
  if (!candidate) {
    return;
  }

  metadataAutoTriggered.add(item.id);
  autoExtractDocumentMetadata(item, candidate, item.pages[0], "ocr");
}

async function submitOfflineTask(item, file) {
  try {
    const body = new FormData();
    body.append("document", file, file.name);
    body.append("documentId", item.id);
    body.append("title", item.title || file.name);

    const response = await fetch(OCR_BATCH_SERVICE_URL, {
      method: "POST",
      body,
    });

    if (!response.ok) {
      throw new Error(`Batch OCR submit failed: ${response.status}`);
    }

    const result = await response.json();
    item.offlineTask = {
      ...item.offlineTask,
      remoteTaskId: result.taskId || result.id || item.offlineTask.id,
      status: result.status || "处理中",
      submittedAt: new Date().toISOString(),
      totalPages: Number(result.totalPages) || item.offlineTask.totalPages || 0,
      completedPages: Number(result.completedPages) || 0,
      currentPage: Number(result.currentPage) || 0,
      currentPageStage: result.currentPageStage || "",
      currentPageProgress: Number(result.currentPageProgress) || 0,
      message: result.message || "已提交本机整本处理服务",
    };

    if (Array.isArray(result.pages) && result.pages.length) {
      mergeBatchPages(item, result.pages);
      item.offlineTask.status = result.status || "已回填";
      item.offlineTask.finishedAt = result.finishedAt || new Date().toISOString();
      triggerOfflineMetadata(item);
    }

    item.status = item.offlineTask.status;
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();

    if (isOfflineTaskPending(item)) {
      startOfflinePolling(item);
    } else if (["已完成", "已回填"].includes(item.offlineTask.status)) {
      enqueueNewOfflinePages(item);
      maybeFinishOfflinePipeline(item);
    }
  } catch (error) {
    item.offlineTask = {
      ...item.offlineTask,
      status: "提交失败",
      message: "无法连接本机整本处理服务，请确认服务已启动后重新导入。",
    };
    item.status = "整本处理提交失败";
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  }
}

async function refreshOfflineTask() {
  const item = getSelectedDocument();

  if (!item || item.processMode !== "offline") {
    return;
  }

  const taskId = item.offlineTask?.remoteTaskId;
  if (!taskId) {
    alert("当前文献还没有整本处理任务编号。请确认导入时本机整本处理服务已启动。");
    return;
  }

  await refreshOfflineDocument(item);
}

async function refreshOfflineDocument(item, options = {}) {
  const taskId = item.offlineTask?.remoteTaskId;
  if (!taskId) {
    if (!options.silent) {
      alert("当前文献还没有整本处理任务编号。请确认导入时本机整本处理服务已启动。");
    }
    return;
  }

  if (!options.silent) {
    offlineStatus.textContent = "正在刷新...";
  }

  try {
    const response = await fetch(`${OCR_BATCH_SERVICE_URL}/${encodeURIComponent(taskId)}`);
    if (!response.ok) {
      throw new Error(`Batch OCR refresh failed: ${response.status}`);
    }

    const result = await response.json();
    const previous = item.offlineTask || {};
    item.offlineTask = {
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

    const ocrFailed = ["处理失败", "提交失败"].includes(item.offlineTask.status);
    const ocrDone = ["已完成", "已回填"].includes(item.offlineTask.status);

    if (Array.isArray(result.pages) && result.pages.length) {
      const added = mergeBatchPages(item, result.pages);
      if (ocrDone) {
        item.offlineTask.finishedAt = result.finishedAt || new Date().toISOString();
      }

      // 有新的已识别页就立即交给大模型整理，OCR 继续处理后续页，形成流水线。
      const hasPending = enqueueNewOfflinePages(item);
      if (added || hasPending || ocrDone) {
        triggerOfflineMetadata(item);
      }
    }

    item.status = item.offlineTask.status;
    item.updatedAt = new Date().toISOString();
    persist();

    if (ocrFailed) {
      stopOfflinePolling(item.id);
      renderAll();
      return;
    }

    if (ocrDone) {
      // OCR 已完成，停止轮询；剩余工作由前端大模型队列继续推进。
      stopOfflinePolling(item.id);
      maybeFinishOfflinePipeline(item);
      if (!isOfflineLlmComplete(item)) {
        renderOfflineProgress(item);
        offlineStatus.textContent = getOfflineTaskLabel(item);
        selectedStatus.textContent = item.status;
      }
      return;
    }

    renderOfflineProgress(item);
    offlineStatus.textContent = getOfflineTaskLabel(item);
    selectedStatus.textContent = item.status;
  } catch (error) {
    offlineStatus.textContent = "刷新失败";
    if (!options.silent) {
      alert("暂时无法刷新整本处理结果。请确认本机整本处理服务仍在运行。");
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
