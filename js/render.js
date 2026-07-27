function setView(name) {
  Object.entries(views).forEach(([key, node]) => {
    if (!node) {
      return;
    }

    node.classList.toggle("active", key === name);
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === name);
  });

  const title = document.querySelector("#view-title");
  if (title && viewTitles[name]) {
    title.textContent = viewTitles[name];
  }
}

function renderAll() {
  renderConversationList();
  renderActiveConversation();
  renderDocumentList();
  renderDetail();
  renderSmartEmpty();
  if (typeof renderSmartModeButtons === "function") {
    renderSmartModeButtons();
  }
}

function renderConversationList() {
  conversationList.innerHTML = "";

  if (!conversations.length) {
    const empty = document.createElement("div");
    empty.className = "conversation-empty";
    empty.textContent = "暂无对话";
    conversationList.append(empty);
    return;
  }

  let activeDateGroup = "";
  getSortedConversations().forEach((item) => {
    const dateGroup = getConversationDateGroup(item);

    if (dateGroup !== activeDateGroup) {
      activeDateGroup = dateGroup;
      conversationList.append(createConversationDateHeading(dateGroup));
    }

    const row = document.createElement("article");
    const button = document.createElement("button");
    const deleteButton = document.createElement("button");
    const title = document.createElement("strong");
    const meta = document.createElement("span");

    row.className = "conversation-row";
    row.classList.toggle("active", item.id === selectedConversationId);
    button.className = "conversation-item";
    button.type = "button";
    title.textContent = item.title || "新对话";
    meta.className = "conversation-mode";
    meta.textContent = getConversationModeLabel(item.mode);
    button.append(title, meta);
    button.addEventListener("click", () => {
      selectedConversationId = item.id;
      selectedSmartMode = item.mode || "chat";
      renderSmartModeButtons();
      searchInput.value = item.title === "新对话" ? "" : item.title;
      chronicleTopic.value = item.mode === "chronicle" ? searchInput.value : "";
      searchResults.innerHTML = "";
      chronicleResults.innerHTML = "";
      searchResults.classList.remove("empty-result-list");
      chronicleResults.classList.remove("empty-result-list");
      renderConversationList();
      renderActiveConversation();

      if (!searchInput.value.trim()) {
        renderSmartEmpty();
        return;
      }

      if (item.mode === "chat") {
        runSmartChat();
        return;
      }

      if (item.mode === "chronicle") {
        buildChronicle();
        return;
      }

      runSearch();
    });

    deleteButton.className = "conversation-delete";
    deleteButton.type = "button";
    deleteButton.title = "删除对话";
    deleteButton.setAttribute("aria-label", `删除对话：${item.title || "新对话"}`);
    deleteButton.textContent = "×";
    deleteButton.addEventListener("click", () => {
      openDeleteConversationDialog(item);
    });

    row.append(button, deleteButton);
    conversationList.append(row);
  });
}

function getSortedConversations() {
  return conversations.slice().sort((a, b) => {
    return getConversationTime(b) - getConversationTime(a);
  });
}

