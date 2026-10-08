const DOCUMENT_DRAG_LONG_PRESS_MS = 420;
const DOCUMENT_DRAG_CANCEL_DISTANCE = 8;
let documentDragState = null;
let suppressDocumentClickUntil = 0;
let readerReturnView = "library";
let readerEditing = false;

const PAGE_ROUTES = {
  library: "index.html",
  documents: "documents.html",
  reader: "reader.html",
};

function setReaderReturnView(name) {
  readerReturnView = name === "documents" ? "documents" : "library";
}

function returnFromReader() {
  setView(readerReturnView);
}

function setView(name) {
  const route = PAGE_ROUTES[name];
  if (!route) {
    return;
  }

  const url = new URL(route, window.location.href);
  if (name === "reader" && selectedDocumentId) {
    url.searchParams.set("document", selectedDocumentId);
  }
  if (name === "reader" && selectedPageId) {
    url.searchParams.set("page", selectedPageId);
  }

  const currentFrom = new URL(window.location.href).searchParams.get("from");
  const returnView = name === "reader" ? readerReturnView : currentFrom;
  if (name === "reader" && returnView === "documents") {
    url.searchParams.set("from", "documents");
  }

  window.location.assign(url.href);
}

function applyRouteSelection() {
  const params = new URL(window.location.href).searchParams;
  const documentId = params.get("document");
  const pageId = params.get("page");

  if (documentId && documents.some((item) => item.id === documentId)) {
    selectedDocumentId = documentId;
  }

  const item = getSelectedDocument();
  if (pageId && item?.pages.some((page) => page.id === pageId)) {
    selectedPageId = pageId;
  } else if (item) {
    ensureSelectedPage(item);
  }

  setReaderReturnView(params.get("from") === "documents" ? "documents" : "library");
}

