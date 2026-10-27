let selectedSmartMode = getSelectedConversation()?.mode || "chat";
let pendingDeleteConversationId = null;
let pendingDeleteDocumentId = null;

applyGlobalFont(localStorage.getItem(FONT_STORAGE_KEY) || "hei");

fontOptionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    applyGlobalFont(button.dataset.fontOption);
  });
});

openSettingsButton?.addEventListener("click", () => settingsDialog?.classList.remove("hidden"));
closeSettingsButton?.addEventListener("click", () => settingsDialog?.classList.add("hidden"));
settingsDialog?.addEventListener("click", (event) => {
  if (event.target === settingsDialog) settingsDialog.classList.add("hidden");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") settingsDialog?.classList.add("hidden");
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

document.querySelectorAll("[data-smart-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    selectSmartMode(button.dataset.smartMode);
  });
});

document.querySelector("#close-document-form")?.addEventListener("click", closeDocumentForm);

formSheet?.addEventListener("click", (event) => {
  if (event.target === formSheet) {
    closeDocumentForm();
  }
});

deleteConversationDialog?.addEventListener("click", (event) => {
  if (event.target === deleteConversationDialog) {
    closeDeleteConversationDialog();
  }
});

cancelDeleteConversation?.addEventListener("click", closeDeleteConversationDialog);

confirmDeleteConversation?.addEventListener("click", () => {
  if (pendingDeleteDocumentId) {
    deleteDocument(pendingDeleteDocumentId);
    pendingDeleteDocumentId = null;
    closeDeleteConversationDialog();
    renderAll();
    return;
  }

  if (!pendingDeleteConversationId) {
    closeDeleteConversationDialog();
    return;
  }

  deleteConversation(pendingDeleteConversationId);
  pendingDeleteConversationId = null;
  searchInput.value = "";
  chronicleTopic.value = "";
  clearSmartResults();
  closeDeleteConversationDialog();
  renderAll();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && referenceDocumentDialog && !referenceDocumentDialog.classList.contains("hidden")) {
    closeReferenceDocumentDialog();
    return;
  }

  if (event.key === "Escape" && deleteConversationDialog && !deleteConversationDialog.classList.contains("hidden")) {
    closeDeleteConversationDialog();
  }
});

editChatTitleButton?.addEventListener("mousedown", (event) => {
  // 保持输入框焦点，避免点击按钮时先触发 blur 提交、再被 click 重新置为编辑态。
  if (chatTitleEditingId) {
    event.preventDefault();
  }
});

editChatTitleButton?.addEventListener("click", toggleChatTitleEdit);

chatTitleInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    finishChatTitleEdit(true);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    finishChatTitleEdit(false);
  }
});

chatTitleInput?.addEventListener("blur", (event) => {
  // 点击对号按钮时先失焦，交给按钮的点击逻辑处理，避免重复进入编辑态。
  if (event.relatedTarget === editChatTitleButton) {
    return;
  }
  if (chatTitleEditingId) {
    finishChatTitleEdit(true);
  }
});

newConversationButton?.addEventListener("click", () => {
  const currentConversation = getSelectedConversation();
  if (currentConversation && !(currentConversation.turns || []).length) {
    return;
  }
  if (typeof conversationShareEditingId !== "undefined") {
    conversationShareEditingId = "";
    conversationShareSelectionIds = new Set();
  }
  createConversation("新对话", selectedSmartMode);
  searchInput.value = "";
  chronicleTopic.value = "";
  clearSmartResults();
  renderAll();
  searchInput.focus();
});

document.querySelector("#jump-documents")?.addEventListener("click", () => {
  setView("documents");
});

document.querySelector("#file-input")?.addEventListener("change", (event) => {
  startRegistrationUploads(event.target.files);
  event.target.value = "";
});

// 每部分页数缩在「大串小并」选项里，只有选中它才可以编辑。
const chunkSizeInput = document.querySelector("#chunk-size-input");

