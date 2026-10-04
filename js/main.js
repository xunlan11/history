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

newConversationButton?.addEventListener("click", () => {
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

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser?.id) {
    window.alert("当前未登录或登录状态已失效，请重新登录后再登记文献。");
    return;
  }
  const formData = new FormData(form);
  const file = formData.get("file");

  if (!file || !file.name) {
    return;
  }

  const firstPage = createPage(1);
  if (file.type.startsWith("image/")) {
    firstPage.imageDataUrl = URL.createObjectURL(file);
    firstPage.imageName = file.name;
  }
  const item = {
    id: newId(),
    title: textValue("title"),
    author: textValue("author"),
    year: textValue("year"),
    publisher: textValue("publisher"),
    tags: textValue("tags"),
    visibility: "private",
    creator: currentUser?.username ? { username: currentUser.username } : null,
    ownerId: currentUser?.id ?? null,
    canEdit: true,
    metadataStatus: "待自动识别",
    coverImageDataUrl: "",
    coverVariant: getNextDocumentCoverVariant(),
    coverStatus: "待识别封面",
    fileName: file.name,
    fileType: file.type || "unknown",
    fileSize: file.size,
    processingTask: createProcessingTask(file),
    createdAt: new Date().toISOString(),
    status: "待整理",
    pages: [firstPage],
  };

  documents.unshift(item);
  selectedDocumentId = item.id;
  selectedPageId = firstPage.id;
  item.status = "提交逐页处理中";
  persist();
  form.reset();
  closeDocumentForm();
  renderAll();
  setView("reader");
  await Promise.allSettled([
    archiveDocumentSource(item, file),
    detectDocumentCover(item, file),
    submitProcessingTask(item, file),
  ]);
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

editDocumentButton?.addEventListener("click", () => {
  const item = getSelectedDocument();
  const page = getSelectedPage();
  if (!item || !page || !readerText || !canEditDocument(item)) {
    return;
  }

  if (readerEditing) {
    page.punctuatedText = readerText.innerText.trim();
    page.status = page.punctuatedText ? "已保存文字" : "待整理";
    page.updatedAt = new Date().toISOString();
    item.status = summarizeDocumentStatus(item);
    item.updatedAt = new Date().toISOString();
    persist();
    setReaderEditing(false);
    renderAll();
    return;
  }

  setReaderEditing(true);
});

document.querySelector("#smart-send")?.addEventListener("click", runSelectedSmartMode);
document.querySelector("#result-regenerate")?.addEventListener("click", regenerateConversationResult);
document.querySelector("#result-update")?.addEventListener("click", supplementConversation);
const exportPdfButton = document.querySelector("#export-pdf");
if (exportPdfButton) {
  exportPdfButton.addEventListener("click", exportPdf);
}

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

async function runSmartChat(options = {}) {
  const prompt = searchInput.value.trim();

  if (!prompt) {
    renderSmartEmpty();
    return;
  }

  const conversation = getSelectedConversation();
  const saved = conversation?.result;
  if (!options.regenerate && saved?.mode === "chat" && saved.prompt === prompt && saved.payload?.answer) {
    renderChatMessage(prompt, saved.payload.answer, saved.warnings || []);
    updateConversationToolbar();
    return;
  }

  const contextReport = getConversationContextReport();
  if (contextReport.error) {
    renderChatNotice(contextReport.error);
    return;
  }

  upsertConversationFromPrompt(prompt, "chat");
  clearSmartResults();
  renderSmartModeButtons();
  renderConversationList();
  renderActiveConversation();
  messageFeed.scrollTop = 0;

  if (!isLlmServiceConnected()) {
    renderChatNotice("未连接大模型。");
    return;
  }

  renderChatMessage(prompt, "正在思考...");

  try {
    const result = await requestLlmTask("/chat", {
      prompt,
      context: buildLibraryChatContext(prompt),
    });

    if (!result.ready) {
      renderChatNotice(result.message || "未连接大模型。");
      return;
    }

    const answer = result.answer || "未生成回答。";
    renderChatMessage(prompt, answer, contextReport.warnings);
    saveConversationResult(getSelectedConversation(), {
      mode: "chat",
      prompt,
      payload: { answer },
      warnings: contextReport.warnings || [],
    });
  } catch (error) {
    renderChatNotice("暂时无法调用大模型服务。");
  }
}

function runSmartSearch() {
  const prompt = searchInput.value.trim();
  const contextReport = getConversationContextReport();

  if (contextReport.error) {
    renderSearchNotice(contextReport.error);
    return;
  }

  if (prompt) {
    upsertConversationFromPrompt(prompt, "search");
  }

  chronicleTopic.value = "";
  clearSmartResults();
  renderSmartModeButtons();
  renderConversationList();
  renderActiveConversation();
  runSearch();
  messageFeed.scrollTop = 0;
}

function runSmartChronicle() {
  const prompt = searchInput.value.trim();
  const contextReport = getConversationContextReport();

  if (contextReport.error) {
    renderChronicleNotice(contextReport.error);
    return;
  }

  if (prompt) {
    upsertConversationFromPrompt(prompt, "chronicle");
  }

  chronicleTopic.value = prompt;
  clearSmartResults();
  renderSmartModeButtons();
  renderConversationList();
  renderActiveConversation();
  buildChronicle();
  messageFeed.scrollTop = 0;
}

function buildLibraryChatContext(prompt) {
  const entries = [];
  const attachmentEntries = collectConversationAttachmentChatEntries(prompt);

  getSmartScopeDocuments().forEach((item, documentIndex) => {
    item.pages.forEach((page, pageIndex) => {
      const text = getSmartPagePrimaryText(page);
      if (!text) {
        return;
      }

      const snippet = buildSnippet(text, prompt) || text.slice(0, 260);
      entries.push({
        documentId: item.id,
        documentTitle: getDocumentDisplayTitle(item),
        author: item.author || "",
        year: item.year || "",
        pageId: page.id,
        pageNumber: page.pageNumber,
        text: snippet,
        score: scoreTextRelevance(`${item.title}\n${item.author}\n${text}`, prompt),
        documentIndex,
        pageIndex,
      });
    });
  });

  const rankEntries = (items) => items.sort((a, b) => {
    return b.score - a.score || a.documentIndex - b.documentIndex || a.pageIndex - b.pageIndex;
  });
  const selectedEntries = entries.length && attachmentEntries.length
    ? [...rankEntries(attachmentEntries).slice(0, 4), ...rankEntries(entries).slice(0, 4)]
    : rankEntries([...entries, ...attachmentEntries]).slice(0, 8);

  return selectedEntries
    .map(({ score, documentIndex, pageIndex, ...entry }) => entry);
}

function renderChatMessage(prompt, answer, warnings = []) {
  clearSmartResults();

  const result = document.createElement("article");
  const content = document.createElement("div");
  const title = document.createElement("h4");
  const question = document.createElement("p");
  const response = document.createElement("p");

  result.className = "result-item chat-result";
  title.textContent = "对话";
  question.textContent = `问：${prompt}`;
  response.textContent = answer;
  content.append(title, question, response);
  if (warnings.length) {
    content.append(formatWarnings(warnings));
  }
  result.append(content);
  searchResults.append(result);
}

function renderChatNotice(message) {
  clearSmartResults();
  searchResults.classList.add("empty-result-list");

  const empty = emptyState(message);
  empty.classList.add("result-empty");
  searchResults.append(empty);
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
  if (typeof ensureAuthenticated === "function" && !(await ensureAuthenticated())) {
    return;
  }
  await initializeServerData();
  applyRouteSelection();
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
  startPeriodicSync();
}

function resumePendingProcessingTasks() {
  documents.forEach((item) => {
    if (!canEditDocument(item)) return;
    if (!item.processingTask?.remoteTaskId) {
      resumeMissingProcessingTask(item);
      return;
    }
    if (isProcessingTaskPending(item)) {
      startProcessingPolling(item);
      return;
    }

    const task = item.processingTask;
    if (task && ["已完成", "已回填"].includes(task.status)) {
      // OCR 已完成但大模型整理未完成时，恢复逐页流水线。
      enqueueNewProcessingPages(item);
      maybeFinishProcessingPipeline(item);
    }
  });
}

initializeApplication();
refreshOcrServiceStatus();
refreshLlmServiceStatus();
refreshVersionStatus();
setInterval(refreshOcrServiceStatus, 10000);
setInterval(refreshLlmServiceStatus, 10000);
setInterval(refreshVersionStatus, 30000);
versionUpdateButton?.addEventListener("click", requestProjectUpdate);
