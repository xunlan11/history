let pendingReferenceDocumentIds = new Set();

function ensureReferenceConversation() {
  return getSelectedConversation() || createConversation("新对话", selectedSmartMode || "chat");
}

function isReferenceScopeActive(conversation = getSelectedConversation()) {
  return getConversationReferenceDocumentIds(conversation).length > 0;
}

function getSmartScopeDocuments(conversation = getSelectedConversation()) {
  const referenceIds = getConversationReferenceDocumentIds(conversation);
  if (!referenceIds.length) {
    return documents;
  }

  const referenceIdSet = new Set(referenceIds);
  return documents.filter((item) => referenceIdSet.has(item.id));
}

function getSmartPagePrimaryText(page, conversation = getSelectedConversation()) {
  return isReferenceScopeActive(conversation)
    ? getPageProcessedText(page)
    : getPagePrimaryText(page);
}

function getSmartPageSearchText(page, conversation = getSelectedConversation()) {
  return isReferenceScopeActive(conversation)
    ? getPageProcessedSearchText(page)
    : getPageSearchText(page);
}

function getReferenceScopeReport(conversation = getSelectedConversation()) {
  const referenceIds = getConversationReferenceDocumentIds(conversation);
  if (!referenceIds.length) {
    return {
      active: false,
      documents,
      usableDocuments: documents,
      warnings: [],
      error: "",
    };
  }

  const documentsById = new Map(documents.map((item) => [item.id, item]));
  const selectedDocuments = referenceIds.map((id) => documentsById.get(id)).filter(Boolean);
  const missingCount = referenceIds.length - selectedDocuments.length;
  const usableDocuments = selectedDocuments.filter((item) => {
    return item.pages.some((page) => getPageProcessedText(page).trim());
  });
  const emptyDocuments = selectedDocuments.filter((item) => {
    return !item.pages.some((page) => getPageProcessedText(page).trim());
  });
  const partialDocuments = usableDocuments.filter((item) => {
    const task = item.processingTask;
    const expectedPages = Number(task?.totalPages) || item.pages.length;
    const processedPages = item.pages.filter((page) => getPageProcessedText(page).trim()).length;
    return Boolean(task && processedPages < expectedPages);
  });
  const warnings = [];

  if (missingCount) {
    warnings.push(`${missingCount} 篇已选文献已不存在`);
  }
  if (emptyDocuments.length) {
    warnings.push(`${emptyDocuments.map(getDocumentDisplayTitle).join("、")}暂无处理后文本`);
  }
  if (partialDocuments.length) {
    warnings.push(`${partialDocuments.map(getDocumentDisplayTitle).join("、")}仍在处理，将只使用已完成页面`);
  }

  return {
    active: true,
    documents: selectedDocuments,
    usableDocuments,
    warnings,
    error: usableDocuments.length ? "" : "所选文献暂无可用的处理后文本，请等待处理完成或重新选择。",
  };
}

function openReferenceDocumentDialog() {
  if (!referenceDocumentDialog) {
    return;
  }

  pendingReferenceDocumentIds = new Set(getConversationReferenceDocumentIds());
  referenceDocumentSearch.value = "";
  renderReferenceDocumentOptions();
  referenceDocumentDialog.classList.remove("hidden");
  referenceDocumentSearch.focus();
}

function closeReferenceDocumentDialog() {
  referenceDocumentDialog?.classList.add("hidden");
  pendingReferenceDocumentIds = new Set();
}

function confirmReferenceDocuments() {
  const conversation = ensureReferenceConversation();
  setConversationReferenceDocumentIds(Array.from(pendingReferenceDocumentIds), conversation);
  closeReferenceDocumentDialog();
  renderReferenceDocuments();
  renderConversationList();
}

function renderReferenceDocuments() {
  if (!referenceDocumentChips || !referenceDocumentCount || !referenceScopeStatus) {
    return;
  }

  const conversation = getSelectedConversation();
  const referenceIds = getConversationReferenceDocumentIds(conversation);
  const documentsById = new Map(documents.map((item) => [item.id, item]));
  referenceDocumentChips.innerHTML = "";

  referenceIds.forEach((id) => {
    const item = documentsById.get(id);
    const chip = document.createElement("span");
    const label = document.createElement("span");
    const remove = document.createElement("button");

    chip.className = "reference-chip";
    chip.classList.toggle("reference-chip-warning", !item);
    label.textContent = item ? getDocumentDisplayTitle(item) : "文献已不存在";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `移除${label.textContent}`;
    remove.setAttribute("aria-label", `移除参考文献：${label.textContent}`);
    remove.addEventListener("click", () => {
      setConversationReferenceDocumentIds(referenceIds.filter((value) => value !== id), conversation);
      renderReferenceDocuments();
      renderConversationList();
    });
    chip.append(label, remove);
    referenceDocumentChips.append(chip);
  });

  referenceDocumentCount.textContent = String(referenceIds.length);
  referenceDocumentCount.classList.toggle("hidden", !referenceIds.length);

  const report = getReferenceScopeReport(conversation);
  if (!report.active) {
    referenceScopeStatus.textContent = "";
    referenceScopeStatus.classList.add("hidden");
    referenceScopeStatus.classList.remove("reference-scope-warning");
    return;
  }

  const base = `后续请求仅使用所选 ${referenceIds.length} 篇文献的处理后数据。`;
  referenceScopeStatus.textContent = report.warnings.length
    ? `${base}${report.warnings.join("；")}。`
    : base;
  referenceScopeStatus.classList.remove("hidden");
  referenceScopeStatus.classList.toggle("reference-scope-warning", Boolean(report.warnings.length));
}

