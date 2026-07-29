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

async function generatePunctuatedText() {
  const item = getSelectedDocument();
  const page = getSelectedPage();

  if (!item || !page) {
    alert("请先打开一项文献和页码。");
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
      alert(result.message || "大模型服务未连接。");
      return;
    }

    if (result.punctuatedText) {
      page.punctuatedText = result.punctuatedText.trim();
      punctuatedText.value = page.punctuatedText;
    }

    const notes = buildLlmNotes("简体标点生成", result.warnings, result.uncertainItems);
    page.notes = mergeNotes(page.notes, notes);
    page.status = "待核对";
    page.updatedAt = new Date().toISOString();
    item.status = summarizeDocumentStatus(item);
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
    setLlmTaskStatus("已生成，待核对");
  } catch (error) {
    setLlmTaskStatus("生成失败");
    alert("暂时无法调用大模型服务。请确认 Qwen3-8B 和大模型统一接口已启动。");
  }
}

async function generateProofreadReport() {
  const item = getSelectedDocument();
  const page = getSelectedPage();

  if (!item || !page) {
    alert("请先打开一项文献和页码。");
    return;
  }

  saveCurrentPage();

  if (!ocrRawText.value.trim() && !cleanText.value.trim() && !punctuatedText.value.trim()) {
    alert("请先填写本页文字。");
    return;
  }

  setLlmTaskStatus("正在校对...");

  try {
    const result = await requestLlmTask("/proofread", {
      documentId: item.id,
      pageId: page.id,
      pageNumber: page.pageNumber,
      metadata: buildLlmMetadata(item),
      ocrText: ocrRawText.value.trim(),
      cleanText: cleanText.value.trim(),
      punctuatedText: punctuatedText.value.trim(),
      notes: pageNotes.value.trim(),
    });

    if (!result.ready) {
      setLlmTaskStatus("大模型未连接");
      alert(result.message || "大模型服务未连接。");
      return;
    }

    page.notes = mergeNotes(page.notes, formatProofreadReport(result.report));
    page.status = "待核对";
    page.updatedAt = new Date().toISOString();
    item.status = summarizeDocumentStatus(item);
    item.updatedAt = new Date().toISOString();
    persist();
    renderAll();
    setLlmTaskStatus("校对完成，待核对");
  } catch (error) {
    setLlmTaskStatus("校对失败");
    alert("暂时无法调用大模型服务。请确认 Qwen3-8B 和大模型统一接口已启动。");
  }
}

async function autoExtractDocumentMetadata(item, text, page, source = "ocr") {
  if (!item || !text || !needsMetadataAutoFill(item)) {
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
    item.metadataStatus = changed ? "已自动识别，待核对" : "未识别到文献信息";
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
  if (!item || !file || !file.name) {
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
  return ["title", "author", "year", "publisher", "rights", "source"].some((field) => {
    return !String(item[field] || "").trim();
  });
}

function applyExtractedMetadata(item, metadata) {
  let changed = false;
  ["title", "author", "year", "publisher", "rights", "source"].forEach((field) => {
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
    rights: item.rights || "",
    source: item.source || "",
  };
}

function buildLlmNotes(title, warnings = [], uncertainItems = []) {
  const lines = [`${title}：模型生成结果，需人工核对。`];

  if (Array.isArray(warnings) && warnings.length) {
    lines.push(`处理提示：${warnings.join("；")}`);
  }

  if (Array.isArray(uncertainItems) && uncertainItems.length) {
    lines.push(`不确定处：${uncertainItems.join("；")}`);
  }

  return lines.join("\n");
}

function formatProofreadReport(report = {}) {
  const lines = ["模型校对报告：需人工核对。"];
  const fields = [
    ["高风险页码", report.highRiskPages],
    ["疑似漏识", report.suspectedMissingText],
    ["疑似错字", report.suspectedWrongCharacters],
    ["不确定字词", report.uncertainCharacters],
    ["复核事项", report.reviewNotes],
  ];

  fields.forEach(([label, value]) => {
    if (Array.isArray(value) && value.length) {
      lines.push(`${label}：${value.join("；")}`);
    }
  });

  return lines.join("\n");
}

function setLlmTaskStatus(text) {
  if (llmTaskStatus) {
    llmTaskStatus.textContent = text;
  }
}
