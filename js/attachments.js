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
    throw new Error(result.detail || `文件处理失败：${response.status}`);
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