function getConversationTime(item) {
  const value = item.updatedAt || item.createdAt || "";
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getConversationDateGroup(item) {
  const value = item.updatedAt || item.createdAt || "";
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "未归档";
  }

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  if (now.getTime() - date.getTime() <= 30 * dayMs) {
    return "30 天内";
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function createConversationDateHeading(label) {
  const node = document.createElement("h3");
  node.className = "conversation-date-heading";
  node.textContent = label;
  return node;
}

function renderActiveConversation() {
  const conversation = getSelectedConversation();

  chatTitle.textContent = conversation?.title || "新对话";
  chatHint.textContent = getConversationModeLabel(selectedSmartMode);
}

function getConversationModeLabel(mode) {
  if (mode === "search") {
    return "检索";
  }

  if (mode === "chronicle") {
    return "编年";
  }

  return "对话";
}

function renderDocumentList() {
  documentList.innerHTML = "";
  documentCount.textContent = `${documents.length} 项在库`;
  documentList.append(createAddBookCard());

  if (!documents.length) {
    return;
  }

  documents.forEach((item, index) => {
    const node = cardTemplate.content.cloneNode(true);
    const card = node.querySelector("article");
    const openButton = node.querySelector(".select-document");
    const cover = node.querySelector(".book-cover");
    const progress = getDocumentProgress(item);

    card.classList.toggle("selected", item.id === selectedDocumentId);
    card.classList.add(`cover-${index % 6}`);
    node.querySelector(".book-title").textContent = getDocumentDisplayTitle(item);
    node.querySelector(".book-author").textContent = item.author || "著者未录";
    node.querySelector(".book-progress span").style.width = `${progress}%`;
    node.querySelector(".book-meta strong").textContent = getDocumentDisplayTitle(item);
    node.querySelector(".book-meta small").textContent = [
      item.year || "年份未录",
      `${item.pages.length} 页`,
      item.status,
    ].join(" · ");
    cover.setAttribute("aria-hidden", "true");

    openButton.addEventListener("click", () => {
      selectedDocumentId = item.id;
      ensureSelectedPage(item);
      renderAll();
      setView("workspace");
    });

    documentList.append(node);
  });
}

function createAddBookCard() {
  const article = document.createElement("article");
  const button = document.createElement("button");
  const plus = document.createElement("span");
  const label = document.createElement("span");
  const hint = document.createElement("small");

  article.className = "book-card add-card";
  button.className = "book-open add-document";
  button.type = "button";
  plus.className = "add-plus";
  plus.textContent = "+";
  label.className = "book-meta";
  label.innerHTML = "<strong>新增文献</strong>";
  hint.textContent = "上传 PDF 或图片";

  button.append(plus, label, hint);
  button.addEventListener("click", openDocumentForm);
  article.append(button);
  return article;
}

function getDocumentProgress(item) {
  if (!item.pages.length) {
    return 0;
  }

  const finished = item.pages.filter((page) => hasPageText(page)).length;
  return Math.max(4, Math.round((finished / item.pages.length) * 100));
}

function openDocumentForm() {
  formSheet.classList.remove("hidden");
  document.querySelector("#file-input").focus();
}

function closeDocumentForm() {
  formSheet.classList.add("hidden");
}

function renderDetail() {
  const item = getSelectedDocument();
  detailNode.innerHTML = "";
  pageList.innerHTML = "";

  if (!item) {
    selectedStatus.textContent = "未选择";
    selectedPageStatus.textContent = "未选择页";
    originalPageStatus.textContent = "未选择页";
    recognizeStatus.textContent = "等待原图";
    offlineActions.classList.add("hidden");
    offlineStatus.textContent = "等待处理";
    pageCount.textContent = "0 页";
    ocrRawText.value = "";
    cleanText.value = "";
    punctuatedText.value = "";
    pageNotes.value = "";
    renderOriginalPreview(null);
    detailNode.append(emptyState("请先在文献库登记或打开一项文献"));
    pageList.append(emptyState("尚无页目"));
    return;
  }

  ensureSelectedPage(item);
  const page = getSelectedPage();

  selectedStatus.textContent = item.status;
  offlineActions.classList.toggle("hidden", item.processMode !== "offline");
  offlineStatus.textContent = getOfflineTaskLabel(item);
  selectedPageStatus.textContent = page ? `第 ${page.pageNumber} 页 · ${page.status}` : "未选择页";
  originalPageStatus.textContent = page ? `第 ${page.pageNumber} 页` : "未选择页";
  recognizeStatus.textContent = getRecognizeStatusText(page);
  pageCount.textContent = `${item.pages.length} 页`;
  pageNumberInput.value = page?.pageNumber || nextPageNumber(item);
  ocrRawText.value = page?.ocrText || "";
  cleanText.value = page?.cleanText || page?.text || "";
  punctuatedText.value = page?.punctuatedText || "";
  pageNotes.value = page?.notes || "";
  renderOriginalPreview(page);

  const rows = [
    ["文献名", item.title || "未识别"],
    ["著者", item.author || "未录"],
    ["年份", item.year || "未录"],
    ["出版社", item.publisher || "未录"],
    ["版权", item.rights || "未录"],
    ["来源", item.source || "未录"],
    ["标签", item.tags || "未录"],
    ["文件", item.fileName],
    ["文件类型", item.fileType],
    ["处理方式", item.processMode === "offline" ? "离线整本处理" : "在线逐页整理"],
    ["整本处理", getOfflineTaskLabel(item)],
    ["处理说明", getProcessModeHelp(item)],
    ["信息识别", item.metadataStatus || "待自动识别"],
    ["已建页目", `${item.pages.length} 页`],
  ];

  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const desc = document.createElement("dd");
    term.textContent = label;
    desc.textContent = value;
    row.append(term, desc);
    detailNode.append(row);
  });

  renderPageList(item);
}

function getRecognizeStatusText(page) {
  if (!page || !page.imageDataUrl) {
    return "等待原图";
  }

  if (page.ocr?.recognizedAt) {
    return "已识别";
  }

  return "可识别";
}

function renderOriginalPreview(page) {
  originalPreview.innerHTML = "";

  if (!page) {
    originalPreview.append(emptyState("请先选择页码"));
    return;
  }

  const imageSource = page.imageDataUrl || page.imageUrl;

  if (!imageSource) {
    originalPreview.append(emptyState("当前页尚未放入原始资料图片"));
    return;
  }

  const image = document.createElement("img");
  image.src = imageSource;
  image.alt = page.imageName ? `第 ${page.pageNumber} 页原始资料：${page.imageName}` : `第 ${page.pageNumber} 页原始资料`;
  originalPreview.append(image);
}

function renderPageList(item) {
  if (!item.pages.length) {
    pageList.append(emptyState("尚无页目"));
    return;
  }

  item.pages.forEach((page) => {
    const node = document.createElement("article");
    const label = document.createElement("div");
    const button = document.createElement("button");

    node.className = "page-item";
    node.classList.toggle("active", page.id === selectedPageId);
    label.innerHTML = `<strong>第 ${page.pageNumber} 页</strong><p class="meta-line">${page.status}</p>`;
    button.className = "secondary-button";
    button.type = "button";
    button.textContent = "打开";
    button.addEventListener("click", () => {
      selectedPageId = page.id;
      renderAll();
    });

    node.append(label, button);
    pageList.append(node);
  });
}

function renderSmartEmpty() {
  if (searchInput.value.trim()) {
    return;
  }

  searchResults.innerHTML = "";
  chronicleResults.innerHTML = "";
  searchResults.classList.remove("empty-result-list");
  chronicleResults.classList.remove("empty-result-list");
}

function renderSearchEmpty() {
  renderSmartEmpty();
}

function renderChronicleEmpty() {
  renderSmartEmpty();
}
