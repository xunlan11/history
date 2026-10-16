const DOCUMENT_DRAG_LONG_PRESS_MS = 420;
const DOCUMENT_DRAG_CANCEL_DISTANCE = 8;
let documentDragState = null;
let suppressDocumentClickUntil = 0;
let readerReturnView = "library";
let readerEditing = false;
let chatTitleEditingId = "";

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
    const shareButton = document.createElement("button");
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
      if (typeof conversationShareEditingId !== "undefined" && conversationShareEditingId) {
        conversationShareEditingId = "";
        conversationShareSelectionIds = new Set();
      }
      selectedConversationId = item.id;
      selectedSmartMode = item.mode || "chat";
      renderSmartModeButtons();
      searchInput.value = "";
      chronicleTopic.value = "";
      renderConversationList();
      renderActiveConversation();
      renderReferenceDocuments();
      renderConversationAttachments();
      messageFeed.scrollTop = messageFeed.scrollHeight;
    });

    shareButton.className = "conversation-share";
    shareButton.classList.toggle("active", Boolean(item.share?.active && item.share?.token));
    shareButton.type = "button";
    shareButton.title = item.share?.active ? "编辑分享内容" : "分享对话";
    shareButton.setAttribute("aria-label", item.share?.active ? `编辑分享：${item.title || "新对话"}` : `分享对话：${item.title || "新对话"}`);
    shareButton.textContent = item.share?.active ? "↗" : "分享";
    shareButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openConversationShareEditor(item);
    });

    deleteButton.className = "conversation-delete";
    deleteButton.type = "button";
    deleteButton.title = "删除对话";
    deleteButton.setAttribute("aria-label", `删除对话：${item.title || "新对话"}`);
    deleteButton.textContent = "×";
    deleteButton.addEventListener("click", () => {
      openDeleteConversationDialog(item);
    });

    row.append(button, shareButton, deleteButton);
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

  // 切换对话时退出标题编辑态，避免把输入框留在别的对话上。
  if (chatTitleEditingId && chatTitleEditingId !== conversation?.id) {
    setChatTitleEditMode("");
  }

  if (!chatTitleEditingId) {
    chatTitle.textContent = conversation?.title || "新对话";
  }

  if (editChatTitleButton) {
    editChatTitleButton.classList.toggle("hidden", !conversation);
  }

  chatHint.textContent = getConversationModeLabel(selectedSmartMode);
  if (typeof renderConversationTurns === "function") renderConversationTurns();
  if (typeof renderConversationShareEditor === "function") renderConversationShareEditor();
}

function setChatTitleEditMode(conversationId) {
  chatTitleEditingId = conversationId || "";
  const active = Boolean(chatTitleEditingId);

  if (!chatTitle || !chatTitleInput || !editChatTitleButton) {
    return;
  }

  chatTitle.classList.toggle("hidden", active);
  chatTitleInput.classList.toggle("hidden", !active);
  editChatTitleButton.classList.toggle("editing", active);
  editChatTitleButton.title = active ? "保存标题" : "修改标题";
  editChatTitleButton.setAttribute("aria-label", active ? "保存对话标题" : "修改对话标题");
}

function startChatTitleEdit() {
  const conversation = getSelectedConversation();
  if (!conversation || !chatTitleInput) {
    return;
  }

  chatTitleInput.value = conversation.title || "";
  setChatTitleEditMode(conversation.id);
  chatTitleInput.focus();
  chatTitleInput.select();
}

function finishChatTitleEdit(commit) {
  const conversation = getSelectedConversation();
  const editingId = chatTitleEditingId;
  setChatTitleEditMode("");

  if (commit && conversation && conversation.id === editingId && chatTitleInput) {
    const resolvedTitle = chatTitleInput.value.trim() || "新对话";
    if (resolvedTitle !== (conversation.title || "")) {
      conversation.title = resolvedTitle;
      conversation.updatedAt = new Date().toISOString();
      persistConversations();
    }
  }

  renderActiveConversation();
  renderConversationList();
}