function syncProcessingChunkInput() {
  if (!chunkSizeInput) return;
  const mode = form?.querySelector('input[name="processingMode"]:checked')?.value || "chunked";
  chunkSizeInput.disabled = mode !== "chunked";
}

form?.querySelectorAll('input[name="processingMode"]').forEach((input) => {
  input.addEventListener("change", syncProcessingChunkInput);
});
form?.addEventListener("reset", () => queueMicrotask(syncProcessingChunkInput));
syncProcessingChunkInput();

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!currentUser?.id) return window.alert("请先登录后再登记文献。");
  registerSelectedUploads();
});

readerPrevPageButton?.addEventListener("click", () => {
  moveToAdjacentReaderPage(-1);
});

readerNextPageButton?.addEventListener("click", () => {
  moveToAdjacentReaderPage(1);
});

readerPageInput?.addEventListener("change", () => {
  moveToReaderPageIndex(readerPageInput.value);
});

readerPageInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  moveToReaderPageIndex(readerPageInput.value);
  readerPageInput.blur();
});

readerBackButton?.addEventListener("click", returnFromReader);

exportDocumentPdfButton?.addEventListener("click", exportPdf);

editDocumentButton?.addEventListener("click", async () => {
  const item = getSelectedDocument();
  const page = getSelectedPage();
  if (!item || !page || !readerText || !canEditDocument(item)) {
    return;
  }

  if (readerEditing) {
    const editedText = readerText.innerText.trim();
    if (editedText !== getPagePrimaryText(page)) markReaderIndexStale(item.id, page.id);
    page.punctuatedText = editedText;
    page.status = page.punctuatedText ? "已保存文字" : "待整理";
    page.updatedAt = new Date().toISOString();
    item.status = summarizeDocumentStatus(item);
    item.updatedAt = new Date().toISOString();
    persist();
    setReaderEditing(false);
    renderAll();
    await flushPendingSync();
    if (!readerEditing && getSelectedDocument()?.id === item.id && getSelectedPage()?.id === page.id) renderReader();
    return;
  }

  setReaderEditing(true);
});

document.querySelector("#smart-send")?.addEventListener("click", runSelectedSmartMode);

searchInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    runSelectedSmartMode();
  }
});

function runSelectedSmartMode() {
  if (selectedSmartMode === "search") {
    runSmartSearch();
    return;
  }

  if (selectedSmartMode === "chronicle") {
    runSmartChronicle();
    return;
  }

  runSmartChat();
}

function renderSmartModeButtons() {
  if (!searchInput) {
    return;
  }
  const conversation = getSelectedConversation();
  const lockedMode = conversation?.locked ? conversation.mode : "";

  if (lockedMode) {
    selectedSmartMode = lockedMode;
  }

  document.querySelectorAll("[data-smart-mode]").forEach((button) => {
    const isActive = button.dataset.smartMode === selectedSmartMode;
    button.classList.toggle("active", isActive);
    button.disabled = Boolean(lockedMode && button.dataset.smartMode !== lockedMode);
  });
  updateSmartPlaceholder();
}

function selectSmartMode(mode) {
  const conversation = getSelectedConversation();

  if (conversation?.locked && conversation.mode !== mode) {
    selectedSmartMode = conversation.mode;
    renderSmartModeButtons();
    renderActiveConversation();
    return;
  }

  selectedSmartMode = mode;
  setDraftConversationMode(mode);
  renderSmartModeButtons();
  renderConversationList();
  renderActiveConversation();
}

function updateSmartPlaceholder() {
  const placeholders = {
    chat: "输入问题，系统会结合已整理文献回答",
    search: "输入人名、地名、机构、部队番号或原文短语",
    chronicle: "输入人物、地点、机构、战事或关键词",
  };

  searchInput.placeholder = placeholders[selectedSmartMode] || placeholders.chat;
}

function openDeleteConversationDialog(item) {
  pendingDeleteConversationId = item.id;
  pendingDeleteDocumentId = null;
  deleteConversationTitle.textContent = "删除对话";
  deleteConversationMessage.textContent = `确定删除“${item.title || "新对话"}”吗？`;
  deleteConversationDialog.classList.remove("hidden");
  confirmDeleteConversation.focus();
}

