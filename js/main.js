let selectedSmartMode = getSelectedConversation()?.mode || "chat";
let pendingDeleteConversationId = null;
let pendingDeleteDocumentId = null;

applyGlobalFont(localStorage.getItem(FONT_STORAGE_KEY) || "hei");

fontOptionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    applyGlobalFont(button.dataset.fontOption);
  });
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

document.querySelectorAll("[data-smart-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    selectSmartMode(button.dataset.smartMode);
  });
});

document.querySelector("#close-document-form").addEventListener("click", closeDocumentForm);

formSheet.addEventListener("click", (event) => {
  if (event.target === formSheet) {
    closeDocumentForm();
  }
});

deleteConversationDialog.addEventListener("click", (event) => {
  if (event.target === deleteConversationDialog) {
    closeDeleteConversationDialog();
  }
});

cancelDeleteConversation.addEventListener("click", closeDeleteConversationDialog);

confirmDeleteConversation.addEventListener("click", () => {
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
  if (event.key === "Escape" && !deleteConversationDialog.classList.contains("hidden")) {
    closeDeleteConversationDialog();
  }
});

newConversationButton.addEventListener("click", () => {
  createConversation("新对话", selectedSmartMode);
  searchInput.value = "";
  chronicleTopic.value = "";
  clearSmartResults();
  renderAll();
  searchInput.focus();
});

document.querySelector("#jump-documents").addEventListener("click", () => {
  setView("documents");
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const file = formData.get("file");

  if (!file || !file.name) {
    return;
  }

  const firstPage = createPage(1);
  const item = {
    id: newId(),
    title: textValue("title"),
    author: textValue("author"),
    year: textValue("year"),
    publisher: textValue("publisher"),
    tags: textValue("tags"),
    metadataStatus: "待自动识别",
    coverImageDataUrl: "",
    coverVariant: getNextDocumentCoverVariant(),
    coverStatus: "待识别封面",
    fileName: file.name,
    fileType: file.type || "unknown",
    fileSize: file.size,
    processMode: formData.get("processMode") || "offline",
    offlineTask: null,
    createdAt: new Date().toISOString(),
    status: "待整理",
    pages: [firstPage],
  };

  documents.unshift(item);
  selectedDocumentId = item.id;
  selectedPageId = firstPage.id;
  detectDocumentCover(item, file);

  if (item.processMode === "offline") {
    item.offlineTask = createOfflineTask(file);
    item.status = "提交整本处理中";
    persist();
    form.reset();
    closeDocumentForm();
    renderAll();
    setView("workspace");
    submitOfflineTask(item, file);
    return;
  }

  if (file.type.startsWith("image/")) {
    readImageFile(file, (image) => {
      firstPage.imageDataUrl = image.dataUrl;
      firstPage.imageName = file.name;
      firstPage.updatedAt = new Date().toISOString();
      persist();
      form.reset();
      closeDocumentForm();
      renderAll();
      setView("workspace");
    });
    return;
  }

  persist();
  form.reset();
  closeDocumentForm();
  renderAll();
  setView("workspace");
});

document.querySelector("#add-page").addEventListener("click", () => {
  const item = getSelectedDocument();
  if (!item) {
    return;
  }

  const pageNumber = Math.max(1, Number(pageNumberInput.value) || nextPageNumber(item));
  let page = item.pages.find((entry) => entry.pageNumber === pageNumber);

  if (!page) {
    page = createPage(pageNumber);
    item.pages.push(page);
    item.pages.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  selectedPageId = page.id;
  item.status = summarizeDocumentStatus(item);
  item.updatedAt = new Date().toISOString();
  persist();
  renderAll();
});

document.querySelector("#save-ocr").addEventListener("click", () => {
  if (saveCurrentPage()) {
    renderAll();
  }
});

document.querySelector("#copy-ocr-to-clean").addEventListener("click", () => {
  cleanText.value = ocrRawText.value.trim();
  cleanText.focus();
});

document.querySelector("#copy-clean-to-punctuated").addEventListener("click", () => {
  punctuatedText.value = cleanText.value.trim();
  punctuatedText.focus();
});

document.querySelector("#prev-page").addEventListener("click", () => {
  saveCurrentPage();
  moveToAdjacentPage(-1);
});

document.querySelector("#next-page").addEventListener("click", () => {
  saveCurrentPage();
  moveToAdjacentPage(1);
});

document.querySelector("#save-next").addEventListener("click", () => {
  const item = getSelectedDocument();

  if (!item || !saveCurrentPage()) {
    return;
  }

  moveToAdjacentPage(1, { createIfMissing: true });
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
  if (!getSelectedDocument()) {
    return;
  }

  renderAll();
  setView("workspace");
});

pageImageInput.addEventListener("change", () => {
  const item = getSelectedDocument();
  const page = getSelectedPage();
  const file = pageImageInput.files[0];

  if (!item || !page || !file) {
    return;
  }

  readImageFile(file, (image) => {
    page.imageDataUrl = image.dataUrl;
    page.imageName = file.name;
    page.updatedAt = new Date().toISOString();
    item.updatedAt = new Date().toISOString();
    persist();
    pageImageInput.value = "";
    renderAll();
  });
});

document.querySelector("#recognize-page").addEventListener("click", recognizeCurrentPage);
document.querySelector("#generate-punctuated").addEventListener("click", generatePunctuatedText);
document.querySelector("#generate-final-text").addEventListener("click", generateFinalText);
generateDocumentTextButton?.addEventListener("click", generateDocumentFinalText);
document.querySelector("#refresh-offline").addEventListener("click", refreshOfflineTask);
document.querySelector("#smart-send").addEventListener("click", runSelectedSmartMode);
const exportPdfButton = document.querySelector("#export-pdf");
if (exportPdfButton) {
  exportPdfButton.addEventListener("click", exportPdf);
}

searchInput.addEventListener("keydown", (event) => {
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

async function runSmartChat() {
  const prompt = searchInput.value.trim();

  if (!prompt) {
    renderSmartEmpty();
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

    renderChatMessage(prompt, result.answer || "未生成回答。");
  } catch (error) {
    renderChatNotice("暂时无法调用大模型服务。");
  }
}

function runSmartSearch() {
  const prompt = searchInput.value.trim();

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

  documents.forEach((item) => {
    item.pages.forEach((page) => {
      const text = getPagePrimaryText(page);
      if (!text) {
        return;
      }

      const snippet = buildSnippet(text, prompt) || text.slice(0, 260);
      entries.push({
        documentTitle: getDocumentDisplayTitle(item),
        author: item.author || "",
        year: item.year || "",
        pageNumber: page.pageNumber,
        text: snippet,
      });
    });
  });

  return entries.slice(0, 8);
}

function renderChatMessage(prompt, answer) {
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
  await initializeServerData();
  selectedSmartMode = getSelectedConversation()?.mode || selectedSmartMode;
  renderAll();
  renderSmartModeButtons();
  resumePendingOfflineTasks();
  startPeriodicSync();
}

function resumePendingOfflineTasks() {
  documents.forEach((item) => {
    if (item.processMode !== "offline") {
      return;
    }

    if (isOfflineTaskPending(item)) {
      startOfflinePolling(item);
      return;
    }

    const task = item.offlineTask;
    if (task && ["已完成", "已回填"].includes(task.status)) {
      // OCR 已完成但大模型整理未完成时，恢复前端流水线。
      enqueueNewOfflinePages(item);
      maybeFinishOfflinePipeline(item);
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
