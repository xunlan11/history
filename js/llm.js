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

async function generatePunctuatedText(options = {}) {
  const item = getSelectedDocument();
  const page = getSelectedPage();

  if (!item || !page) {
    alert("请先打开一项文献和页码。");
    return;
  }

  if (!canEditDocument(item)) {
    if (!options.silent) alert("只有创建者可以修改这份文献。");
    return;
  }

  saveCurrentPage();
  const sourceText = cleanText.value.trim() || ocrRawText.value.trim();

  if (!sourceText) {
    alert("请先填写 OCR 原始录文或忠实整理文本。");
    return;
  }

  setLlmTaskStatus("正在生成...");

  try {
    const result = await requestLlmTask("/punctuate", {
      documentId: item.id,
      pageId: page.id,
      pageNumber: page.pageNumber,
      metadata: buildLlmMetadata(item),
      sourceText,
      sourceLayer: cleanText.value.trim() ? "clean" : "ocr",
    });

    if (!result.ready) {
      setLlmTaskStatus("大模型未连接");
      if (!options.silent) {
        alert(result.message || "大模型服务未连接。");
      }
      return;
    }

    if (result.punctuatedText) {
      page.punctuatedText = result.punctuatedText.trim();
      punctuatedText.value = page.punctuatedText;
    }

    page.status = "已生成整理稿";
    page.updatedAt = new Date().toISOString();
    item.status = summarizeDocumentStatus(item);
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
    setLlmTaskStatus("已生成整理稿");
  } catch (error) {
    setLlmTaskStatus("生成失败");
    alert("暂时无法调用大模型服务。请确认 Qwen3-8B 和大模型统一接口已启动。");
  }
}

async function generateFinalText(options = {}) {
  const item = getSelectedDocument();
  const page = getSelectedPage();

  if (!item || !page) {
    alert("请先打开一项文献和页码。");
    return;
  }

  if (!canEditDocument(item)) {
    if (!options.silent) alert("只有创建者可以修改这份文献。");
    return;
  }

  saveCurrentPage();

  if (!hasPageText(page)) {
    alert("请先填写本页文字。");
    return;
  }

  setLlmTaskStatus("正在生成整理稿...");
  startPageStage(page, "生成整理文本中", 65);
  renderStreamProgress(item);

  try {
    const result = await requestFinalTextForPage(item, page);
    if (!result.ready) {
      setLlmTaskStatus("大模型未连接");
      if (!options.silent) {
        alert(result.message || "大模型服务未连接。");
      }
      return;
    }

    applyFinalTextResult(item, page, result);
    persist();
    renderAll();
    setLlmTaskStatus("已生成整理稿");
  } catch (error) {
    setLlmTaskStatus("生成失败");
    if (!options.silent) {
      alert("暂时无法调用大模型服务。请确认 Qwen3-8B 和大模型统一接口已启动。");
    }
  } finally {
    finishPageStage(page);
    renderStreamProgress(item);
  }
}

async function generateDocumentFinalText() {
  const item = getSelectedDocument();
  if (!item) {
    alert("请先打开一项文献。");
    return;
  }

  if (!canEditDocument(item)) {
    alert("只有创建者可以修改这份文献。");
    return;
  }

  saveCurrentPage();
  const pages = item.pages
    .slice()
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .filter((page) => hasPageText(page));

  if (!pages.length) {
    alert("当前文献还没有可整理的文字。");
    return;
  }

  const ok = window.confirm(`将重新生成“${getDocumentDisplayTitle(item)}”的 ${pages.length} 页整理文本，并覆盖当前整理文本。继续吗？`);
  if (!ok) {
    return;
  }

  generateDocumentTextButton.disabled = true;
  let completed = 0;
  let failed = 0;

  try {
    for (const page of pages) {
      selectedPageId = page.id;
      page.status = "正在生成整理稿";
      item.status = summarizeDocumentStatus(item);
      renderAll();
      setLlmTaskStatus(`正在生成 ${completed + 1}/${pages.length}`);
      startPageStage(page, "生成整理文本中", 65);
      renderStreamProgress(item);

      try {
        const result = await requestFinalTextForPage(item, page);
        if (result.ready) {
          applyFinalTextResult(item, page, result);
          completed += 1;
        } else {
          page.status = "生成失败";
          failed += 1;
        }
      } catch (error) {
        page.status = "生成失败";
        failed += 1;
      }

      finishPageStage(page);
      renderStreamProgress(item);
      item.status = summarizeDocumentStatus(item);
      item.updatedAt = new Date().toISOString();
      persist();
    }
  } finally {
    generateDocumentTextButton.disabled = false;
  }

  renderAll();
  setLlmTaskStatus(failed ? `完成 ${completed} 页，失败 ${failed} 页` : `已生成 ${completed} 页`);
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

function setLlmTaskStatus(text) {
  if (llmTaskStatus) {
    llmTaskStatus.textContent = text;
  }
}
