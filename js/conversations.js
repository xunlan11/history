const conversationTurnRequests = new Map();
let conversationPromptEditor = null;
let pendingReferenceDocumentIds = new Set();

function ensureReferenceConversation() {
  return getSelectedConversation() || createConversation("新对话", selectedSmartMode || "chat");
}

function isReferenceScopeActive(conversation = getSelectedConversation()) {
  return getConversationReferenceDocumentIds(conversation).length > 0;
}

function getSmartScopeDocuments(conversation = getSelectedConversation()) {
  if (Array.isArray(conversation?.materialDocumentIds)) {
    const ids = new Set(conversation.materialDocumentIds);
    return documents.filter((item) => ids.has(item.id));
  }
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

  const base = `新一轮提问将使用所选 ${referenceIds.length} 篇文献的处理后数据。`;
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
    showUploadToast(`每个对话最多上传 ${MAX_CONVERSATION_ATTACHMENTS} 个文件。`);
    return;
  }
  if (files.length > accepted.length) {
    showUploadToast(`每个对话最多上传 ${MAX_CONVERSATION_ATTACHMENTS} 个文件，本次只处理前 ${accepted.length} 个。`);
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

function collectConversationAttachmentChatEntries(prompt, conversation = getSelectedConversation()) {
  const entries = [];
  getConversationAttachmentReport(conversation).ready.forEach((attachment, attachmentIndex) => {
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

function buildConversationAttachmentDocumentsForLlm(query, maxChunks = 10, chunkLength = 1600, conversation = getSelectedConversation()) {
  const records = [];
  getConversationAttachmentReport(conversation).ready.forEach((attachment, attachmentIndex) => {
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
function collectSearchDocumentsForLlm(query, conversation = getSelectedConversation()) {
  const records = [];
  const attachmentDocuments = buildConversationAttachmentDocumentsForLlm(query, 12, 1600, conversation);
  const attachmentPageCount = attachmentDocuments.reduce((total, item) => total + item.pages.length, 0);

  getSmartScopeDocuments(conversation).forEach((item, documentIndex) => {
    const metadata = buildSearchMetadata(item);

    item.pages.forEach((page, pageIndex) => {
      const text = getSmartPageSearchText(page, conversation).trim();
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
        text: getSmartPageSearchText(page, conversation).slice(0, 1600),
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

function renderLlmSearchResults(matches, warnings = [], query = "", container = searchResults) {
  container.innerHTML = "";
  container.classList.remove("empty-result-list");

  if (!matches.length) {
    renderResultState(container, "未找到匹配内容");
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
    container.append(result);
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
function collectChronicleDocumentsForLlm(topic, options = {}, conversation = getSelectedConversation()) {
  const records = [];
  const includeAttachments = options.includeAttachments !== false;
  const attachmentDocuments = includeAttachments ? buildConversationAttachmentDocumentsForLlm(topic, 10, 1800, conversation) : [];
  const attachmentPageCount = attachmentDocuments.reduce((total, item) => total + item.pages.length, 0);
  const onlyDocumentIds = options.onlyDocumentIds ? new Set(options.onlyDocumentIds) : null;

  getSmartScopeDocuments(conversation).forEach((item, documentIndex) => {
    if (onlyDocumentIds && !onlyDocumentIds.has(item.id)) {
      return;
    }
    item.pages.forEach((page, pageIndex) => {
      const text = getSmartPagePrimaryText(page, conversation).trim();
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
        text: getSmartPagePrimaryText(page, conversation).slice(0, 1800),
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

function renderChronicleLlmEntries(entries, warnings = [], container = chronicleResults) {
  container.innerHTML = "";
  container.classList.remove("empty-result-list");

  if (!entries.length) {
    renderResultState(container, "未找到可生成编年的日期条目。");
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
    container.append(result);
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

// 对话轮次：保存原始请求，供编辑和重新生成使用。
function isConversationTurnRunning(conversationId, turnId) {
  return conversationTurnRequests.get(conversationId)?.turnId === turnId;
}

function getConversationTurn(conversationId, turnId) {
  const conversation = conversations.find((item) => item.id === conversationId);
  const turn = conversation?.turns?.find((item) => item.id === turnId);
  return { conversation, turn };
}

function getConversationTurnHistory(conversation, beforeTurnId = "") {
  const turns = conversation.turns || [];
  const index = beforeTurnId ? turns.findIndex((turn) => turn.id === beforeTurnId) : turns.length;
  return turns.slice(0, Math.max(0, index)).filter((turn) => turn.result).map((turn) => ({
    mode: turn.mode,
    prompt: turn.prompt,
    payload: turn.result.payload,
  }));
}

function captureConversationTurnRequest(conversation, mode, prompt, beforeTurnId = "") {
  const report = getConversationContextReport(conversation);
  if (report.error) throw new Error(report.error);
  const options = { source: "conversation-context", history: getConversationTurnHistory(conversation, beforeTurnId) };
  let body;
  if (mode === "chat") {
    body = { prompt, context: buildLibraryChatContext(prompt, conversation), options };
  } else {
    const documents = mode === "search"
      ? collectSearchDocumentsForLlm(prompt, conversation)
      : collectChronicleDocumentsForLlm(prompt, {}, conversation);
    if (!documents.length) throw new Error("暂无可用于" + (mode === "search" ? "检索" : "生成编年") + "的整理文本。");
    const totalPageCount = getSmartScopeDocuments(conversation).reduce((total, item) => total +
      item.pages.filter((page) => (mode === "search" ? getSmartPageSearchText(page, conversation) :
        getSmartPagePrimaryText(page, conversation)).trim()).length, 0) +
      documents.filter((item) => item.sourceType === "conversation-file").reduce((total, item) => total + item.pages.length, 0);
    body = mode === "search"
      ? { query: prompt, documents, options: { ...options, maxMatches: 50, totalPageCount } }
      : { topic: prompt, documents, options: { ...options, maxEntries: 40, totalPageCount } };
  }
  const sources = mode === "chat" ? body.context : body.documents;
  const sourceDocumentIds = [...new Set(sources.filter((item) => item.sourceType !== "conversation-file").map((item) => item.documentId))];
  const request = { path: "/" + mode, body, warnings: report.warnings, sourceDocumentIds };
  if (mode === "search") {
    // Keep the offline fallback independent of future library/reference changes too.
    request.literalSources = getSmartScopeDocuments(conversation).flatMap((item) => [
      { documentId: item.id, title: getDocumentDisplayTitle(item), author: item.author, year: item.year,
        text: buildSearchMetadata(item) },
      ...item.pages.map((page) => ({ documentId: item.id, title: getDocumentDisplayTitle(item),
        author: item.author, year: item.year, pageId: page.id, pageNumber: page.pageNumber,
        text: getSmartPageSearchText(page, conversation) })),
    ]);
    getConversationAttachmentReport(conversation).ready.forEach((attachment) => {
      splitConversationAttachmentText(attachment.extractedText, 1600).forEach((text, index) => {
        request.literalSources.push({ sourceType: "conversation-file", attachmentId: attachment.id,
          documentId: attachment.id, title: attachment.fileName, pageNumber: index + 1, text });
      });
    });
  }
  return JSON.parse(JSON.stringify(request));
}

function getLegacyTurnRequest(conversation, turn) {
  const ids = turn.result?.sourceDocumentIds || [];
  const scope = { ...conversation, referenceDocumentIds: ids, materialDocumentIds: ids };
  // Legacy records did not store request materials. Restrict their first retry to recorded sources.
  if (!scope.referenceDocumentIds.length) {
    scope.referenceDocumentIds = ["__no_recorded_source__"];
  }
  const request = captureConversationTurnRequest(scope, turn.mode, turn.prompt, turn.id);
  request.warnings.push("此旧记录未保存当时的材料；本次重试使用已记录文献的现有文本。");
  return request;
}

async function sendConversationTurn(mode) {
  const prompt = searchInput?.value.trim();
  if (!prompt) return;
  let conversation = getSelectedConversation();
  if (conversationTurnRequests.has(conversation?.id)) return;
  mode = conversation?.locked ? conversation.mode : mode;
  conversation = conversation || createConversation("新对话", mode);
  let request;
  try {
    request = captureConversationTurnRequest(conversation, mode, prompt);
  } catch (error) {
    showUploadToast(error.message);
    return;
  }
  conversation = upsertConversationFromPrompt(prompt, mode);
  conversation.turns = conversation.turns || [];
  const timestamp = new Date().toISOString();
  const turn = { id: newId(), mode, prompt, request, status: "pending", error: "", result: null,
    createdAt: timestamp, updatedAt: timestamp };
  conversation.turns.push(turn);
  searchInput.value = "";
  chronicleTopic.value = "";
  conversationPromptEditor = null;
  await generateConversationTurn(conversation.id, turn.id, true);
}

function literalConversationTurnResult(turn) {
  const matches = (turn.request.literalSources || []).flatMap(({ text, ...source }) => {
    const quote = buildSnippet(text, turn.prompt);
    return quote ? [{ ...source, quote, matchType: "字面匹配" }] : [];
  });
  return { ready: true, matches, warnings: ["未连接大模型，已使用字面检索；异称、字号、别名可能无法召回。"] };
}

async function generateConversationTurn(conversationId, turnId, scrollToTurn = false) {
  let { conversation, turn } = getConversationTurn(conversationId, turnId);
  if (!conversation || !turn || conversationTurnRequests.has(conversationId)) return;
  const token = { turnId };
  conversationTurnRequests.set(conversationId, token);
  turn.status = "pending";
  turn.error = "";
  turn.updatedAt = new Date().toISOString();
  conversation.updatedAt = turn.updatedAt;
  persistConversations();
  refreshConversationTurnView(conversationId, scrollToTurn);
  try {
    if (!turn.request) turn.request = getLegacyTurnRequest(conversation, turn);
    // Persist before sending so a page interruption still leaves a retryable request.
    persistConversations();
    const request = JSON.parse(JSON.stringify(turn.request));
    if (request.path !== "/" + turn.mode) throw new Error("无法重试此记录，请编辑提示词后重新发送。");
    let response;
    if (!isLlmServiceConnected() && turn.mode === "search") {
      response = literalConversationTurnResult(turn);
    } else {
      if (!isLlmServiceConnected()) throw new Error("未连接大模型，请连接后点击重新生成。");
      response = await requestLlmTask(request.path, request.body);
    }
    if (!response.ready) throw new Error(response.message || "暂时无法调用大模型服务，请重新生成。");
    ({ conversation, turn } = getConversationTurn(conversationId, turnId));
    if (!conversation || !turn || conversationTurnRequests.get(conversationId) !== token) return;
    const payload = turn.mode === "chat" ? { answer: response.answer || "未生成回答。" }
      : turn.mode === "search" ? { matches: response.matches || [], expandedTerms: response.expandedTerms || [] }
      : { entries: response.entries || [] };
    turn.result = { mode: turn.mode, prompt: turn.prompt, payload,
      warnings: [...new Set([...(request.warnings || []), ...(response.warnings || [])])],
      sourceDocumentIds: request.sourceDocumentIds || [], generatedAt: new Date().toISOString() };
    turn.status = "completed";
    turn.updatedAt = turn.result.generatedAt;
    conversation.result = conversation.turns.slice().reverse().find((item) => item.result)?.result || null;
  } catch (error) {
    ({ conversation, turn } = getConversationTurn(conversationId, turnId));
    if (conversation && turn && conversationTurnRequests.get(conversationId) === token) {
      turn.status = "failed";
      turn.error = error.message || "回答中断，请点击重新生成。";
      turn.updatedAt = new Date().toISOString();
    }
  } finally {
    if (conversationTurnRequests.get(conversationId) === token) conversationTurnRequests.delete(conversationId);
    if (conversation && turn) {
      conversation.updatedAt = turn.updatedAt;
      persistConversations();
    }
    refreshConversationTurnView(conversationId);
  }
}

function retryConversationTurn(conversationId, turnId) {
  return generateConversationTurn(conversationId, turnId);
}

function startConversationPromptEdit(conversationId, turnId) {
  const { turn } = getConversationTurn(conversationId, turnId);
  if (!turn || conversationTurnRequests.has(conversationId)) return;
  conversationPromptEditor = { conversationId, turnId, prompt: turn.prompt };
  renderConversationTurns();
  const textarea = searchResults.querySelector(".conversation-prompt-editor textarea");
  textarea?.focus();
  textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function saveConversationPromptEdit(conversationId, turnId, value) {
  const prompt = value.trim();
  const { conversation, turn } = getConversationTurn(conversationId, turnId);
  if (!prompt || !turn || conversationTurnRequests.has(conversationId)) return;
  let request;
  try {
    request = JSON.parse(JSON.stringify(turn.request || getLegacyTurnRequest(conversation, turn)));
  } catch (error) {
    showUploadToast(error.message);
    return;
  }
  const promptKey = turn.mode === "chat" ? "prompt" : turn.mode === "search" ? "query" : "topic";
  request.body[promptKey] = prompt;
  const index = conversation.turns.findIndex((item) => item.id === turnId);
  conversation.turns = conversation.turns.slice(0, index + 1);
  turn.prompt = prompt;
  turn.request = request;
  turn.result = null;
  conversation.result = conversation.turns.slice(0, -1).reverse().find((item) => item.result)?.result || null;
  if (index === 0) conversation.title = prompt;
  conversationPromptEditor = null;
  await generateConversationTurn(conversationId, turnId);
}

function refreshConversationTurnView(conversationId, scrollToTurn = false) {
  renderConversationList();
  if (selectedConversationId !== conversationId) return;
  renderSmartModeButtons();
  renderActiveConversation();
  if (scrollToTurn) messageFeed.scrollTop = messageFeed.scrollHeight;
}

function createConversationTurnAction(label, icon, handler, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "conversation-turn-action";
  button.title = label;
  button.setAttribute("aria-label", label);
  const paths = icon === "edit"
    ? '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>'
    : '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  button.disabled = disabled;
  button.addEventListener("click", handler);
  return button;
}

function renderConversationPromptEditor(container, conversation, turn) {
  const editor = document.createElement("form");
  editor.className = "conversation-prompt-editor";
  const textarea = document.createElement("textarea");
  textarea.value = conversationPromptEditor.prompt;
  textarea.setAttribute("aria-label", "编辑已发送的提示词");
  textarea.required = true;
  const actions = document.createElement("div");
  actions.className = "conversation-edit-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary-button";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => { conversationPromptEditor = null; renderConversationTurns(); });
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary-button";
  save.textContent = "保存并重新生成";
  save.disabled = !textarea.value.trim();
  textarea.addEventListener("input", () => {
    conversationPromptEditor.prompt = textarea.value;
    save.disabled = !textarea.value.trim();
  });
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    saveConversationPromptEdit(conversation.id, turn.id, textarea.value);
  });
  editor.append(textarea);
  if (conversation.turns.at(-1).id !== turn.id) {
    const notice = document.createElement("p");
    notice.className = "meta-line";
    notice.textContent = "修改这一轮后将重新生成回答，并移除后续轮次。";
    editor.append(notice);
  }
  actions.append(cancel, save);
  editor.append(actions);
  container.append(editor);
}

function renderConversationTurns() {
  if (!searchResults || !chronicleResults) return;
  const conversation = getSelectedConversation();
  const turns = conversation?.turns || [];
  const busy = conversationTurnRequests.has(conversation?.id);
  const feedScroll = messageFeed.scrollTop;
  const editingInput = searchResults.querySelector(".conversation-prompt-editor textarea");
  const editingFocus = editingInput && document.activeElement === editingInput
    ? [editingInput.selectionStart, editingInput.selectionEnd] : null;
  searchResults.replaceChildren();
  searchResults.classList.remove("empty-result-list");
  searchResults.classList.add("conversation-history");
  chronicleResults.replaceChildren();
  chronicleResults.classList.remove("empty-result-list");
  const send = document.querySelector("#smart-send");
  if (send) send.disabled = busy;
  turns.forEach((turn, index) => {
    const article = document.createElement("article");
    article.className = "conversation-turn";
    article.dataset.turnId = turn.id;
    article.setAttribute("aria-label", "第 " + (index + 1) + " 轮");
    const question = document.createElement("div");
    question.className = "conversation-question";
    if (conversationPromptEditor?.conversationId === conversation.id && conversationPromptEditor.turnId === turn.id) {
      renderConversationPromptEditor(question, conversation, turn);
    } else {
      const prompt = document.createElement("p");
      prompt.className = "conversation-prompt";
      prompt.textContent = turn.prompt;
      const actions = document.createElement("div");
      actions.className = "conversation-prompt-actions";
      actions.append(createConversationTurnAction("编辑提示词", "edit", () => startConversationPromptEdit(conversation.id, turn.id), busy));
      question.append(prompt, actions);
    }
    const answer = document.createElement("div");
    answer.className = "conversation-answer";
    if (turn.result) {
      if (turn.mode === "chat") {
        const text = document.createElement("p");
        text.className = "conversation-answer-text";
        text.textContent = turn.result.payload.answer;
        answer.append(text);
        if (turn.result.warnings.length) answer.append(formatWarnings(turn.result.warnings));
      } else if (turn.mode === "search") {
        renderLlmSearchResults(turn.result.payload.matches || [], turn.result.warnings, turn.prompt, answer);
      } else {
        renderChronicleLlmEntries(turn.result.payload.entries || [], turn.result.warnings, answer);
      }
    }
    if (turn.status === "pending" || turn.error) {
      const status = document.createElement("p");
      status.className = "conversation-turn-status";
      status.setAttribute("role", turn.status === "pending" ? "status" : "alert");
      status.textContent = turn.status === "pending" ? "正在生成回答…" : turn.error;
      answer.append(status);
    }
    const footer = document.createElement("div");
    footer.className = "conversation-answer-actions";
    footer.append(createConversationTurnAction("重新生成", "refresh", () => retryConversationTurn(conversation.id, turn.id), busy));
    if (turn.result) {
      const sources = document.createElement("span");
      sources.className = "conversation-turn-meta";
      sources.textContent = "依据 " + turn.result.sourceDocumentIds.length + " 篇文献";
      footer.append(sources);
    }
    article.append(question, answer, footer);
    searchResults.append(article);
  });
  messageFeed.scrollTop = feedScroll;
}

let conversationShareEditingId = "";
let conversationShareSelectionIds = new Set();

function getConversationShareAnswerPreview(turn) {
  const payload = turn?.result?.payload || {};
  if (turn?.mode === "search") {
    return (payload.matches || []).map((item) => item.quote || item.snippet || item.summary || item.title || "").filter(Boolean).join("；");
  }
  if (turn?.mode === "chronicle") {
    return (payload.entries || []).map((item) => item.summary || item.event || "").filter(Boolean).join("；");
  }
  return payload.answer || "";
}

function openConversationShareEditor(item) {
  if (!item?.id) return;
  selectedConversationId = item.id;
  selectedSmartMode = item.mode || "chat";
  conversationShareEditingId = item.id;
  conversationShareSelectionIds = new Set(item.share?.selectedTurnIds || []);
  renderSmartModeButtons();
  renderConversationList();
  renderActiveConversation();
  renderReferenceDocuments();
  renderConversationAttachments();
  messageFeed.scrollTop = 0;
}

function closeConversationShareEditor() {
  conversationShareEditingId = "";
  conversationShareSelectionIds = new Set();
  conversationShareEditor?.classList.add("hidden");
  if (conversationShareSelection) conversationShareSelection.replaceChildren();
  if (conversationShareLink) {
    conversationShareLink.replaceChildren();
    conversationShareLink.classList.add("hidden");
  }
  renderActiveConversation();
}

function renderConversationShareEditor() {
  const conversation = getSelectedConversation();
  if (!conversationShareEditor || conversationShareEditingId !== conversation?.id) {
    conversationShareEditor?.classList.add("hidden");
    return;
  }
  conversationShareEditor.classList.remove("hidden");
  conversationShareSelection?.replaceChildren();
  const turns = conversation.turns || [];
  turns.forEach((turn, index) => {
    const completed = turn.status === "completed" && Boolean(turn.result);
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const body = document.createElement("span");
    const prompt = document.createElement("strong");
    const preview = document.createElement("span");
    label.className = "conversation-share-choice";
    label.classList.toggle("disabled", !completed);
    checkbox.type = "checkbox";
    checkbox.value = turn.id;
    checkbox.checked = completed && conversationShareSelectionIds.has(turn.id);
    checkbox.disabled = !completed;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) conversationShareSelectionIds.add(turn.id);
      else conversationShareSelectionIds.delete(turn.id);
      updateConversationShareSelectionSummary();
    });
    prompt.textContent = `${index + 1}. ${turn.prompt || "未命名提问"}`;
    preview.textContent = completed ? getConversationShareAnswerPreview(turn) : (turn.error || "回答尚未完成");
    body.append(prompt, preview);
    label.append(checkbox, body);
    conversationShareSelection?.append(label);
  });
  const hasExisting = Boolean(conversation.share?.active && conversation.share?.token);
  if (saveConversationShareButton) saveConversationShareButton.textContent = hasExisting ? "更新分享链接" : "创建分享链接";
  deleteConversationShareButton?.classList.toggle("hidden", !hasExisting);
  if (conversationShareStatus) conversationShareStatus.textContent = hasExisting ? "可修改分享内容，链接地址保持不变。" : "选择后将按原对话顺序展示。";
  updateConversationShareSelectionSummary();
  if (hasExisting) {
    showConversationShareLink(conversation.share.token);
  } else if (conversationShareLink) {
    conversationShareLink.replaceChildren();
    conversationShareLink.classList.add("hidden");
  }
}

function updateConversationShareSelectionSummary() {
  const selected = conversationShareSelection
    ? Array.from(conversationShareSelection.querySelectorAll("input:checked"))
    : [];
  if (conversationShareCount) conversationShareCount.textContent = `已选择 ${selected.length} 轮`;
  if (saveConversationShareButton) saveConversationShareButton.disabled = selected.length === 0;
}

function conversationShareLinkForToken(token) {
  const url = new URL("share.html", window.location.href);
  url.search = `?token=${encodeURIComponent(token)}`;
  return url.href;
}

function showConversationShareLink(token) {
  if (!conversationShareLink || !token) return;
  const url = conversationShareLinkForToken(token);
  conversationShareLink.replaceChildren();
  const label = document.createElement("span");
  const link = document.createElement("a");
  const copy = document.createElement("button");
  label.textContent = "分享链接：";
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = url;
  copy.className = "secondary-button";
  copy.type = "button";
  copy.textContent = "复制";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = "已复制";
      window.setTimeout(() => { copy.textContent = "复制"; }, 1200);
    } catch (_) {
      window.prompt("复制分享链接", url);
    }
  });
  conversationShareLink.append(label, link, copy);
  conversationShareLink.classList.remove("hidden");
}

function selectedConversationShareTurnIds(conversation) {
  const selected = new Set(conversationShareSelection
    ? Array.from(conversationShareSelection.querySelectorAll("input:checked")).map((input) => input.value)
    : []);
  return (conversation?.turns || []).filter((turn) => selected.has(turn.id)).map((turn) => turn.id);
}

async function saveConversationShare() {
  const conversation = getSelectedConversation();
  if (!conversation || !conversationShareEditingId) return;
  const turnIds = selectedConversationShareTurnIds(conversation);
  if (!turnIds.length) {
    if (conversationShareStatus) conversationShareStatus.textContent = "请至少选择一轮已完成的对话。";
    return;
  }
  saveConversationShareButton.disabled = true;
  if (conversationShareStatus) conversationShareStatus.textContent = "正在保存分享内容…";
  try {
    persistConversations();
    await flushPendingSync();
    const existingToken = conversation.share?.active ? conversation.share.token : "";
    const response = await fetch(existingToken ? `${CONVERSATION_SHARE_API_URL}/${encodeURIComponent(existingToken)}` : CONVERSATION_SHARE_API_URL, {
      method: existingToken ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: conversation.id, turnIds }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `分享保存失败（${response.status}）`);
    conversation.share = normalizeConversationShare({ token: payload.token, selectedTurnIds: payload.selectedTurnIds, active: true, updatedAt: payload.updatedAt });
    conversationShareSelectionIds = new Set(turnIds);
    persistConversations();
    renderConversationList();
    renderConversationShareEditor();
    if (conversationShareStatus) conversationShareStatus.textContent = existingToken ? "分享内容已更新，链接保持不变。" : "分享链接已创建。";
  } catch (error) {
    if (conversationShareStatus) conversationShareStatus.textContent = error.message || "分享保存失败。";
  } finally {
    saveConversationShareButton.disabled = false;
    updateConversationShareSelectionSummary();
  }
}

async function deleteConversationShare() {
  const conversation = getSelectedConversation();
  const token = conversation?.share?.active ? conversation.share.token : "";
  if (!conversation || !token || !window.confirm("删除后此分享链接将立即失效，确定删除吗？")) return;
  deleteConversationShareButton.disabled = true;
  try {
    const response = await fetch(`${CONVERSATION_SHARE_API_URL}/${encodeURIComponent(token)}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `删除失败（${response.status}）`);
    conversation.share = null;
    persistConversations();
    renderConversationList();
    closeConversationShareEditor();
  } catch (error) {
    if (conversationShareStatus) conversationShareStatus.textContent = error.message || "删除分享失败。";
  } finally {
    deleteConversationShareButton.disabled = false;
  }
}

closeConversationShareButton?.addEventListener("click", closeConversationShareEditor);
selectAllConversationShareButton?.addEventListener("click", () => {
  const conversation = getSelectedConversation();
  conversationShareSelectionIds = new Set((conversation?.turns || []).filter((turn) => turn.status === "completed" && turn.result).map((turn) => turn.id));
  renderConversationShareEditor();
});
saveConversationShareButton?.addEventListener("click", saveConversationShare);
deleteConversationShareButton?.addEventListener("click", deleteConversationShare);