function toggleChatTitleEdit() {
  if (chatTitleEditingId) {
    finishChatTitleEdit(true);
  } else {
    startChatTitleEdit();
  }
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
  // Background registration/sync updates must not detach a card during dragging.
  if (documentDragState?.phase === "dragging") return;
  renderBookShelf(documentList, documentCount);
  renderBookShelf(allDocumentList, allDocumentCount);
}

function renderBookShelf(listNode, countNode) {
  if (!listNode || !countNode) return;
  const state = getShelfState();
  const folder = state.folders.find((entry) => entry.id === listNode.dataset.folderId);
  listNode.dataset.folderId = folder?.id || "";
  listNode.innerHTML = "";
  countNode.textContent = `${documents.length} 项在库`;
  renderShelfToolbar(listNode, folder, state);
  // 卡片顺序固定：新增文献/故纸堆 → 新建文件夹 → （文件夹内才有）返回上一级。
  listNode.append(createShelfAddCard());
  listNode.append(createShelfCreateCard(folder?.id || ""));
  if (folder) listNode.append(createShelfParentCard(listNode, folder, state));
  const documentsById = new Map(documents.map((item, index) => [item.id, { item, index }]));
  const foldersById = new Map(state.folders.map((entry) => [entry.id, entry]));
  const keys = folder ? folder.order : state.order;
  for (const key of keys) {
    if (key.startsWith("folder:")) {
      const entry = foldersById.get(key.slice(7));
      if (entry) listNode.append(createShelfFolderCard(entry, state));
    } else {
      const entry = documentsById.get(key.slice(9));
      if (entry) listNode.append(createBookCard(entry.item, entry.index));
    }
  }
  if (folder && !folder.order.length) {
    const empty = document.createElement("p");
    empty.className = "shelf-empty";
    empty.textContent = "文件夹还是空的。可在这里新建子文件夹，或返回上层拖入书籍和文件夹。";
    listNode.append(empty);
  }
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
  card.dataset.shelfKey = `document:${item.id}`;
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
        // 原件归档后，登记（元数据识别）在后台继续，阅览器可以直接打开。
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

function prepareDocumentDrag(event, card, itemId, kind = "document") {
  if (event.button !== 0 || !event.isPrimary) return;
  const listNode = card.closest(".document-list");
  if (!listNode) return;
  clearDocumentDragState();
  documentDragState = {
    phase: "pending", kind,
    documentId: kind === "document" ? itemId : null,
    folderId: kind === "folder" ? itemId : null,
    card, listNode,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    clientX: event.clientX,
    clientY: event.clientY,
    timer: window.setTimeout(startDocumentDrag, DOCUMENT_DRAG_LONG_PRESS_MS),
  };
  document.addEventListener("pointermove", handleDocumentDragMove, { passive: false });
  document.addEventListener("pointerup", finishDocumentDrag, { passive: false });
  document.addEventListener("pointercancel", finishDocumentDrag, { passive: false });
  document.addEventListener("keydown", handleDocumentDragKeydown);
}

function startDocumentDrag() {
  if (!documentDragState || documentDragState.phase !== "pending") return;
  const state = documentDragState;
  state.card.setPointerCapture?.(state.pointerId);
  const rect = state.card.getBoundingClientRect();
  const previewNode = state.card.cloneNode(true);
  previewNode.classList.add("book-drag-preview");
  previewNode.classList.remove("selected");
  previewNode.setAttribute("aria-hidden", "true");
  previewNode.style.width = `${rect.width}px`;
  previewNode.style.height = `${rect.height}px`;
  document.body.append(previewNode);
  state.previewNode = previewNode;
  state.offsetX = state.startX - rect.left;
  state.offsetY = state.startY - rect.top;
  state.phase = "dragging";
  state.card.classList.add("dragging");
  state.card.setAttribute("aria-grabbed", "true");
  state.listNode.classList.add("is-reordering");
  if (state.kind === "folder" || canEditDocument(documents.find((item) => item.id === state.documentId))) {
    setDocumentTrashMode(state.listNode, true);
  }
  document.body.classList.add("document-drag-active");
  updateDocumentDragPreview(state.startX, state.startY);
  state.scrollFrame = window.requestAnimationFrame(scrollDocumentDrag);
}

function handleDocumentDragMove(event) {
  const state = documentDragState;
  if (!state || event.pointerId !== state.pointerId) return;
  const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
  if (state.phase === "pending") {
    if (distance <= DOCUMENT_DRAG_CANCEL_DISTANCE) return;
    if (event.pointerType === "mouse") startDocumentDrag();
    else { clearDocumentDragState(); return; }
  }
  event.preventDefault();
  window.clearTimeout(state.reorderTimer);
  state.clientX = event.clientX;
  state.clientY = event.clientY;
  updateDocumentDragPreview(event.clientX, event.clientY);
  updateDocumentTrashHover(event);
  if (updateShelfDropHover(event)) return;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".book-card[data-shelf-key]");
  if (!target || target === state.card || target.closest(".document-list") !== state.listNode) return;
  const shouldPlaceAfter = isPointerAfterCard(event, target.getBoundingClientRect());
  const reorder = () => {
    if (documentDragState === state && target.parentNode === state.listNode) {
      state.listNode.insertBefore(state.card, shouldPlaceAfter ? target.nextSibling : target);
    }
  };
  if (target.classList.contains("folder-card")) {
    // Passing through a folder edge should still reach its drop zone.
    state.reorderTimer = window.setTimeout(reorder, 240);
  } else {
    reorder();
  }
}