function syncSelectionToUrl() {
  const pageName = document.body.dataset.page;
  if (pageName !== "reader" || !selectedDocumentId) {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("document", selectedDocumentId);
  if (selectedPageId) {
    url.searchParams.set("page", selectedPageId);
  }
  window.history.replaceState(null, "", url.href);
}

function renderAll() {
  renderConversationList();
  renderActiveConversation();
  if (typeof renderReferenceDocuments === "function") {
    renderReferenceDocuments();
  }
  if (typeof renderConversationAttachments === "function") {
    renderConversationAttachments();
  }
  renderDocumentList();
  renderReader();
  renderReaderSidebar();
  renderSmartEmpty();
  if (typeof renderSmartModeButtons === "function") {
    renderSmartModeButtons();
  }
  syncSelectionToUrl();
}

function renderConversationList() {
  if (!conversationList) {
    return;
  }
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
    const referenceCount = getConversationReferenceDocumentIds(item).length;
    const attachmentCount = getConversationAttachments(item).length;
    meta.textContent = [
      getConversationModeLabel(item.mode),
      referenceCount ? `${referenceCount} 篇` : "",
      attachmentCount ? `${attachmentCount} 个文件` : "",
    ].filter(Boolean).join(" · ");
    button.append(title, meta);
    button.addEventListener("click", () => {
      selectedConversationId = item.id;
      selectedSmartMode = item.mode || "chat";
      renderSmartModeButtons();
      searchInput.value = item.title === "新对话" ? "" : item.title;
      chronicleTopic.value = item.mode === "chronicle" ? searchInput.value : "";
      clearSmartResults();
      renderConversationList();
      renderActiveConversation();
      renderReferenceDocuments();
      renderConversationAttachments();

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
  if (!chatTitle || !chatHint) {
    return;
  }
  const conversation = getSelectedConversation();

  chatTitle.textContent = conversation?.title || "新对话";
  chatHint.textContent = getConversationModeLabel(selectedSmartMode);
  updateConversationToolbar();
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
  renderBookShelf(documentList, documentCount);
  renderBookShelf(allDocumentList, allDocumentCount);
}

function renderBookShelf(listNode, countNode) {
  if (!listNode || !countNode) {
    return;
  }

  listNode.innerHTML = "";
  countNode.textContent = `${documents.length} 项在库`;
  listNode.append(createAddBookCard());

  if (!documents.length) {
    return;
  }

  documents.forEach((item, index) => {
    listNode.append(createBookCard(item, index));
  });
}

function createBookCard(item, index) {
  if (!cardTemplate) {
    return document.createDocumentFragment();
  }
  const node = cardTemplate.content.cloneNode(true);
  const card = node.querySelector("article");
  const openButton = node.querySelector(".select-document");
  const cover = node.querySelector(".book-cover");

  card.classList.toggle("selected", item.id === selectedDocumentId);
  card.classList.add(`cover-${normalizeCoverVariant(item.coverVariant, index)}`);
  card.dataset.documentId = item.id;
  card.dataset.documentIndex = String(index);
  card.setAttribute("aria-grabbed", "false");
  const uploadState = typeof getDocumentUploadState === "function" ? getDocumentUploadState(item.id) : null;
  const uploadText = typeof describeDocumentUploadState === "function" ? describeDocumentUploadState(item.id) : "";
  const backendStatusPending = item.processingTask?.backendManaged && (isDocumentRegistrationPending(item) || isProcessingTaskPending(item));
  const statusText = uploadText || (backendStatusPending ? item.status : "");
  card.classList.toggle("is-uploading", Boolean(uploadState && uploadState.active));
  card.classList.toggle("is-upload-failed", Boolean(uploadState && !uploadState.active && uploadState.error));
  if (!canEditDocument(item)) {
    card.classList.add("read-only");
    openButton.title = "公开文献，仅可查看";
  }
  node.querySelector(".book-title").textContent = getDocumentDisplayTitle(item);
  node.querySelector(".book-year").textContent = item.year || "年份未录";
  const pagesNode = node.querySelector(".book-pages");
  pagesNode.textContent = statusText ? shortenDocumentCardStatus(statusText) : `${item.pages.length} 页`;
  pagesNode.classList.toggle("is-status", Boolean(statusText));
  if (statusText) {
    pagesNode.title = statusText;
  } else {
    pagesNode.removeAttribute("title");
  }
  node.querySelector(".book-author").textContent = item.author || "著者未录";
  cover.setAttribute("aria-hidden", "true");
  const coverImageSource = item.coverImageUrl || item.coverImageDataUrl || "";
  if (coverImageSource) {
    cover.classList.add("image-cover");
    cover.style.setProperty("--cover-image", `url("${coverImageSource}")`);
  }

  const openDocumentFromCard = async () => {
    if (Date.now() < suppressDocumentClickUntil || documentDragState?.phase === "dragging") {
      return;
    }

    // 本地还在归档/上传时不许进入阅览器，整页跳转会中断上传。
    if (typeof isDocumentUploadActive === "function" && isDocumentUploadActive(item.id)) {
      if (typeof showUploadToast === "function") {
        showUploadToast("文献正在归档原件，上传结束后才能进入阅览器，请稍候。");
      }
      return;
    }

    const current = getLiveDocument(item.id) || item;
    if (canEditDocument(current) && isDocumentRegistrationPending(current)) {
      if (current.processingTask?.backendManaged) {
        // 原件已归档并交给后端，登记（元数据识别）在后台继续，不再阻塞阅览器。
        if (typeof startProcessingPolling === "function") startProcessingPolling(current);
      } else {
        const completed = await resumeMissingProcessingTask(current, { interactive: true });
        if (!completed) return;
      }
    }
    const ready = getLiveDocument(item.id);
    if (!ready) return;
    selectedDocumentId = ready.id;
    ensureSelectedPage(ready);
    setReaderReturnView(document.body.dataset.page === "documents" ? "documents" : "library");
    setView("reader");
  };

  openButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openDocumentFromCard();
  });
  card.addEventListener("click", () => {
    openDocumentFromCard();
  });
  card.addEventListener("pointerdown", (event) => {
    prepareDocumentDrag(event, card, item.id);
  });
  card.addEventListener("contextmenu", (event) => {
    if (documentDragState?.documentId === item.id) {
      event.preventDefault();
    }
  });

  return node;
}

function prepareDocumentDrag(event, card, documentId) {
  if (event.button !== 0 || !event.isPrimary) {
    return;
  }

  const item = documents.find((entry) => entry.id === documentId);
  if (!canEditDocument(item)) {
    return;
  }

  const listNode = card.closest(".document-list");
  if (!listNode) {
    return;
  }

  clearDocumentDragState();
  card.setPointerCapture?.(event.pointerId);
  documentDragState = {
    phase: "pending",
    documentId,
    card,
    listNode,
    originalDocuments: documents.slice(),
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    timer: window.setTimeout(startDocumentDrag, DOCUMENT_DRAG_LONG_PRESS_MS),
  };

  document.addEventListener("pointermove", handleDocumentDragMove, { passive: false });
  document.addEventListener("pointerup", finishDocumentDrag, { passive: false });
  document.addEventListener("pointercancel", finishDocumentDrag, { passive: false });
}

function startDocumentDrag() {
  if (!documentDragState || documentDragState.phase !== "pending") {
    return;
  }

  const rect = documentDragState.card.getBoundingClientRect();
  const previewNode = documentDragState.card.cloneNode(true);
  previewNode.classList.add("book-drag-preview");
  previewNode.classList.remove("selected");
  previewNode.style.width = `${rect.width}px`;
  previewNode.style.height = `${rect.height}px`;
  document.body.append(previewNode);
  documentDragState.previewNode = previewNode;
  documentDragState.offsetX = documentDragState.startX - rect.left;
  documentDragState.offsetY = documentDragState.startY - rect.top;
  documentDragState.phase = "dragging";
  documentDragState.card.classList.add("dragging");
  documentDragState.card.setAttribute("aria-grabbed", "true");
  documentDragState.listNode.classList.add("is-reordering");
  setDocumentTrashMode(documentDragState.listNode, true);
  document.body.classList.add("document-drag-active");
  updateDocumentDragPreview(documentDragState.startX, documentDragState.startY);
}

function handleDocumentDragMove(event) {
  if (!documentDragState || event.pointerId !== documentDragState.pointerId) {
    return;
  }

  const distance = Math.hypot(
    event.clientX - documentDragState.startX,
    event.clientY - documentDragState.startY,
  );

  if (documentDragState.phase === "pending") {
    if (distance > DOCUMENT_DRAG_CANCEL_DISTANCE) {
      clearDocumentDragState();
    }
    return;
  }

  event.preventDefault();
  updateDocumentDragPreview(event.clientX, event.clientY);
  updateDocumentTrashHover(event);
  const target = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest(".book-card[data-document-id]");

  if (
    !target ||
    target === documentDragState.card ||
    target.closest(".document-list") !== documentDragState.listNode
  ) {
    return;
  }

  const targetRect = target.getBoundingClientRect();
  const shouldPlaceAfter = isPointerAfterCard(event, targetRect);
  documentDragState.listNode.insertBefore(
    documentDragState.card,
    shouldPlaceAfter ? target.nextSibling : target,
  );
  syncDocumentOrderFromList(documentDragState.listNode);
}

function updateDocumentDragPreview(clientX, clientY) {
  if (!documentDragState?.previewNode) {
    return;
  }

  const x = clientX - documentDragState.offsetX;
  const y = clientY - documentDragState.offsetY;
  documentDragState.previewNode.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(-2deg)`;
}

function isPointerAfterCard(event, rect) {
  const centerY = rect.top + rect.height / 2;
  const centerX = rect.left + rect.width / 2;

  if (Math.abs(event.clientY - centerY) > rect.height / 3) {
    return event.clientY > centerY;
  }

  return event.clientX > centerX;
}

function finishDocumentDrag(event) {
  if (!documentDragState || event.pointerId !== documentDragState.pointerId) {
    return;
  }

  const wasDragging = documentDragState.phase === "dragging";

  if (wasDragging) {
    const state = documentDragState;
    const droppedOnTrash = getDocumentTrashTarget(event, state.listNode);
    const item = state.originalDocuments.find((entry) => entry.id === state.documentId);

    event.preventDefault();
    suppressDocumentClickUntil = Date.now() + 450;

    if (droppedOnTrash) {
      documents = state.originalDocuments.slice();
      clearDocumentDragState();
      renderDocumentList();

      if (item && typeof openDeleteDocumentDialog === "function") {
        openDeleteDocumentDialog(item);
      }
      return;
    }

    syncDocumentOrderFromList(state.listNode);
    persist();
  }

  clearDocumentDragState();

  if (wasDragging) {
    renderDocumentList();
  }
}

function clearDocumentDragState() {
  if (!documentDragState) {
    return;
  }

  window.clearTimeout(documentDragState.timer);
  try {
    documentDragState.card.releasePointerCapture?.(documentDragState.pointerId);
  } catch {
    // The browser may already have released capture on pointer cancellation.
  }
  documentDragState.card.classList.remove("dragging");
  documentDragState.card.setAttribute("aria-grabbed", "false");
  documentDragState.listNode.classList.remove("is-reordering");
  setDocumentTrashMode(documentDragState.listNode, false);
  documentDragState.previewNode?.remove();
  document.body.classList.remove("document-drag-active");
  document.removeEventListener("pointermove", handleDocumentDragMove);
  document.removeEventListener("pointerup", finishDocumentDrag);
  document.removeEventListener("pointercancel", finishDocumentDrag);
  documentDragState = null;
}

function syncDocumentOrderFromList(listNode) {
  const orderedIds = Array.from(listNode.querySelectorAll(".book-card[data-document-id]"))
    .map((card) => card.dataset.documentId);

  if (orderedIds.length !== documents.length) {
    return false;
  }

  const documentsById = new Map(documents.map((item) => [item.id, item]));
  const nextDocuments = orderedIds.map((id) => documentsById.get(id)).filter(Boolean);

  if (nextDocuments.length !== documents.length) {
    return false;
  }

  documents = nextDocuments;
  return true;
}

function getDocumentTrashTarget(event, listNode) {
  const target = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest(".add-card");

  if (!target || target.closest(".document-list") !== listNode) {
    return null;
  }

  return target;
}

function updateDocumentTrashHover(event) {
  if (!documentDragState) {
    return;
  }

  const trashTarget = getDocumentTrashTarget(event, documentDragState.listNode);
  const addCard = documentDragState.listNode.querySelector(".add-card");

  if (addCard) {
    addCard.classList.toggle("trash-hover", Boolean(trashTarget));
  }
}

function setDocumentTrashMode(listNode, isActive) {
  const addCard = listNode.querySelector(".add-card");

  if (!addCard) {
    return;
  }

  const addButton = addCard.querySelector(".add-document");
  const plus = addCard.querySelector(".add-plus");
  const title = addCard.querySelector(".book-meta strong");

  addCard.classList.toggle("trash-card", isActive);
  addCard.classList.remove("trash-hover");

  if (plus) {
    plus.textContent = isActive ? "×" : "+";
  }

  if (title) {
    title.textContent = isActive ? "故纸堆" : "新增文献";
  }

  if (addButton) {
    if (isActive) {
      addButton.title = "拖到此处删除文献";
      return;
    }

    addButton.removeAttribute("title");
  }
}

function createAddBookCard() {
  const article = document.createElement("article");
  const button = document.createElement("button");
  const plus = document.createElement("span");
  const label = document.createElement("span");

  article.className = "book-card add-card";
  button.className = "book-open add-document";
  button.type = "button";
  plus.className = "add-plus";
  plus.textContent = "+";
  label.className = "book-meta";
  label.innerHTML = "<strong>新增文献</strong>";

  button.append(plus, label);
  button.addEventListener("click", openDocumentForm);
  article.append(button);
  return article;
}

function openDocumentForm() {
  if (!formSheet) {
    window.location.assign(new URL("documents.html?new=1", window.location.href).href);
    return;
  }
  formSheet.classList.remove("hidden");
  document.querySelector("#file-input").focus();
}

function closeDocumentForm() {
  formSheet?.classList.add("hidden");
}

function renderReader() {
  if (!readerTitle || !readerPageStatus || !readerPageInput || !readerPageTotal || !readerOriginalPreview || !readerText) {
    return;
  }

  const item = getSelectedDocument();
  readerOriginalPreview.innerHTML = "";
  readerText.innerHTML = "";
  readerNotes.innerHTML = "";
  readerOriginalPreview.classList.remove("is-empty");
  readerText.classList.remove("is-empty");
  readerNotes.classList.add("hidden");

  if (!item) {
    setReaderEditing(false);
    readerTitle.textContent = "未选择文献";
    readerPageInput.value = "";
    readerPageInput.disabled = true;
    readerPageInput.removeAttribute("max");
    readerPageTotal.textContent = "/ 0 页";
    readerPageStatus.setAttribute("aria-label", "未选择页");
    readerPrevPageButton.disabled = true;
    readerNextPageButton.disabled = true;
    exportDocumentPdfButton.disabled = true;
    editDocumentButton.disabled = true;
    readerOriginalPreview.classList.add("is-empty");
    readerText.classList.add("is-empty");
    readerOriginalPreview.append(readerEmptyState("请先在文献库打开一项文献"));
    readerText.append(readerEmptyState("尚无整理文本"));
    if (typeof renderReaderAnnotation === "function") {
      renderReaderAnnotation(null, null);
    }
    return;
  }

  ensureSelectedPage(item);
  const page = getSelectedPage();
  const canEdit = canEditDocument(item);
  if (!canEdit) readerEditing = false;
  const sortedPages = item.pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
  const pageIndex = Math.max(0, sortedPages.findIndex((entry) => entry.id === page?.id));

  readerTitle.textContent = getDocumentDisplayTitle(item);
  readerPageInput.value = page ? String(pageIndex + 1) : "";
  readerPageInput.disabled = !page;
  readerPageInput.max = String(sortedPages.length);
  readerPageTotal.textContent = `/ ${sortedPages.length} 页`;
  readerPageStatus.setAttribute("aria-label", page ? `第 ${pageIndex + 1} 页，共 ${sortedPages.length} 页` : "未选择页");
  readerPrevPageButton.disabled = pageIndex <= 0;
  readerNextPageButton.disabled = pageIndex >= sortedPages.length - 1;
  exportDocumentPdfButton.disabled = false;
  editDocumentButton.disabled = !page || !canEdit;

  renderReaderOriginal(page);
  renderReaderText(page);
  if (typeof renderReaderAnnotation === "function") {
    renderReaderAnnotation(item, page);
  }
  applyReaderEditingState();
}

function setReaderEditing(editing) {
  const item = getSelectedDocument();
  readerEditing = Boolean(editing && item && getSelectedPage() && canEditDocument(item));
  if (readerEditing && readerText?.classList.contains("is-empty")) {
    readerText.innerHTML = "";
    readerText.classList.remove("is-empty");
  }
  applyReaderEditingState();
  if (readerEditing) {
    readerText?.focus();
  }
}

function applyReaderEditingState() {
  if (!readerText || !editDocumentButton) {
    return;
  }

  readerText.contentEditable = String(readerEditing);
  readerText.classList.toggle("is-editing", readerEditing);
  const canEdit = canEditDocument(getSelectedDocument());
  editDocumentLabel.textContent = readerEditing ? "保存" : canEdit ? "修改" : "只读";
  editDocumentButton.setAttribute("aria-label", readerEditing ? "保存整理文本" : canEdit ? "修改整理文本" : "只读文献");
}

function appendDocumentDetailRow(container, entries, className = "") {
  const row = document.createElement("div");
  if (className) {
    row.className = className;
  }
  entries.forEach(([label, value]) => {
    const term = document.createElement("dt");
    const desc = document.createElement("dd");
    term.textContent = label;
    desc.textContent = value;
    row.append(term, desc);
  });
  container.append(row);
}

// 信息栏可编辑字段（创建者、处理进度等由系统维护，不在这里）
const READER_DETAIL_FIELDS = [
  { key: "title", label: "文献名", placeholder: "未识别" },
  { key: "author", label: "作者", placeholder: "未录" },
  { key: "year", label: "出版时间", placeholder: "如 1936 ／ 1936年10月" },
  { key: "publisher", label: "出版社", placeholder: "未录" },
  { key: "tags", label: "标签", placeholder: "以逗号分隔" },
];

let readerDetailEditing = false;
let readerDetailEditingDocumentId = "";

// 编辑按钮只对文献创建者显示（canEditDocument 已按 ownerId 判定）。
function renderReaderDetailActions(item, canEdit, editing) {
  if (!readerDetailActions) {
    return;
  }

  readerDetailActions.innerHTML = "";
  if (!item || !canEdit) {
    return;
  }

  if (editing) {
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "ghost-link";
    cancelButton.id = "reader-detail-cancel";
    cancelButton.textContent = "取消";
    cancelButton.addEventListener("click", () => setReaderDetailEditing(false));

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "ghost-link icon-text-button";
    saveButton.id = "reader-detail-save";
    saveButton.title = "保存文献信息";
    saveButton.innerHTML =
      '<span>保存</span><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg>';
    saveButton.addEventListener("click", () => saveReaderDetailEdits(item.id));

    readerDetailActions.append(cancelButton, saveButton);
    return;
  }

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "ghost-link icon-text-button";
  editButton.id = "reader-detail-edit";
  editButton.title = "编辑文献信息";
  editButton.setAttribute("aria-label", "编辑文献信息");
  editButton.innerHTML =
    '<span>修改</span><svg aria-hidden="true" viewBox="0 0 24 24">' +
    '<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>';
  editButton.addEventListener("click", () => setReaderDetailEditing(true));
  readerDetailActions.append(editButton);
}

// 编辑态按与只读态完全相同的顺序与行数渲染，避免切换编辑时行位置/高度跳动。
const READER_DETAIL_EDIT_ORDER = ["title", "author", "year", "publisher", "creator", "tags"];

function appendReaderDetailEditor(item) {
  READER_DETAIL_EDIT_ORDER.forEach((key) => {
    if (key === "creator") {
      appendDocumentDetailRow(readerDetailNode, [["创建者", item.creator?.username || "创建者信息不可用"]]);
      return;
    }

    const field = READER_DETAIL_FIELDS.find((entry) => entry.key === key);
    if (!field) {
      return;
    }

    const row = document.createElement("div");
    const term = document.createElement("dt");
    const desc = document.createElement("dd");
    const input = document.createElement("input");

    term.textContent = field.label;
    input.type = "text";
    input.className = "reader-detail-input";
    input.dataset.detailField = field.key;
    input.value = item[field.key] || "";
    input.placeholder = field.placeholder;
    input.setAttribute("aria-label", field.label);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveReaderDetailEdits(item.id);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setReaderDetailEditing(false);
      }
    });

    desc.append(input);
    row.append(term, desc);
    readerDetailNode.append(row);
  });
}

function setReaderDetailEditing(editing) {
  readerDetailEditing = Boolean(editing);
  renderAll();

  if (readerDetailEditing) {
    const input = readerDetailNode?.querySelector("input[data-detail-field]");
    input?.focus();
    input?.select?.();
  }
}

function saveReaderDetailEdits(documentId) {
  const item = getLiveDocument(documentId);
  if (!item || !canEditDocument(item)) {
    setReaderDetailEditing(false);
    return;
  }

  readerDetailNode?.querySelectorAll("input[data-detail-field]").forEach((input) => {
    const key = input.dataset.detailField;
    if (key) {
      item[key] = input.value.trim();
    }
  });

  item.updatedAt = new Date().toISOString();
  persist();
  setReaderDetailEditing(false);
  if (typeof showUploadToast === "function") {
    showUploadToast("文献信息已保存");
  }
}

function renderReaderSidebar() {
  if (!readerDetailNode) {
    return;
  }

  const item = getSelectedDocument();
  readerDetailNode.innerHTML = "";

  if (!item) {
    readerDetailEditing = false;
    readerDetailEditingDocumentId = "";
    renderReaderDetailActions(null, false, false);
    readerDetailNode.append(emptyState("请先在文献库打开一本文献"));
    renderStreamProgress(null);
    return;
  }

  const canEdit = canEditDocument(item);
  // 换到别的文献时退出编辑态，避免把 A 的输入存到 B 上。
  if (readerDetailEditingDocumentId !== item.id) {
    readerDetailEditing = false;
    readerDetailEditingDocumentId = item.id;
  }
  const editing = readerDetailEditing && canEdit;
  renderReaderDetailActions(item, canEdit, editing);

  if (editing) {
    appendReaderDetailEditor(item);
  } else {
    const rows = [
      ["文献名", item.title || "未识别"],
      ["作者", item.author || "未录"],
      // 出版时间单独一行：值可以是「1936」「1936年10月」「1936年10月5日」等精度
      ["出版时间", item.year || "未录"],
      ["出版社", item.publisher || "未录"],
    ];
    rows.forEach(([label, value]) => appendDocumentDetailRow(readerDetailNode, [[label, value]]));
    [
      ["创建者", item.creator?.username || "创建者信息不可用"],
      ["标签", item.tags || "未录"],
      ["处理进度", getProcessingTaskLabel(item)],
    ]
      .filter(([, value]) => value !== getProcessingTaskLabel(item))
      .forEach(([label, value]) => appendDocumentDetailRow(readerDetailNode, [[label, value]]));
  }
  const visibilityRow = document.createElement("div");
  visibilityRow.className = "reader-visibility-row";
  const visibilityLabel = document.createElement("dt");
  visibilityLabel.textContent = "可见性";
  const visibilityOptions = document.createElement("div");
  visibilityOptions.className = "reader-visibility-options";
  visibilityOptions.setAttribute("role", "radiogroup");
  visibilityOptions.setAttribute("aria-label", "文献可见性");
  const currentVisibility = item.visibility === "public" ? "public" : "private";
  [
    ["private", "私密"],
    ["public", "公开"],
  ].forEach(([value, label]) => {
    const option = document.createElement("label");
    option.className = "reader-visibility-option";
    option.classList.toggle("is-disabled", !canEdit);
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `reader-visibility-${item.id}`;
    radio.value = value;
    radio.checked = currentVisibility === value;
    radio.disabled = !canEdit;
    const optionLabel = document.createElement("span");
    optionLabel.textContent = label;
    if (canEdit) {
      radio.onchange = () => {
        item.visibility = value;
        item.updatedAt = new Date().toISOString();
        persist();
      };
    }
    option.append(radio, optionLabel);
    visibilityOptions.append(option);
  });
  const visibilityDesc = document.createElement("dd");
  visibilityDesc.append(visibilityOptions);
  visibilityRow.append(visibilityLabel, visibilityDesc);
  readerDetailNode.append(visibilityRow);
  renderStreamProgress(item);
}

function getReaderTextLayer(page) {
  return page?.punctuatedText || page?.cleanText || page?.ocrText || "";
}

function renderReaderOriginal(page) {
  const imageSource = getPageImageSource(page);

  if (!imageSource) {
    readerOriginalPreview.classList.add("is-empty");
    readerOriginalPreview.append(readerEmptyState("本页尚未放入原始资料图片"));
    return;
  }

  const image = document.createElement("img");
  image.src = imageSource;
  image.alt = page.imageName ? `第 ${page.pageNumber} 页原始资料：${page.imageName}` : `第 ${page.pageNumber} 页原始资料`;
  readerOriginalPreview.append(image);
}

function renderReaderText(page) {
  const text = getReaderTextLayer(page);

  if (!text) {
    readerText.classList.add("is-empty");
    readerText.append(readerEmptyState("本页尚无整理文本"));
    return;
  }

  readerText.textContent = text;

  if (page?.notes) {
    readerNotes.textContent = page.notes;
    readerNotes.classList.remove("hidden");
  }
}

function readerEmptyState(message) {
  const node = emptyState(message);
  node.classList.add("reader-empty-state");
  return node;
}

function renderSmartEmpty() {
  if (!searchInput || !searchResults || !chronicleResults) {
    return;
  }
  if (searchInput.value.trim()) {
    return;
  }

  clearSmartResults();
}

function clearSmartResults() {
  if (!searchResults || !chronicleResults) {
    return;
  }
  searchResults.innerHTML = "";
  chronicleResults.innerHTML = "";
  searchResults.classList.remove("empty-result-list");
  chronicleResults.classList.remove("empty-result-list");
}