function renderReferenceDocumentOptions() {
  if (!referenceDocumentList || !referenceSelectionSummary) {
    return;
  }

  const query = (referenceDocumentSearch?.value || "").trim().toLowerCase();
  const matchedDocuments = documents.filter((item) => {
    const haystack = [item.title, item.author, item.year, item.tags, item.fileName]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return !query || haystack.includes(query);
  });
  referenceDocumentList.innerHTML = "";

  if (!matchedDocuments.length) {
    const empty = document.createElement("p");
    empty.className = "reference-document-empty";
    empty.textContent = documents.length ? "没有匹配的文献" : "文献库为空，请先登记并处理文献";
    referenceDocumentList.append(empty);
  }

  matchedDocuments.forEach((item) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const body = document.createElement("span");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const processedCount = item.pages.filter((page) => getPageProcessedText(page).trim()).length;

    label.className = "reference-document-option";
    checkbox.type = "checkbox";
    checkbox.checked = pendingReferenceDocumentIds.has(item.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        pendingReferenceDocumentIds.add(item.id);
      } else {
        pendingReferenceDocumentIds.delete(item.id);
      }
      updateReferenceSelectionSummary();
    });
    title.textContent = getDocumentDisplayTitle(item);
    meta.textContent = [
      item.author || "著者未录",
      item.year || "年份未录",
      `处理后文本 ${processedCount}/${item.pages.length} 页`,
    ].join(" · ");
    body.append(title, meta);
    label.append(checkbox, body);
    referenceDocumentList.append(label);
  });

  updateReferenceSelectionSummary();
}

function updateReferenceSelectionSummary() {
  if (!referenceSelectionSummary) {
    return;
  }
  const count = pendingReferenceDocumentIds.size;
  referenceSelectionSummary.textContent = count ? `已选择 ${count} 篇文献` : "未选择文献，将使用整个文献库";
}

openReferenceDocumentsButton?.addEventListener("click", openReferenceDocumentDialog);
closeReferenceDocumentsButton?.addEventListener("click", closeReferenceDocumentDialog);
cancelReferenceDocumentsButton?.addEventListener("click", closeReferenceDocumentDialog);
confirmReferenceDocumentsButton?.addEventListener("click", confirmReferenceDocuments);
referenceDocumentSearch?.addEventListener("input", renderReferenceDocumentOptions);
referenceDocumentDialog?.addEventListener("click", (event) => {
  if (event.target === referenceDocumentDialog) {
    closeReferenceDocumentDialog();
  }
});
const MAX_CONVERSATION_ATTACHMENTS = 12;
const MAX_CONVERSATION_FILE_BYTES = 25 * 1024 * 1024;
const removedConversationAttachmentIds = new Set();

function getConversationAttachmentReport(conversation = getSelectedConversation()) {
  const attachments = getConversationAttachments(conversation);
  const pending = attachments.filter((item) => ["uploading", "processing"].includes(item.status));
  const ready = attachments.filter((item) => item.status === "ready" && item.extractedText.trim());
  const failed = attachments.filter((item) => item.status === "failed" || (item.status === "ready" && !item.extractedText.trim()));
  const warnings = attachments.flatMap((item) => item.warnings || []);

  if (failed.length) {
    warnings.push(`${failed.map((item) => item.fileName).join("、")}未能取得可用内容`);
  }

  let error = "";
  if (pending.length) {
    error = `${pending.map((item) => item.fileName).join("、")}仍在快速读取，请完成后再发送。`;
  } else if (attachments.length && !ready.length) {
    error = "当前上传文件没有可用内容，请移除失败文件或重新上传。";
  }

  return {
    active: attachments.length > 0,
    attachments,
    ready,
    pending,
    failed,
    warnings: Array.from(new Set(warnings.filter(Boolean))),
    error,
  };
}

function getConversationContextReport(conversation = getSelectedConversation()) {
  const references = getReferenceScopeReport(conversation);
  const attachments = getConversationAttachmentReport(conversation);
  return {
    references,
    attachments,
    warnings: Array.from(new Set([...references.warnings, ...attachments.warnings])),
    error: references.error || attachments.error,
  };
}

function renderConversationAttachments() {
  if (!conversationAttachmentChips || !conversationAttachmentStatus) {
    return;
  }

  const conversation = getSelectedConversation();
  const attachments = getConversationAttachments(conversation);
  conversationAttachmentChips.innerHTML = "";

  attachments.forEach((attachment) => {
    const chip = document.createElement("span");
    const label = attachment.fileUrl ? document.createElement("a") : document.createElement("span");
    const remove = document.createElement("button");
    const statusLabel = getConversationAttachmentStatusLabel(attachment);

    chip.className = "reference-chip attachment-chip";
    chip.classList.toggle("attachment-chip-pending", ["uploading", "processing"].includes(attachment.status));
    chip.classList.toggle("reference-chip-warning", attachment.status === "failed");
    label.textContent = `${attachment.fileName} · ${statusLabel}`;
    label.title = `${attachment.fileName}（${formatAttachmentFileSize(attachment.fileSize)}）`;
    if (attachment.fileUrl) {
      label.href = attachment.fileUrl;
      label.target = "_blank";
      label.rel = "noopener";
    }
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `移除${attachment.fileName}`;
    remove.setAttribute("aria-label", `移除上传文件：${attachment.fileName}`);
    remove.addEventListener("click", () => {
      removeUploadedConversationAttachment(attachment.id, conversation);
    });
    chip.append(label, remove);
    conversationAttachmentChips.append(chip);
  });

  const report = getConversationAttachmentReport(conversation);
  if (!report.active) {
    conversationAttachmentStatus.textContent = "";
    conversationAttachmentStatus.classList.add("hidden");
    conversationAttachmentStatus.classList.remove("reference-scope-warning");
    return;
  }

  const parts = [`当前对话已上传 ${attachments.length} 个临时文件`];
  if (report.pending.length) {
    parts.push(`${report.pending.length} 个快速读取中`);
  }
  if (report.ready.length) {
    parts.push(`${report.ready.length} 个已快速读取`);
  }
  if (report.failed.length) {
    parts.push(`${report.failed.length} 个失败`);
  }
  const warningText = report.warnings.length ? ` ${report.warnings.join("；")}。` : "";
  conversationAttachmentStatus.textContent = `${parts.join("，")}。快速读取结果仅供当前对话使用，不进入文献库。${warningText}`;
  conversationAttachmentStatus.classList.remove("hidden");
  conversationAttachmentStatus.classList.toggle(
    "reference-scope-warning",
    Boolean(report.pending.length || report.failed.length || report.warnings.length),
  );
}