function scrollDocumentDrag() {
  const state = documentDragState;
  if (!state || state.phase !== "dragging") return;
  const stage = state.listNode.closest("[data-shelf-stage]");
  const rect = stage.getBoundingClientRect();
  const previousScroll = stage.scrollTop;
  if (state.clientX >= rect.left && state.clientX <= rect.right &&
      state.clientY >= rect.top && state.clientY <= rect.bottom) {
    if (state.clientY < rect.top + 40) stage.scrollTop -= 10;
    else if (state.clientY > rect.bottom - 40) stage.scrollTop += 10;
  }
  if (stage.scrollTop !== previousScroll) {
    window.clearTimeout(state.reorderTimer);
    const position = { clientX: state.clientX, clientY: state.clientY };
    updateShelfDropHover(position);
    updateDocumentTrashHover(position);
  }
  state.scrollFrame = window.requestAnimationFrame(scrollDocumentDrag);
}

function updateDocumentDragPreview(clientX, clientY) {
  if (!documentDragState?.previewNode) return;
  const x = clientX - documentDragState.offsetX;
  const y = clientY - documentDragState.offsetY;
  documentDragState.previewNode.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(-2deg)`;
}

function isPointerAfterCard(event, rect) {
  const centerY = rect.top + rect.height / 2;
  const centerX = rect.left + rect.width / 2;
  if (Math.abs(event.clientY - centerY) > rect.height / 3) return event.clientY > centerY;
  return event.clientX > centerX;
}

function finishDocumentDrag(event) {
  const state = documentDragState;
  if (!state || event.pointerId !== state.pointerId) return;
  const wasDragging = state.phase === "dragging";
  let deletedItem = null;
  let dissolvedFolderId = null;
  if (wasDragging) {
    event.preventDefault();
    suppressDocumentClickUntil = Date.now() + 450;
    if (event.type !== "pointercancel") {
      const dropTarget = getShelfDropTarget(event, state);
      const trash = getDocumentTrashTarget(event, state.listNode);
      if (trash) {
        if (state.kind === "folder") dissolvedFolderId = state.folderId;
        else {
          const item = documents.find((entry) => entry.id === state.documentId);
          if (canEditDocument(item)) deletedItem = item;
        }
      } else if (dropTarget) {
        moveShelfEntry(state.kind, state.kind === "folder" ? state.folderId : state.documentId, dropTarget.dataset.folderId || "");
      } else {
        syncShelfOrderFromList(state.listNode);
        saveShelfState();
      }
    }
  }
  clearDocumentDragState();
  if (wasDragging) renderDocumentList();
  if (deletedItem && typeof openDeleteDocumentDialog === "function") openDeleteDocumentDialog(deletedItem);
  if (dissolvedFolderId && requestDissolveShelfFolder(dissolvedFolderId)) renderDocumentList();
}

function handleDocumentDragKeydown(event) {
  if (event.key !== "Escape" || !documentDragState) return;
  event.preventDefault();
  finishDocumentDrag({ type: "pointercancel", pointerId: documentDragState.pointerId, preventDefault() {} });
}

function clearDocumentDragState() {
  if (!documentDragState) return;
  window.clearTimeout(documentDragState.timer);
  window.clearTimeout(documentDragState.reorderTimer);
  window.cancelAnimationFrame?.(documentDragState.scrollFrame);
  try {
    documentDragState.card.releasePointerCapture?.(documentDragState.pointerId);
  } catch {
    // The browser may have released capture when the pointer was cancelled.
  }
  documentDragState.card.classList.remove("dragging");
  documentDragState.card.setAttribute("aria-grabbed", "false");
  documentDragState.listNode.classList.remove("is-reordering");
  documentDragState.dropTarget?.classList.remove("shelf-drop-hover");
  setDocumentTrashMode(documentDragState.listNode, false);
  documentDragState.previewNode?.remove();
  document.body.classList.remove("document-drag-active");
  document.removeEventListener("pointermove", handleDocumentDragMove);
  document.removeEventListener("pointerup", finishDocumentDrag);
  document.removeEventListener("pointercancel", finishDocumentDrag);
  document.removeEventListener("keydown", handleDocumentDragKeydown);
  documentDragState = null;
}

function getDocumentTrashTarget(event, listNode) {
  const target = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest(".shelf-add-card");

  if (!target || target.closest(".document-list") !== listNode) {
    return null;
  }

  return target;
}

function updateDocumentTrashHover(event) {
  if (!documentDragState) return;
  const state = documentDragState;
  const canDelete = state.kind === "folder" || canEditDocument(documents.find((item) => item.id === state.documentId));
  const card = state.listNode.querySelector(".shelf-add-card");
  card?.classList.toggle("trash-hover", canDelete && Boolean(getDocumentTrashTarget(event, state.listNode)));
}

// 拖拽期间把「新增文献」卡片切换成「故纸堆」删除区，拖拽结束后再切回。
function setDocumentTrashMode(listNode, isActive) {
  const card = listNode.querySelector(".shelf-add-card");
  if (!card) return;
  card.classList.toggle("trash-active", isActive);
  card.classList.remove("trash-hover");
  const icon = card.querySelector(".shelf-utility-icon");
  if (icon) icon.textContent = isActive ? "×" : "＋";
  const name = card.querySelector(".folder-name");
  if (name) name.textContent = isActive ? "故纸堆" : "新增文献";
  const hint = card.querySelector("small");
  if (hint) hint.textContent = isActive ? "拖到此处删除" : "点击登记新文献";
  const button = card.querySelector("button");
  if (button) button.title = isActive ? "拖到此处删除文献；拖入文件夹可解散并将内容移到上层" : "点击登记新文献";
}

function openDocumentForm() {
  if (!formSheet) {
    window.location.assign(new URL("documents.html?new=1", window.location.href).href);
    return;
  }
  formSheet.dataset.shelfFolderId = (documentList || allDocumentList)?.dataset.folderId || "";
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

  const linkRevision = resetReaderLink();
  const item = getSelectedDocument();
  readerOriginalPreview.innerHTML = "";
  readerText.innerHTML = "";
  readerNotes.innerHTML = "";
  readerOriginalPreview.classList.remove("is-empty");
  readerText.classList.remove("is-empty");
  readerNotes.classList.add("hidden");

  if (!item) {
    if (typeof syncReaderSearch === "function") syncReaderSearch(null);
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
  const editingPageKey = JSON.stringify([currentUser?.id, item.id, page?.id]);
  if (!canEdit || readerEditingPageKey !== editingPageKey) readerEditing = false;
  readerEditingPageKey = editingPageKey;
  if (typeof syncReaderSearch === "function") syncReaderSearch(item);
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

  if (typeof recordReaderProgress === "function") {
    recordReaderProgress(item, page);
  }
  const index = readerEditing ? null : getCachedReaderIndex(item, page);
  renderReaderOriginal(page, index);
  renderReaderText(page, index);
  if (!readerEditing && !index && page) {
    const requestKey = getReaderIndexKey(item, page);
    loadReaderIndex(item.id, page.id).then((loaded) => {
      const selected = getSelectedDocument();
      const selectedPage = getSelectedPage();
      if (!loaded || linkRevision !== readerLinkRenderRevision || readerEditing ||
          selected?.id !== item.id || selectedPage?.id !== page.id ||
          getReaderIndexKey(selected, selectedPage) !== requestKey) return;
      readerOriginalPreview.replaceChildren();
      readerText.replaceChildren();
      renderReaderOriginal(selectedPage, loaded);
      renderReaderText(selectedPage, loaded);
    });
  }
  if (typeof renderReaderAnnotation === "function") {
    renderReaderAnnotation(item, page);
  }
  applyReaderEditingState();
}

function setReaderEditing(editing) {
  const item = getSelectedDocument();
  readerEditing = Boolean(editing && item && getSelectedPage() && canEditDocument(item));
  if (readerEditing) {
    resetReaderLink();
    // 清除句子节点再编辑，保存时始终读取普通正文。
    readerText.textContent = readerText.classList.contains("is-empty") ? "" : readerText.textContent;
    readerOriginalPreview?.querySelector(".reader-image-overlay")?.remove();
  }
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
  if (typeof renderReaderSearchPanel === "function") renderReaderSearchPanel();
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

  if (isDocumentRegistrationPending(item)) {
    const text = describeDocumentUploadState(item.id) || item.status || "登记中";
    const status = document.createElement("span");
    status.className = "reader-detail-registration-status";
    status.setAttribute("role", "status");
    status.textContent = shortenDocumentCardStatus(text);
    status.title = text;
    readerDetailActions.append(status);
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
  if (readerDetailEditingDocumentId !== item.id || isDocumentRegistrationPending(item)) {
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

function renderReaderOriginal(page, readerIndex = null) {
  const imageSource = getPageImageSource(page);

  if (!imageSource) {
    readerOriginalPreview.classList.add("is-empty");
    readerOriginalPreview.append(readerEmptyState("本页尚未放入原始资料图片"));
    return;
  }

  const image = document.createElement("img");
  image.src = imageSource;
  image.alt = page.imageName ? `第 ${page.pageNumber} 页原始资料：${page.imageName}` : `第 ${page.pageNumber} 页原始资料`;
  const frame = document.createElement("div");
  frame.className = "reader-image-frame";
  frame.append(image);
  if (readerIndex && !readerEditing) frame.append(createReaderImageOverlay(readerIndex, image));
  readerOriginalPreview.append(frame);
}

function renderReaderText(page, readerIndex = null, options = {}) {
  const text = getPagePrimaryText(page);
  if (options.evidence !== false && typeof showReaderEvidence === "function") showReaderEvidence(page, readerIndex);

  if (!text) {
    readerText.classList.add("is-empty");
    readerText.append(readerEmptyState("本页尚无整理文本"));
    return;
  }

  if (readerIndex && !readerEditing && isReaderIndexValid(readerIndex, page)) {
    for (const sentence of readerIndex.sentences) {
      const node = document.createElement("span");
      node.className = "reader-sentence";
      node.dataset.sentenceId = sentence.id;
      node.tabIndex = 0;
      node.textContent = sentence.text;
      readerText.append(node);
    }
  } else {
    readerText.textContent = text;
  }

  if (typeof applyReaderSearchHighlights === "function") applyReaderSearchHighlights(page);

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
  if (typeof renderConversationTurns === "function") {
    renderConversationTurns();
    return;
  }
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
