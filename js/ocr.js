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

  try {
    const result = await requestPageOcr(page);
    const recognizedText = result.text || "";

    if (!recognizedText.trim()) {
      recognizeStatus.textContent = "未识别到文字";
      alert("本页没有识别出文字，请检查原图是否清晰。");
      return;
    }

    page.ocrText = recognizedText.trim();
    page.text = page.cleanText || "";
    page.notes = mergeNotes(page.notes, buildOcrNote(result));
    page.status = "待核对";
    page.ocr = {
      confidence: result.confidence ?? null,
      engine: result.engine || "本机识别服务",
      recognizedAt: new Date().toISOString(),
    };
    page.updatedAt = new Date().toISOString();
    item.status = summarizeDocumentStatus(item);
    item.updatedAt = new Date().toISOString();

    persist();
    renderAll();
    recognizeStatus.textContent = "已识别，待核对";
    autoExtractDocumentMetadata(item, recognizedText, page, "ocr");
  } catch (error) {
    recognizeStatus.textContent = "识别服务未连接";
    alert("暂时无法连接本机识别服务。请确认技术人员已在本机启动 OCR 服务后再试。");
  }
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
      message: result.message || "已提交本机整本处理服务",
    };

    if (Array.isArray(result.pages) && result.pages.length) {
      applyBatchPages(item, result.pages);
      item.offlineTask.status = result.status || "已回填";
      item.offlineTask.finishedAt = result.finishedAt || new Date().toISOString();
      autoExtractDocumentMetadata(item, collectMetadataCandidateText(item), item.pages[0], "ocr");
    }

    item.status = item.offlineTask.status;
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
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

  offlineStatus.textContent = "正在刷新...";

  try {
    const response = await fetch(`${OCR_BATCH_SERVICE_URL}/${encodeURIComponent(taskId)}`);
    if (!response.ok) {
      throw new Error(`Batch OCR refresh failed: ${response.status}`);
    }

    const result = await response.json();
    item.offlineTask = {
      ...item.offlineTask,
      status: result.status || item.offlineTask.status,
      totalPages: Number(result.totalPages) || item.offlineTask.totalPages || 0,
      message: result.message || item.offlineTask.message,
      finishedAt: result.finishedAt || item.offlineTask.finishedAt,
    };

    if (Array.isArray(result.pages) && result.pages.length) {
      applyBatchPages(item, result.pages);
      item.offlineTask.status = result.status || "已回填";
      item.offlineTask.finishedAt = result.finishedAt || new Date().toISOString();
      autoExtractDocumentMetadata(item, collectMetadataCandidateText(item), item.pages[0], "ocr");
    }

    item.status = item.offlineTask.status;
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
  } catch (error) {
    offlineStatus.textContent = "刷新失败";
    alert("暂时无法刷新整本处理结果。请确认本机整本处理服务仍在运行。");
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