function getConversationAttachmentStatusLabel(attachment) {
  if (attachment.status === "uploading") {
    return "上传中";
  }
  if (attachment.status === "processing") {
    return "快速读取中";
  }
  if (attachment.status === "failed") {
    return "处理失败";
  }
  return "已快速读取";
}

function formatAttachmentFileSize(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function uploadSelectedConversationFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) {
    return;
  }

  const conversation = getSelectedConversation() || createConversation("新对话", selectedSmartMode || "chat");
  const remaining = Math.max(0, MAX_CONVERSATION_ATTACHMENTS - getConversationAttachments(conversation).length);
  const accepted = files.slice(0, remaining);

  if (!remaining) {
    renderChatNotice(`每个对话最多上传 ${MAX_CONVERSATION_ATTACHMENTS} 个文件。`);
    return;
  }
  if (files.length > accepted.length) {
    renderChatNotice(`每个对话最多上传 ${MAX_CONVERSATION_ATTACHMENTS} 个文件，本次只处理前 ${accepted.length} 个。`);
  }

  accepted.forEach((file) => startConversationFileUpload(file, conversation));
  renderConversationList();
  renderConversationAttachments();
}

async function startConversationFileUpload(file, conversation) {
  const attachmentId = newId();
  const createdAt = new Date().toISOString();
  const placeholder = {
    id: attachmentId,
    fileName: file.name,
    fileType: file.type || "application/octet-stream",
    fileSize: file.size,
    kind: file.type.startsWith("image/") ? "image" : "document",
    extractedText: "",
    status: "uploading",
    warnings: [],
    createdAt,
    updatedAt: createdAt,
  };
  addConversationAttachment(placeholder, conversation);
  renderConversationAttachments();

  if (file.size > MAX_CONVERSATION_FILE_BYTES) {
    updateConversationAttachment(attachmentId, {
      status: "failed",
      warnings: ["文件超过 25 MB，无法作为快速对话附件处理"],
    }, conversation);
    renderConversationAttachments();
    return;
  }

  try {
    const body = new FormData();
    body.append("attachment", file, file.name);
    body.append("conversationId", conversation.id);
    body.append("attachmentId", attachmentId);
    const response = await fetch(CONVERSATION_FILE_UPLOAD_URL, { method: "POST", body });
    const result = await readConversationFileResponse(response);

    if (
      removedConversationAttachmentIds.has(attachmentId) ||
      !conversations.some((item) => item.id === conversation.id)
    ) {
      await deleteConversationAttachmentAsset(attachmentId);
      return;
    }

    const uploaded = updateConversationAttachment(attachmentId, result.attachment || {}, conversation);
    updateSyncCursorFromConversationFileResult(result);
    renderConversationAttachments();

    if (result.needsOcr && uploaded) {
      updateConversationAttachment(attachmentId, { status: "processing" }, conversation);
      renderConversationAttachments();
      await extractConversationFileWithOcr(file, uploaded, conversation);
    }
  } catch (error) {
    if (!removedConversationAttachmentIds.has(attachmentId)) {
      updateConversationAttachment(attachmentId, {
        status: "failed",
        warnings: [error.message || "文件上传或内容提取失败"],
      }, conversation);
      renderConversationAttachments();
    }
  }
}

async function readConversationFileResponse(response) {
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok) {
    // OCR 服务的失败 detail 是 {code, message} 对象，其它服务是字符串
    const detail = result.detail;
    const message = detail && typeof detail === "object" ? detail.message : detail;
    throw new Error(message || `文件处理失败：${response.status}`);
  }
  return result;
}

async function extractConversationFileWithOcr(file, attachment, conversation) {
  try {
    const ocrResult = attachment.kind === "pdf"
      ? await recognizeConversationPdf(file, attachment.id)
      : await recognizeConversationImage(file);
    const normalizedText = String(ocrResult.text || "").trim().slice(0, 60000);
    const warnings = Array.from(new Set([
      ...(attachment.warnings || []),
      ...(ocrResult.warnings || []),
    ]));
    if (!normalizedText) {
      warnings.push("OCR 没有识别出文字");
    }
    const status = normalizedText ? "ready" : "failed";
    const updated = updateConversationAttachment(attachment.id, {
      extractedText: normalizedText,
      status,
      warnings,
    }, conversation);
    if (updated) {
      await persistConversationAttachmentText(updated);
    }
  } catch (error) {
    const updated = updateConversationAttachment(attachment.id, {
      status: "failed",
      warnings: [...(attachment.warnings || []), error.message || "OCR 服务未连接"],
    }, conversation);
    if (updated) {
      await persistConversationAttachmentText(updated);
    }
  }
  renderConversationAttachments();
}