function openDeleteDocumentDialog(item) {
  if (!canEditDocument(item)) return;
  pendingDeleteDocumentId = item.id;
  pendingDeleteConversationId = null;
  deleteConversationTitle.textContent = "删除文献";
  deleteConversationMessage.textContent = `确定删除“${getDocumentDisplayTitle(item)}”吗？删除后不可找回。`;
  deleteConversationDialog.classList.remove("hidden");
  confirmDeleteConversation.focus();
}

function closeDeleteConversationDialog() {
  deleteConversationDialog.classList.add("hidden");
  pendingDeleteConversationId = null;
  pendingDeleteDocumentId = null;
}

function runSmartChat() {
  return sendConversationTurn("chat");
}

function runSmartSearch() {
  return sendConversationTurn("search");
}

function runSmartChronicle() {
  return sendConversationTurn("chronicle");
}

function isLlmServiceConnected() {
  return llmServiceStatus?.classList.contains("service-ok");
}

function textValue(name) {
  return form.elements[name].value.trim();
}

function applyGlobalFont(fontKey) {
  const nextFont = fontKey === "kai" ? "kai" : "hei";
  document.documentElement.dataset.font = nextFont;
  localStorage.setItem(FONT_STORAGE_KEY, nextFont);

  fontOptionButtons.forEach((button) => {
    const isActive = button.dataset.fontOption === nextFont;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function moveToAdjacentReaderPage(direction) {
  const item = getSelectedDocument();
  if (!item) {
    return;
  }

  ensureSelectedPage(item);
  const pages = item.pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
  const currentIndex = Math.max(0, pages.findIndex((page) => page.id === selectedPageId));
  const nextPage = pages[currentIndex + direction];

  if (!nextPage) {
    return;
  }

  selectedPageId = nextPage.id;
  renderAll();
}

function moveToReaderPageIndex(value) {
  const item = getSelectedDocument();
  if (!item) {
    return;
  }

  const pages = item.pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
  if (!pages.length) {
    renderAll();
    return;
  }

  const requestedIndex = Number.parseInt(value, 10) - 1;
  const targetIndex = Number.isFinite(requestedIndex)
    ? Math.min(Math.max(requestedIndex, 0), pages.length - 1)
    : 0;

  selectedPageId = pages[targetIndex].id;
  renderAll();
}

async function initializeApplication() {
  if (!(await ensureAuthenticated())) {
    return;
  }
  await initializeServerData();
  applyRouteSelection();
  if (typeof initializeReaderProgress === "function") {
    await initializeReaderProgress();
  }
  selectedSmartMode = getSelectedConversation()?.mode || selectedSmartMode;
  renderAll();
  renderSmartModeButtons();
  if (document.body.dataset.page === "documents" && new URL(window.location.href).searchParams.get("new") === "1") {
    openDocumentForm();
    const url = new URL(window.location.href);
    url.searchParams.delete("new");
    window.history.replaceState(null, "", url.href);
  }
  resumePendingProcessingTasks();
  flushPendingProcessingCancels();
  startPeriodicSync();
  if (document.body.dataset.page !== "reader" && typeof initializeDocumentPreparation === "function") {
    initializeDocumentPreparation();
  }
}

function resumePendingProcessingTasks() {
  documents.forEach((item) => {
    if (isProcessingTaskPending(item)) {
      startProcessingPolling(item);
      refreshProcessingDocument(item, { silent: true }).finally(() => renderAll());
    }
  });
}

initializeApplication();
refreshOcrServiceStatus();
refreshEmbeddingServiceStatus();
refreshLlmServiceStatus();
refreshVersionStatus();
setInterval(refreshOcrServiceStatus, 10000);
setInterval(refreshEmbeddingServiceStatus, 10000);
setInterval(refreshLlmServiceStatus, 10000);
setInterval(refreshVersionStatus, 30000);
versionUpdateButton?.addEventListener("click", requestProjectUpdate);
