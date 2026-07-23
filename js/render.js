function setView(name) {
  Object.entries(views).forEach(([key, node]) => {
    node.classList.toggle("active", key === name);
  });

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === name);
  });

  document.querySelector("#view-title").textContent = viewTitles[name];
}

function renderAll() {
  renderDocumentList();
  renderDetail();
  renderSearchEmpty();
  renderChronicleEmpty();
}

function renderDocumentList() {
  documentList.innerHTML = "";
  documentCount.textContent = `${documents.length} 项`;

  if (!documents.length) {
    documentList.append(emptyState("尚未登记文献"));
    return;
  }

  documents.forEach((item) => {
    const node = cardTemplate.content.cloneNode(true);
    const card = node.querySelector("article");
    card.classList.toggle("selected", item.id === selectedDocumentId);
    node.querySelector("h4").textContent = item.title;
    node.querySelector(".meta-line").textContent = [
      item.author || "著者未录",
      item.year || "年份未录",
      item.processMode === "offline" ? "离线整本处理" : "在线逐页整理",
      `${item.pages.length} 页`,
      item.status,
    ].join(" · ");

    node.querySelector(".select-document").addEventListener("click", () => {
      selectedDocumentId = item.id;
      ensureSelectedPage(item);
      renderAll();
      setView("workspace");
    });

    documentList.append(node);
  });
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
    ocrText.value = "";
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
  ocrText.value = page?.text || "";
  pageNotes.value = page?.notes || "";
  renderOriginalPreview(page);

  const rows = [
    ["文献名", item.title],
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

function renderSearchEmpty() {
  if (!searchInput.value.trim()) {
    searchResults.innerHTML = "";
    searchResults.append(emptyState("输入检索词后，将在文献信息和各页文字中查找"));
  }
}

function renderChronicleEmpty() {
  if (!chronicleTopic.value.trim()) {
    chronicleResults.innerHTML = "";
    chronicleResults.append(emptyState("输入主题后，将从已整理文字中提取带日期的史事条目"));
  }
}
