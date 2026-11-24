// 阅读页的「修改」入口：复用首次登记的弹窗，把新文件合并到现有原件之前/之后，
// 也可以只改元数据或处理方式。
const reviseDocumentButton = document.querySelector("#revise-document");
const reviseFormTitle = document.querySelector("#add-document-title");
const EXISTING_SOURCE_ID = "existing-source";
const REVISION_FIELDS = {
  title: "#title-input",
  author: "#author-input",
  publisher: "#publisher-input",
  year: "#year-input",
  tags: "#tags-input",
};

function revisionFieldValue(name) {
  const input = form?.querySelector(REVISION_FIELDS[name]);
  return input ? input.value.trim() : "";
}

function revisionExistingName(item) {
  return item?.sourceFile?.fileName || item?.fileName || "已有原件";
}

function revisionExistingState(item) {
  return {
    id: EXISTING_SOURCE_ID,
    existing: true,
    file: { name: revisionExistingName(item) },
    controller: new AbortController(),
    status: "ready",
    percent: 100,
    error: "",
  };
}

function syncReviseDocumentButton(item) {
  if (!reviseDocumentButton) return;
  const canRevise = Boolean(item && canEditDocument(item) && item.processingTask?.backendManaged);
  reviseDocumentButton.disabled = !canRevise;
  reviseDocumentButton.classList.toggle("hidden", !item);
}

function openRevisionForm() {
  const item = getSelectedDocument();
  if (!form || !formSheet || !item || !canEditDocument(item)) return;
  if (!item.processingTask?.backendManaged) {
    showUploadToast("这篇文献还没有后端处理任务，暂时无法修改。");
    return;
  }
  if (registrationBatch?.status === "submitting") return;
  cancelRegistrationUpload();
  formSheet.dataset.shelfFolderId = "";
  if (reviseFormTitle) reviseFormTitle.textContent = "修改";
  const infoHint = form?.querySelector("#document-info-title + span");
  if (infoHint) infoHint.textContent = "可留空，不会自动识别";
  const values = {
    title: item.title || "",
    author: item.author || "",
    publisher: item.publisher || "",
    year: item.year || "",
    tags: item.tags || "",
  };
  for (const [name, selector] of Object.entries(REVISION_FIELDS)) {
    const input = form?.querySelector(selector);
    if (input) input.value = values[name];
  }
  const mode = normalizeProcessingMode(item.processingMode);
  const modeInput = form?.querySelector(`input[name="processingMode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  const chunkInput = form?.querySelector("#chunk-size-input");
  if (chunkInput) chunkInput.value = String(clampChunkSize(item.processingChunkSize));
  if (syncProcessingChunkInput) syncProcessingChunkInput();
  registrationBatch = {
    id: newId(),
    files: [revisionExistingState(item)],
    existing: { documentId: item.id },
    status: "editing",
    controller: new AbortController(),
    error: "",
  };
  renderRegistrationUploads();
  const errorNode = document.querySelector("#registration-error");
  if (errorNode) errorNode.textContent = "";
  formSheet.classList.remove("hidden");
}

function acceptRevisedDocument(payload) {
  const incoming = normalizeDocuments([payload.document])[0];
  if (!incoming?.processingTask?.backendManaged) throw new Error("服务端未确认修改成功");
  const index = documents.findIndex((item) => item.id === incoming.id);
  if (index < 0) documents.unshift(incoming); else documents[index] = incoming;
  cacheCurrentState();
  registrationBatch = null;
  document.querySelector("#upload-file-list")?.replaceChildren();
  form?.reset();
  renderRegistrationUploads();
  formSheet?.classList.add("hidden");
  selectedDocumentId = incoming.id;
  // 页 id 不随页码变化，继续停在原来那一页。
  ensureSelectedPage(incoming);
  startProcessingPolling(incoming);
  renderAll();
}

async function submitDocumentRevision(batch) {
  const existingIndex = batch.files.findIndex((state) => state.existing);
  const formData = new FormData(form);
  const body = {
    uploadIds: batch.files.filter((state) => !state.existing).map((state) => state.id),
    existingIndex: Math.max(0, existingIndex),
    title: revisionFieldValue("title"),
    author: revisionFieldValue("author"),
    publisher: revisionFieldValue("publisher"),
    year: revisionFieldValue("year"),
    tags: revisionFieldValue("tags"),
    processingMode: normalizeProcessingMode(formData.get("processingMode")),
    processingChunkSize: clampChunkSize(formData.get("chunkSize")),
  };
  batch.status = "submitting";
  batch.error = "";
  renderRegistrationUploads();
  try {
    // 先把本地未同步的改动推上去，避免稍后的推送覆盖刚提交的元数据。
    await flushPendingSync();
    const response = await fetch(`${DATA_PROCESSING_URL}/${encodeURIComponent(batch.existing.documentId)}/revise`, {
      method: "POST",
      signal: batch.controller.signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).detail || ""; } catch {}
      throw new Error(typeof detail === "string" && detail ? detail : `请求失败（HTTP ${response.status}）`);
    }
    const result = await response.json();
    if (registrationBatch === batch) acceptRevisedDocument(result);
  } catch (error) {
    if (registrationBatch !== batch) return;
    batch.status = "editing";
    batch.error = `修改失败：${error.message}。可调整后重新提交。`;
    renderRegistrationUploads();
  }
}

reviseDocumentButton?.addEventListener("click", openRevisionForm);