async function recognizeConversationImage(file) {
  const body = new FormData();
  body.append("image", file, file.name);
  body.append("pageNumber", "1");
  body.append("quickRead", "true");
  const response = await fetch(OCR_SERVICE_URL, { method: "POST", body });
  const result = await readConversationFileResponse(response);
  return {
    text: result.text || "",
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

async function recognizeConversationPdf(file, attachmentId) {
  const body = new FormData();
  body.append("document", file, file.name);
  body.append("documentId", attachmentId);
  body.append("title", file.name);
  body.append("quickRead", "true");
  const response = await fetch(OCR_STREAM_SERVICE_URL, { method: "POST", body });
  const submitted = await readConversationFileResponse(response);
  const taskId = submitted.taskId;
  if (!taskId) {
    throw new Error("PDF OCR 任务提交失败");
  }

  for (let attempt = 0; attempt < 240; attempt += 1) {
    await waitForConversationFileOcr(1500);
    const taskResponse = await fetch(`${OCR_STREAM_SERVICE_URL}/${encodeURIComponent(taskId)}`, { cache: "no-store" });
    const task = await readConversationFileResponse(taskResponse);
    if (["处理失败", "提交失败"].includes(task.status)) {
      throw new Error(task.message || "PDF OCR 失败");
    }
    if (["已完成", "已回填"].includes(task.status)) {
      const pages = task.pages || [];
      return {
        text: pages
          .map((page, index) => page.text ? `[第 ${page.pageNumber || index + 1} 页]\n${page.text}` : "")
          .filter(Boolean)
          .join("\n\n"),
        warnings: Array.from(new Set(pages.flatMap((page) => page.warnings || []))),
      };
    }
  }
  throw new Error("PDF OCR 等待超时，请稍后重新上传");
}

function waitForConversationFileOcr(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function persistConversationAttachmentText(attachment) {
  try {
    const response = await fetch(`${CONVERSATION_FILE_API_URL}/${encodeURIComponent(attachment.id)}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extractedText: attachment.extractedText,
        status: attachment.status,
        warnings: attachment.warnings,
      }),
    });
    const result = await readConversationFileResponse(response);
    updateSyncCursorFromConversationFileResult(result);
  } catch {
    // 会话同步仍会保存提取文本；单独更新失败不阻断使用。
  }
}

async function removeUploadedConversationAttachment(attachmentId, conversation = getSelectedConversation()) {
  removedConversationAttachmentIds.add(attachmentId);
  removeConversationAttachment(attachmentId, conversation);
  renderConversationAttachments();
  renderConversationList();
  await deleteConversationAttachmentAsset(attachmentId);
}

async function deleteConversationAttachmentAsset(attachmentId) {
  try {
    const response = await fetch(`${CONVERSATION_FILE_API_URL}/${encodeURIComponent(attachmentId)}`, {
      method: "DELETE",
    });
    if (response.ok) {
      const result = await response.json();
      updateSyncCursorFromConversationFileResult(result);
    }
  } catch {
    // 会话快照同步也会将不再引用的附件标记为删除。
  }
}

function updateSyncCursorFromConversationFileResult(result) {
  if (!result?.syncCursor) {
    return;
  }
  syncCursor = String(result.syncCursor);
  localStorage.setItem(SYNC_CURSOR_STORAGE_KEY, syncCursor);
}

function splitConversationAttachmentText(text, maxLength = 1600) {
  const paragraphs = String(text || "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  paragraphs.forEach((paragraph) => {
    if (paragraph.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let index = 0; index < paragraph.length; index += maxLength) {
        chunks.push(paragraph.slice(index, index + maxLength));
      }
      return;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  });
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function collectConversationAttachmentChatEntries(prompt) {
  const entries = [];
  getConversationAttachmentReport().ready.forEach((attachment, attachmentIndex) => {
    splitConversationAttachmentText(attachment.extractedText, 1200).forEach((text, chunkIndex) => {
      entries.push({
        sourceType: "conversation-file",
        attachmentId: attachment.id,
        documentId: attachment.id,
        documentTitle: attachment.fileName,
        pageId: `${attachment.id}-part-${chunkIndex + 1}`,
        pageNumber: chunkIndex + 1,
        text,
        score: scoreTextRelevance(`${attachment.fileName}\n${text}`, prompt),
        documentIndex: -10000 + attachmentIndex,
        pageIndex: chunkIndex,
      });
    });
  });
  return entries;
}

function buildConversationAttachmentDocumentsForLlm(query, maxChunks = 10, chunkLength = 1600) {
  const records = [];
  getConversationAttachmentReport().ready.forEach((attachment, attachmentIndex) => {
    splitConversationAttachmentText(attachment.extractedText, chunkLength).forEach((text, chunkIndex) => {
      records.push({
        attachment,
        attachmentIndex,
        chunkIndex,
        text,
        score: scoreTextRelevance(`${attachment.fileName}\n${text}`, query),
      });
    });
  });

  const grouped = new Map();
  records
    .sort((a, b) => b.score - a.score || a.attachmentIndex - b.attachmentIndex || a.chunkIndex - b.chunkIndex)
    .slice(0, maxChunks)
    .forEach(({ attachment, chunkIndex, text }) => {
      if (!grouped.has(attachment.id)) {
        grouped.set(attachment.id, {
          sourceType: "conversation-file",
          attachmentId: attachment.id,
          documentId: attachment.id,
          title: attachment.fileName,
          author: "当前对话上传文件（快速读取）",
          year: "",
          publisher: "",
          tags: "对话附件",
          fileName: attachment.fileName,
          pages: [],
        });
      }
      grouped.get(attachment.id).pages.push({
        sourceType: "conversation-file",
        attachmentId: attachment.id,
        pageId: `${attachment.id}-part-${chunkIndex + 1}`,
        pageNumber: chunkIndex + 1,
        text,
        notes: "",
      });
    });
  return Array.from(grouped.values());
}

function buildConversationAttachmentLiteralEntries(query) {
  const entries = [];
  getConversationAttachmentReport().ready.forEach((attachment) => {
    splitConversationAttachmentText(attachment.extractedText, 1600).forEach((text, chunkIndex) => {
      const snippet = buildSnippet(text, query);
      if (snippet) {
        entries.push({ attachment, chunkIndex, snippet });
      }
    });
  });
  return entries;
}

function countConversationAttachmentChunks(query = "", maxChunks = 10, chunkLength = 1600) {
  return buildConversationAttachmentDocumentsForLlm(query, maxChunks, chunkLength)
    .reduce((total, item) => total + item.pages.length, 0);
}

function findConversationAttachment(attachmentId, title = "") {
  return getConversationAttachments().find((item) => {
    return (attachmentId && item.id === attachmentId) || (!attachmentId && item.fileName === title);
  }) || null;
}

function openConversationAttachment(attachment) {
  if (attachment?.fileUrl) {
    window.open(attachment.fileUrl, "_blank", "noopener");
  }
}

uploadConversationFilesButton?.addEventListener("click", () => conversationFileInput?.click());
conversationFileInput?.addEventListener("change", () => {
  uploadSelectedConversationFiles(conversationFileInput.files);
  conversationFileInput.value = "";
});
let searchRunToken = 0;

function runLiteralSearch(notice = "") {
  const query = searchInput.value.trim();
  searchResults.innerHTML = "";
  searchResults.classList.remove("empty-result-list");

  if (!query) {
    renderSmartEmpty();
    return;
  }

  const results = getSmartScopeDocuments().flatMap((item) => buildSearchEntries(item, query));
  const attachmentResults = buildConversationAttachmentLiteralEntries(query);

  if (!results.length && !attachmentResults.length) {
    renderSearchNotice("未找到匹配内容");
    return;
  }

  if (notice) {
    const warning = document.createElement("p");
    warning.className = "meta-line";
    warning.textContent = notice;
    searchResults.append(warning);
  }

  results.forEach(({ item, page, snippet }) => {
    const result = document.createElement("article");
    result.className = "result-item";

    const content = document.createElement("div");
    const title = document.createElement("h4");
    const meta = document.createElement("p");
    const excerpt = document.createElement("p");
    const action = document.createElement("button");

    title.textContent = page ? `${item.title} · 第 ${page.pageNumber} 页` : item.title;
    meta.textContent = `${item.author || "著者未录"} · ${item.year || "年份未录"} · ${item.fileName}`;
    excerpt.innerHTML = highlight(snippet, query);
    action.className = "secondary-button";
    action.type = "button";
    action.textContent = "打开";
    action.addEventListener("click", () => {
      selectedDocumentId = item.id;
      selectedPageId = page?.id || item.pages[0]?.id || null;
      setReaderReturnView("library");
      renderAll();
      setView("reader");
    });

    content.append(title, meta, excerpt);
    result.append(content, action);
    searchResults.append(result);
  });

  attachmentResults.forEach(({ attachment, chunkIndex, snippet }) => {
    const result = document.createElement("article");
    const content = document.createElement("div");
    const title = document.createElement("h4");
    const meta = document.createElement("p");
    const excerpt = document.createElement("p");
    const action = document.createElement("button");

    result.className = "result-item";
    title.textContent = attachment.fileName;
    meta.textContent = `当前对话上传文件（快速读取） · 内容片段 ${chunkIndex + 1}`;
    excerpt.innerHTML = highlight(snippet, query);
    action.className = "secondary-button";
    action.type = "button";
    action.textContent = "打开文件";
    action.disabled = !attachment.fileUrl;
    action.addEventListener("click", () => openConversationAttachment(attachment));
    content.append(title, meta, excerpt);
    result.append(content, action);
    searchResults.append(result);
  });
}

async function runSearch(options = {}) {
  const query = searchInput.value.trim();
  const conversation = getSelectedConversation();
  const saved = conversation?.result;

  if (!options.regenerate && saved?.mode === "search" && saved.prompt === query && saved.payload?.matches) {
    clearSmartResults();
    renderLlmSearchResults(saved.payload.matches, saved.warnings || [], query);
    updateConversationToolbar();
    return;
  }

  const runToken = searchRunToken + 1;
  searchRunToken = runToken;
  searchResults.innerHTML = "";
  searchResults.classList.remove("empty-result-list");

  if (!query) {
    renderSmartEmpty();
    return;
  }

  const contextReport = getConversationContextReport();
  if (contextReport.error) {
    renderSearchNotice(contextReport.error);
    return;
  }

  if (!isLlmServiceConnected()) {
    const notices = [
      "未连接大模型，已使用字面检索；异称、字号、别名可能无法召回。",
      ...contextReport.warnings,
    ];
    runLiteralSearch(notices.join(" "));
    return;
  }

  const searchDocuments = collectSearchDocumentsForLlm(query);
  if (!searchDocuments.length) {
    renderSearchNotice("暂无可用于检索的整理文本。");
    return;
  }

  renderSearchLoading();

  try {
    const result = await requestLlmTask("/search", {
      query,
      documents: searchDocuments,
      options: {
        source: "conversation-context",
        maxMatches: 50,
        totalPageCount: countSearchPages(),
      },
    });

    if (runToken !== searchRunToken) {
      return;
    }

    if (!result.ready) {
      renderSearchNotice(result.message || "大模型服务未连接。");
      return;
    }

    const warnings = [...contextReport.warnings, ...(result.warnings || [])];
    renderLlmSearchResults(result.matches || [], warnings, query);
    saveConversationResult(getSelectedConversation(), {
      mode: "search",
      prompt: query,
      payload: {
        matches: result.matches || [],
        expandedTerms: result.expandedTerms || [],
      },
      warnings,
    });
  } catch (error) {
    if (runToken !== searchRunToken) {
      return;
    }

    renderSearchNotice("暂时无法调用大模型检索。");
  }
}

function buildSearchEntries(item, query) {
  const entries = [];
  const metadataSnippet = buildSnippet(buildSearchMetadata(item), query);

  if (metadataSnippet) {
    entries.push({ item, page: null, snippet: metadataSnippet });
  }

  item.pages.forEach((page) => {
    const pageSnippet = buildSnippet(getSmartPageSearchText(page), query);
    if (pageSnippet) {
      entries.push({ item, page, snippet: pageSnippet });
    }
  });

  return entries;
}

function collectSearchDocumentsForLlm(query) {
  const records = [];
  const attachmentDocuments = buildConversationAttachmentDocumentsForLlm(query, 12, 1600);
  const attachmentPageCount = attachmentDocuments.reduce((total, item) => total + item.pages.length, 0);

  getSmartScopeDocuments().forEach((item, documentIndex) => {
    const metadata = buildSearchMetadata(item);

    item.pages.forEach((page, pageIndex) => {
      const text = getSmartPageSearchText(page).trim();
      if (!text) {
        return;
      }

      records.push({
        item,
        page,
        documentIndex,
        pageIndex,
        score: scoreTextRelevance(`${metadata}\n${text}`, query),
      });
    });
  });

  const grouped = new Map();
  records
    .sort((a, b) => b.score - a.score || a.documentIndex - b.documentIndex || a.pageIndex - b.pageIndex)
    .slice(0, Math.max(20, 40 - attachmentPageCount))
    .forEach(({ item, page }) => {
      if (!grouped.has(item.id)) {
        grouped.set(item.id, {
          documentId: item.id,
          title: getDocumentDisplayTitle(item),
          author: item.author || "",
          year: item.year || "",
          publisher: item.publisher || "",
          tags: item.tags || "",
          fileName: item.fileName || "",
          pages: [],
        });
      }

      grouped.get(item.id).pages.push({
        pageId: page.id,
        pageNumber: page.pageNumber,
        text: getSmartPageSearchText(page).slice(0, 1600),
        notes: (page.notes || "").slice(0, 400),
      });
    });

  return [
    ...Array.from(grouped.values()).filter((item) => item.pages.length),
    ...attachmentDocuments,
  ];
}

function buildSearchMetadata(item) {
  return [
    item.title,
    item.author,
    item.year,
    item.publisher,
    item.tags,
    item.fileName,
  ].filter(Boolean).join("\n");
}

function countSearchPages() {
  const documentPages = getSmartScopeDocuments().reduce((total, item) => {
    return total + item.pages.filter((page) => getSmartPageSearchText(page).trim()).length;
  }, 0);
  return documentPages + countConversationAttachmentChunks(searchInput.value.trim(), 12, 1600);
}

function renderSearchLoading() {
  renderResultState(searchResults, "正在调用大模型检索...");
}

function renderSearchNotice(message) {
  renderResultState(searchResults, message);
}

function renderLlmSearchResults(matches, warnings = [], query = "") {
  searchResults.innerHTML = "";
  searchResults.classList.remove("empty-result-list");

  if (!matches.length) {
    renderSearchNotice("未找到匹配内容");
    return;
  }

  matches.forEach((match, index) => {
    const target = resolveSearchMatch(match);
    const attachment = target?.attachment || null;
    const item = target?.item || {};
    const page = target?.page || null;
    const result = document.createElement("article");
    const content = document.createElement("div");
    const title = document.createElement("h4");
    const meta = document.createElement("p");
    const excerpt = document.createElement("p");
    const reason = document.createElement("p");
    const action = document.createElement("button");

    result.className = "result-item";
    title.textContent = attachment
      ? attachment.fileName
      : page
      ? `${getDocumentDisplayTitle(item)} · 第 ${page.pageNumber} 页`
      : match.title || "匹配结果";
    meta.textContent = [
      attachment ? "当前对话上传文件（快速读取）" : match.author || item.author || "著者未录",
      match.year || item.year || "年份未录",
      match.matchedAs ? `按“${match.matchedAs}”匹配` : "",
      match.matchType || "",
    ].filter(Boolean).join(" · ");
    excerpt.innerHTML = highlightIfLiteral(match.quote || match.snippet || match.summary || "", query);
    reason.textContent = match.reason ? `判断：${match.reason}` : "";
    reason.className = "meta-line";
    action.className = "secondary-button";
    action.type = "button";
    action.textContent = attachment ? "打开文件" : "打开原文";
    const actionHref = searchResultHref(attachment, item, page);
    action.disabled = !actionHref;
    action.addEventListener("click", () => {
      if (actionHref) {
        window.open(actionHref, "_blank", "noopener");
      }
    });

    content.append(title, meta, excerpt);
    if (reason.textContent) {
      content.append(reason);
    }
    if (Array.isArray(warnings) && warnings.length && index === matches.length - 1) {
      content.append(formatWarnings(warnings));
    }
    result.append(content, action);
    searchResults.append(result);
  });
}

function highlightIfLiteral(text, query) {
  if (!text) {
    return "";
  }

  return buildSnippet(text, query) ? highlight(text, query) : escapeHtml(text);
}

function resolveSearchMatch(match) {
  const target = resolveDocumentSource(match);
  if (!target) {
    const attachment = findConversationAttachment(match.attachmentId || match.documentId, match.title);
    return attachment ? { attachment, item: null, page: null } : null;
  }
  return target;
}
const RESULT_MODE_LABELS = {
  chat: { update: "用当前文献重答", regenerate: "重新回答", showRegenerate: false },
  search: { update: "用当前文献重检", regenerate: "重新检索", showRegenerate: false },
  chronicle: { update: "并入当前文献", regenerate: "从零重生成", showRegenerate: true },
};

function getScopeProcessedDocumentIds() {
  return getSmartScopeDocuments()
    .filter((item) => item.pages.some((page) => getPageProcessedText(page).trim()))
    .map((item) => item.id);
}

function saveConversationResult(conversation, { mode, prompt, payload, warnings }) {
  if (!conversation) {
    return;
  }

  conversation.result = {
    mode,
    prompt: prompt || "",
    payload: payload || {},
    warnings: Array.isArray(warnings) ? warnings : [],
    sourceDocumentIds: getScopeProcessedDocumentIds(),
    generatedAt: new Date().toISOString(),
  };
  conversation.updatedAt = new Date().toISOString();
  persistConversations();
  updateConversationToolbar();
}

function updateConversationToolbar() {
  if (!resultToolbar) {
    return;
  }

  const result = getSelectedConversation()?.result;
  if (!result) {
    resultToolbar.classList.add("hidden");
    return;
  }

  const labels = RESULT_MODE_LABELS[result.mode] || RESULT_MODE_LABELS.chat;
  const documentCount = (result.sourceDocumentIds || []).length;
  resultToolbar.classList.remove("hidden");

  if (resultToolbarStatus) {
    const title = result.prompt ? `“${result.prompt}”` : "本次结果";
    resultToolbarStatus.textContent = `${title}已保存 · 依据 ${documentCount} 篇文献`;
  }
  if (resultUpdateButton) {
    resultUpdateButton.textContent = labels.update;
    resultUpdateButton.disabled = false;
    resultUpdateButton.title = "按当前文献范围重新更新结果";
  }
  if (resultRegenerateButton) {
    resultRegenerateButton.textContent = labels.regenerate;
    resultRegenerateButton.classList.toggle("hidden", !labels.showRegenerate);
  }
}

async function supplementConversation() {
  const conversation = getSelectedConversation();
  const result = conversation?.result;
  if (!conversation || !result) {
    return;
  }

  if (result.mode === "chronicle") {
    await supplementChronicle(conversation, result);
    return;
  }

  if (result.mode === "search") {
    await runSearch({ regenerate: true });
    return;
  }

  await runSmartChat({ regenerate: true });
}

function regenerateConversationResult() {
  const mode = getSelectedConversation()?.result?.mode || selectedSmartMode;

  if (mode === "chronicle") {
    buildChronicle({ regenerate: true });
    return;
  }

  if (mode === "search") {
    runSearch({ regenerate: true });
    return;
  }

  runSmartChat({ regenerate: true });
}

async function buildChronicle(options = {}) {
  const topic = chronicleTopic.value.trim();
  const conversation = getSelectedConversation();
  const saved = conversation?.result;

  if (!options.regenerate && saved?.mode === "chronicle" && saved.prompt === topic && saved.payload?.entries?.length) {
    clearSmartResults();
    renderChronicleLlmEntries(saved.payload.entries, saved.warnings || []);
    updateConversationToolbar();
    return;
  }

  const contextReport = getConversationContextReport();
  if (contextReport.error) {
    renderChronicleNotice(contextReport.error);
    return;
  }
  const chronicleDocuments = collectChronicleDocumentsForLlm(topic);
  chronicleResults.innerHTML = "";
  chronicleResults.classList.remove("empty-result-list");

  if (!chronicleDocuments.length) {
    renderChronicleNotice("暂无可用于生成编年的整理文本。");
    return;
  }

  if (!isLlmServiceConnected()) {
    renderChronicleNotice("未连接大模型，无法生成复杂纪年编排。");
    return;
  }

  renderChronicleLoading();

  try {
    const result = await requestLlmTask("/chronicle", {
      topic,
      documents: chronicleDocuments,
      options: {
        source: "conversation-context",
        maxEntries: 40,
        totalPageCount: countChroniclePagesForLlm(),
      },
    });

    if (!result.ready) {
      renderChronicleNotice(result.message || "大模型服务未连接。");
      return;
    }

    const warnings = [...contextReport.warnings, ...(result.warnings || [])];
    renderChronicleLlmEntries(result.entries || [], warnings);
    saveConversationResult(conversation, {
      mode: "chronicle",
      prompt: topic,
      payload: { entries: result.entries || [] },
      warnings,
    });
  } catch (error) {
    renderChronicleNotice("暂时无法调用大模型生成编年。");
  }
}

async function supplementChronicle(conversation, saved) {
  const topic = saved.prompt;
  const documents = collectChronicleDocumentsForLlm(topic, { limit: 0 });
  if (!documents.length) {
    renderChronicleNotice("当前文献范围内暂无可用的整理文本。");
    return;
  }

  renderChronicleLoading();

  try {
    const result = await requestLlmTask("/chronicle/supplement", {
      topic,
      previousEntries: saved.payload?.entries || [],
      documents,
      options: {
        source: "conversation-scope",
        maxEntries: 60,
      },
    });

    if (!result.ready) {
      renderChronicleNotice(result.message || "大模型服务未连接。");
      return;
    }

    const warnings = [...(saved.warnings || []), ...(result.warnings || [])];
    renderChronicleLlmEntries(result.entries || [], warnings);
    saveConversationResult(conversation, {
      mode: "chronicle",
      prompt: topic,
      payload: { entries: result.entries || [] },
      warnings,
    });
  } catch (error) {
    renderChronicleNotice("暂时无法更新编年。");
  }
}

function collectChronicleDocumentsForLlm(topic, options = {}) {
  const records = [];
  const includeAttachments = options.includeAttachments !== false;
  const attachmentDocuments = includeAttachments ? buildConversationAttachmentDocumentsForLlm(topic, 10, 1800) : [];
  const attachmentPageCount = attachmentDocuments.reduce((total, item) => total + item.pages.length, 0);
  const onlyDocumentIds = options.onlyDocumentIds ? new Set(options.onlyDocumentIds) : null;

  getSmartScopeDocuments().forEach((item, documentIndex) => {
    if (onlyDocumentIds && !onlyDocumentIds.has(item.id)) {
      return;
    }
    item.pages.forEach((page, pageIndex) => {
      const text = getSmartPagePrimaryText(page).trim();
      if (!text) {
        return;
      }

      records.push({
        item,
        page,
        documentIndex,
        pageIndex,
        score: scoreChroniclePageForLlm(item, page, text, topic),
      });
    });
  });

  const sortedRecords = records.sort(
    (a, b) => b.score - a.score || a.documentIndex - b.documentIndex || a.pageIndex - b.pageIndex,
  );
  const limit = options.limit === undefined ? Math.max(18, 36 - attachmentPageCount) : options.limit;
  const selectedRecords = limit > 0 ? sortedRecords.slice(0, limit) : sortedRecords;

  const grouped = new Map();
  selectedRecords.forEach(({ item, page }) => {
      if (!grouped.has(item.id)) {
        grouped.set(item.id, {
          documentId: item.id,
          title: getDocumentDisplayTitle(item),
          author: item.author || "",
          year: item.year || "",
          publisher: item.publisher || "",
          tags: item.tags || "",
          pages: [],
        });
      }

      grouped.get(item.id).pages.push({
        pageId: page.id,
        pageNumber: page.pageNumber,
        text: getSmartPagePrimaryText(page).slice(0, 1800),
        notes: (page.notes || "").slice(0, 500),
      });
    });

  return [
    ...Array.from(grouped.values()),
    ...attachmentDocuments,
  ];
}

function scoreChroniclePageForLlm(item, page, text, topic) {
  if (!topic) {
    return 1;
  }

  const normalizedTopic = topic.toLowerCase();
  const haystack = [
    item.title,
    item.author,
    item.publisher,
    item.tags,
    page.notes,
    text,
  ].join("\n").toLowerCase();

  return haystack.includes(normalizedTopic) ? 3 : 1;
}

function countChroniclePagesForLlm() {
  const documentPages = getSmartScopeDocuments().reduce((total, item) => {
    return total + item.pages.filter((page) => getSmartPagePrimaryText(page).trim()).length;
  }, 0);
  return documentPages + countConversationAttachmentChunks(chronicleTopic.value.trim(), 10, 1800);
}

function renderChronicleLoading() {
  renderResultState(chronicleResults, "正在调用大模型生成编年...");
}

function renderChronicleNotice(message) {
  renderResultState(chronicleResults, message);
}

function renderChronicleLlmEntries(entries, warnings = []) {
  chronicleResults.innerHTML = "";
  chronicleResults.classList.remove("empty-result-list");

  if (!entries.length) {
    renderChronicleNotice("未找到可生成编年的日期条目。");
    return;
  }

  entries.forEach((entry, index, list) => {
    const result = document.createElement("article");
    const content = document.createElement("div");
    const title = document.createElement("h4");
    const summary = document.createElement("p");
    const dateLabel = getChronicleDateLabel(entry);
    const sameDay = Boolean(entry.sameDay) || (index > 0 && dateLabel === getChronicleDateLabel(list[index - 1]));

    result.className = "result-item chronicle-item";
    title.textContent = sameDay ? `同日：${dateLabel}` : dateLabel;
    summary.className = "chronicle-summary";
    summary.textContent = `${entry.summary || entry.event || "史事待核"} `;
    summary.append(buildCitationMarkers(entry));

    content.append(title, summary);
    if (Array.isArray(warnings) && warnings.length && index === entries.length - 1) {
      content.append(formatWarnings(warnings));
    }
    result.append(content);
    chronicleResults.append(result);
  });
}

function buildCitationMarkers(entry) {
  const wrap = document.createElement("span");
  wrap.className = "citation-markers";
  const sources = Array.isArray(entry.sources) ? entry.sources : [];
  const conflictText = String(entry.conflict || "").trim();

  if (!sources.length) {
    const missing = document.createElement("span");
    missing.className = "citation citation-missing";
    missing.textContent = "[来源待核]";
    wrap.append(missing);
    return wrap;
  }

  sources.forEach((source, index) => {
    wrap.append(buildCitationMarker(source, index + 1, conflictText));
  });

  if (conflictText) {
    const badge = document.createElement("span");
    badge.className = "citation-conflict";
    badge.textContent = "冲突";
    badge.title = `来源冲突：${conflictText}`;
    wrap.append(badge);
  }
  return wrap;
}

function buildCitationMarker(source, number, conflictText = "") {
  const href = citationHref(source);
  const node = document.createElement(href ? "a" : "span");
  node.className = "citation";
  if (conflictText) {
    node.classList.add("citation-conflict-mark");
  }
  node.textContent = `[${number}]`;
  node.title = formatCitationTooltip(source, conflictText);
  if (href) {
    node.href = href;
    node.target = "_blank";
    node.rel = "noopener";
  }
  return node;
}

function citationHref(source) {
  if (source.sourceType === "conversation-file" || source.attachmentId) {
    const attachment = findConversationAttachment(source.attachmentId || source.documentId, source.title);
    return attachment?.fileUrl || "";
  }

  const target = resolveDocumentSource(source);
  if (!target?.item) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("document", target.item.id);
  if (target.page?.id) {
    params.set("page", target.page.id);
  }
  return `reader.html?${params.toString()}`;
}

function formatCitationTooltip(source, conflictText = "") {
  const author = source.author || "著者未录";
  const title = source.title || "文献名未录";
  const publisher = source.publisher || "出版信息未录";
  const year = source.year || "年份未录";
  const page = source.pageNumber
    ? source.sourceType === "conversation-file"
      ? `内容片段 ${source.pageNumber}`
      : `第 ${source.pageNumber} 页`
    : "";
  const lines = [`${author}：《${title}》`, `${publisher}，${year}${page ? `，${page}` : ""}`];
  if (source.quote) {
    lines.push(`原文：${source.quote}`);
  }
  if (conflictText) {
    lines.push(`冲突：${conflictText}`);
  }
  return lines.join("\n");
}

function getChronicleDateLabel(entry) {
  return entry?.dateLabel || entry?.dateGregorian || entry?.dateOriginal || "日期待核";
}

function searchResultHref(attachment, item, page) {
  if (attachment) {
    return attachment.fileUrl || "";
  }
  if (!item?.id) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("document", item.id);
  const pageId = page?.id || item.pages?.[0]?.id;
  if (pageId) {
    params.set("page", pageId);
  }
  return `reader.html?${params.toString()}`;
}
