// Personal shelf layout is independent of document metadata and permissions.
let shelfState = { folders: [], order: [] };
let shelfStorageKey = null;

function normalizeShelfState(value, items = documents) {
  const documentIds = new Set(items.map((item) => item.id));
  const assigned = new Set();
  const byId = new Map();
  for (const source of Array.isArray(value?.folders) ? value.folders : []) {
    if (typeof source?.id !== "string" || !source.id || byId.has(source.id)) continue;
    const members = [];
    for (const id of Array.isArray(source.documentIds) ? source.documentIds : []) {
      if (!documentIds.has(id) || assigned.has(id)) continue;
      assigned.add(id);
      members.push(id);
    }
    byId.set(source.id, {
      id: source.id,
      name: typeof source.name === "string" && source.name.trim() ? source.name.trim().slice(0, 80) : "未命名文件夹",
      parentId: typeof source.parentId === "string" ? source.parentId : "",
      documentIds: members,
      order: Array.isArray(source.order) ? source.order : members.map((id) => `document:${id}`),
    });
  }
  const folders = [...byId.values()];
  for (const folder of folders) {
    if (folder.parentId === folder.id || !byId.has(folder.parentId)) folder.parentId = "";
  }
  const checked = new Set();
  for (const folder of folders) {
    const path = new Set();
    let current = folder;
    while (current && !checked.has(current.id)) {
      if (path.has(current.id)) { current.parentId = ""; break; }
      path.add(current.id);
      current = byId.get(current.parentId);
    }
    for (const id of path) checked.add(id);
  }
  const validByParent = new Map([["", new Set()]]);
  for (const folder of folders) {
    validByParent.set(folder.id, new Set(folder.documentIds.map((id) => `document:${id}`)));
  }
  for (const folder of folders) validByParent.get(folder.parentId).add(`folder:${folder.id}`);
  for (const item of items) {
    if (!assigned.has(item.id)) validByParent.get("").add(`document:${item.id}`);
  }
  const normalizeOrder = (source, valid) => {
    const order = [];
    for (const key of Array.isArray(source) ? source : []) {
      if (valid.delete(key)) order.push(key);
    }
    order.push(...valid);
    return order;
  };
  const order = normalizeOrder(value?.order, validByParent.get(""));
  for (const folder of folders) {
    folder.order = normalizeOrder(folder.order, validByParent.get(folder.id));
    folder.documentIds = folder.order.filter((key) => key.startsWith("document:")).map((key) => key.slice(9));
  }
  return { folders, order };
}

function getShelfStorageKey() {
  return currentUser?.id ? `${SITE_STORAGE_PREFIX}.shelf.schema1.user-${currentUser.id}` : "";
}

function getShelfState() {
  const key = getShelfStorageKey();
  if (key !== shelfStorageKey) {
    shelfStorageKey = key;
    try {
      shelfState = JSON.parse(key ? localStorage.getItem(key) : "null");
    } catch {
      shelfState = null;
    }
  }
  shelfState = normalizeShelfState(shelfState);
  return shelfState;
}

function cacheShelfState() {
  const state = getShelfState();
  if (shelfStorageKey) localStorage.setItem(shelfStorageKey, JSON.stringify(state));
}

function applyShelfState(value) {
  getShelfState();
  shelfState = normalizeShelfState(value);
  cacheShelfState();
}

function saveShelfState() {
  cacheShelfState();
  scheduleServerPush();
}

function getShelfContainerOrder(state, folderId = "") {
  return folderId ? state.folders.find((folder) => folder.id === folderId)?.order : state.order;
}

function canMoveShelfFolder(folderId, parentId, state = getShelfState()) {
  const byId = new Map(state.folders.map((folder) => [folder.id, folder]));
  if (!byId.has(folderId) || (parentId && !byId.has(parentId))) return false;
  const visited = new Set();
  for (let current = parentId; current; current = byId.get(current)?.parentId || "") {
    if (current === folderId || visited.has(current)) return false;
    visited.add(current);
  }
  return true;
}

function moveShelfEntry(kind, itemId, folderId = "") {
  const state = getShelfState();
  const target = folderId ? state.folders.find((folder) => folder.id === folderId) : null;
  if (folderId && !target) return false;
  if (kind === "folder") {
    if (!canMoveShelfFolder(itemId, folderId, state)) return false;
  } else if (kind !== "document" || !documents.some((item) => item.id === itemId)) return false;
  const key = `${kind}:${itemId}`;
  state.order = state.order.filter((entry) => entry !== key);
  for (const folder of state.folders) {
    folder.order = folder.order.filter((entry) => entry !== key);
    if (kind === "document") folder.documentIds = folder.documentIds.filter((id) => id !== itemId);
  }
  if (kind === "folder") state.folders.find((folder) => folder.id === itemId).parentId = folderId;
  else if (target) target.documentIds.push(itemId);
  getShelfContainerOrder(state, folderId).push(key);
  saveShelfState();
  return true;
}

function moveShelfDocument(documentId, folderId = "") {
  return moveShelfEntry("document", documentId, folderId);
}

function dissolveShelfFolder(folderId) {
  const state = getShelfState();
  const folder = state.folders.find((entry) => entry.id === folderId);
  if (!folder) return;
  const parent = state.folders.find((entry) => entry.id === folder.parentId);
  const promoted = getShelfContainerOrder(state, folder.parentId).flatMap((key) =>
    key === `folder:${folderId}` ? folder.order : [key]);
  if (parent) {
    parent.order = promoted;
    parent.documentIds.push(...folder.documentIds);
  } else state.order = promoted;
  for (const child of state.folders) {
    if (child.parentId === folderId) child.parentId = folder.parentId;
  }
  state.folders = state.folders.filter((entry) => entry.id !== folderId);
  saveShelfState();
}

function requestDissolveShelfFolder(folderId) {
  const folder = getShelfState().folders.find((entry) => entry.id === folderId);
  if (!folder || !window.confirm(`解散“${folder.name}”？其中的文献和子文件夹会移到上层文件夹。`)) return false;
  dissolveShelfFolder(folderId);
  return true;
}

function syncShelfOrderFromList(listNode) {
  const state = getShelfState();
  const keys = Array.from(listNode.querySelectorAll("[data-shelf-key]"), (card) => card.dataset.shelfKey);
  const folder = state.folders.find((entry) => entry.id === listNode.dataset.folderId);
  if (folder) {
    folder.order = [...new Set([...keys, ...folder.order])];
    folder.documentIds = folder.order.filter((key) => key.startsWith("document:")).map((key) => key.slice(9));
  } else state.order = [...new Set([...keys, ...state.order])];
}

function setShelfFolder(listNode, folderId = "") {
  listNode.dataset.folderId = folderId;
  renderDocumentList();
  listNode.closest("[data-shelf-stage]").scrollTop = 0;
}

function getShelfPathParts(folder, state = getShelfState()) {
  const byId = new Map(state.folders.map((entry) => [entry.id, entry]));
  const ancestors = [];
  for (let current = folder; current; current = byId.get(current.parentId)) ancestors.unshift(current);
  return ["文献库", ...ancestors.map((entry) => entry.name)];
}

function renderShelfToolbar(listNode, folder, state = getShelfState()) {
  const stage = listNode.closest("[data-shelf-stage]");
  // 左侧只做定位提示（文献库 › 一级 › 二级），返回上一层由书架里的「上层文件夹」卡片负责。
  const path = stage.querySelector("[data-shelf-path]");
  const pathText = getShelfPathParts(folder, state).join(" › ");
  path.textContent = pathText;
  path.title = pathText;
  const rename = stage.querySelector("[data-shelf-rename]");
  const dissolve = stage.querySelector("[data-shelf-dissolve]");
  rename.hidden = !folder;
  rename.onclick = () => openShelfNameDialog(folder.id);
  dissolve.hidden = !folder;
  dissolve.onclick = () => {
    if (requestDissolveShelfFolder(folder.id)) setShelfFolder(listNode, folder.parentId);
  };
}

function createShelfUtilityCard(className, symbol, name, description) {
  const card = document.createElement("article");
  card.className = `book-card shelf-utility-card ${className}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "book-open shelf-utility-cover";
  const icon = document.createElement("span");
  icon.className = "shelf-utility-icon";
  icon.textContent = symbol;
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("strong");
  label.className = "folder-name";
  label.textContent = name;
  label.title = name;
  const hint = document.createElement("small");
  hint.textContent = description;
  button.append(icon, label, hint);
  card.append(button);
  return card;
}

// 同一个入口两种状态：平时是「新增文献」，开始拖拽后由 setDocumentTrashMode 变成「故纸堆」删除区。
// 每一层文件夹（含根目录）都渲染同一张卡片，行为完全一致。
function createShelfAddCard() {
  const card = createShelfUtilityCard("shelf-add-card", "＋", "新增文献", "点击登记新文献");
  const button = card.querySelector("button");
  button.title = "点击登记新文献";
  button.onclick = () => {
    if (Date.now() < suppressDocumentClickUntil) return;
    openDocumentForm();
  };
  return card;
}

// 「新建子文件夹」同样做成书架卡片，排在「新增文献 / 故纸堆」的下一个。
function createShelfCreateCard(folderId = "") {
  const card = createShelfUtilityCard("shelf-create-card", "", "新建文件夹", "点击新建子文件夹");
  card.querySelector(".shelf-utility-icon").innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v4M10 13h4"/></svg>';
  const button = card.querySelector("button");
  button.title = "点击新建子文件夹";
  button.onclick = () => {
    if (Date.now() < suppressDocumentClickUntil) return;
    openShelfNameDialog("", folderId);
  };
  return card;
}

// 只在文件夹内渲染：一级文件夹显示「文献库」，更深层显示上一级文件夹名；根目录没有上级，不渲染本卡片。
function createShelfParentCard(listNode, folder, state) {
  const parent = state.folders.find((entry) => entry.id === folder.parentId);
  const parentName = parent?.name || "文献库";
  const card = createShelfUtilityCard("shelf-parent-card", "↰", parentName, "返回上一级");
  card.dataset.shelfParent = "";
  card.dataset.folderId = parent?.id || "";
  const button = card.querySelector("button");
  button.title = `返回上一级文件夹：${parentName}`;
  button.setAttribute("aria-label", `返回上一级文件夹：${parentName}`);
  button.onclick = () => {
    if (Date.now() >= suppressDocumentClickUntil) setShelfFolder(listNode, parent?.id || "");
  };
  return card;
}

function createShelfFolderCard(folder, state = getShelfState()) {
  const card = document.createElement("article");
  card.className = "book-card folder-card";
  card.dataset.folderId = folder.id;
  card.dataset.shelfKey = `folder:${folder.id}`;
  card.setAttribute("aria-grabbed", "false");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "book-open folder-open";
  const children = state.folders.filter((entry) => entry.parentId === folder.id);
  const countText = children.length ? `${folder.documentIds.length} 文献 · ${children.length} 文件夹` : `${folder.documentIds.length} 项文献`;
  button.setAttribute("aria-label", `打开文件夹：${folder.name}，${countText}`);
  const cover = document.createElement("span");
  cover.className = "folder-cover";
  const icon = document.createElement("span");
  icon.className = "folder-icon";
  icon.setAttribute("aria-hidden", "true");
  const previews = document.createElement("span");
  previews.className = "folder-previews";
  const byId = new Map(documents.map((item) => [item.id, item]));
  for (const id of folder.documentIds.slice(0, 4)) {
    const item = byId.get(id);
    const preview = document.createElement("span");
    preview.className = `folder-mini-book cover-${normalizeCoverVariant(item.coverVariant, documents.indexOf(item))}`;
    preview.textContent = getDocumentDisplayTitle(item);
    previews.append(preview);
  }
  for (const child of children.slice(0, Math.max(0, 4 - folder.documentIds.length))) {
    const preview = document.createElement("span");
    preview.className = "folder-mini-book folder-mini-folder";
    preview.textContent = `▱ ${child.name}`;
    previews.append(preview);
  }
  icon.append(previews);
  const name = document.createElement("strong");
  name.className = "folder-name";
  name.textContent = folder.name;
  name.title = folder.name;
  const count = document.createElement("span");
  count.className = "folder-count";
  count.textContent = countText;
  count.title = countText;
  cover.append(icon, name, count);
  button.append(cover);
  button.onclick = () => {
    if (Date.now() < suppressDocumentClickUntil || documentDragState?.phase === "dragging") return;
    setShelfFolder(card.closest(".document-list"), folder.id);
  };
  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "folder-rename";
  rename.textContent = "✎";
  rename.title = "重命名文件夹";
  rename.setAttribute("aria-label", `重命名文件夹：${folder.name}`);
  rename.onpointerdown = (event) => event.stopPropagation();
  rename.onclick = () => openShelfNameDialog(folder.id);
  card.append(button, rename);
  card.addEventListener("pointerdown", (event) => prepareDocumentDrag(event, card, folder.id, "folder"));
  card.addEventListener("contextmenu", (event) => event.preventDefault());
  return card;
}

function openShelfNameDialog(folderId = "", parentId = "") {
  const dialog = document.querySelector("#shelf-name-dialog");
  const form = dialog.querySelector("form");
  const input = dialog.querySelector("input");
  const folder = getShelfState().folders.find((entry) => entry.id === folderId);
  dialog.querySelector("h2").textContent = folder ? "重命名文件夹" : "新建文件夹";
  input.value = folder?.name || "";
  input.setCustomValidity("");
  input.oninput = () => input.setCustomValidity("");
  form.onsubmit = (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.setCustomValidity("请输入文件夹名称");
      input.reportValidity();
      return;
    }
    const state = getShelfState();
    const liveFolder = state.folders.find((entry) => entry.id === folderId);
    if (liveFolder) liveFolder.name = name.slice(0, 80);
    else if (!folderId) {
      const id = newId();
      const targetId = state.folders.some((entry) => entry.id === parentId) ? parentId : "";
      state.folders.push({ id, name: name.slice(0, 80), parentId: targetId, documentIds: [], order: [] });
      getShelfContainerOrder(state, targetId).push(`folder:${id}`);
    }
    saveShelfState();
    dialog.close();
    renderDocumentList();
  };
  dialog.querySelector("[data-shelf-name-cancel]").onclick = () => dialog.close();
  dialog.showModal();
  input.focus();
  input.select();
}

function getShelfDropTarget(event, state) {
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const navigation = hit?.closest("[data-shelf-parent]");
  let target = null;
  if (navigation?.closest("[data-shelf-stage]") === state.listNode.closest("[data-shelf-stage]") &&
      navigation.dataset.folderId !== (state.listNode.dataset.folderId || "")) {
    target = navigation;
  } else {
    const card = hit?.closest(".folder-card");
    if (!card || card === state.card || card.closest(".document-list") !== state.listNode) return null;
    const rect = card.getBoundingClientRect();
    // Both books and folders can reach the center; the edges remain available for sorting.
    const insetX = rect.width * 0.2;
    const insetY = rect.height * 0.15;
    if (event.clientX > rect.left + insetX && event.clientX < rect.right - insetX &&
        event.clientY > rect.top + insetY && event.clientY < rect.bottom - insetY) target = card;
  }
  if (target && state.kind === "folder" && !canMoveShelfFolder(state.folderId, target.dataset.folderId || "")) return null;
  return target;
}

function updateShelfDropHover(event) {
  const state = documentDragState;
  state.dropTarget?.classList.remove("shelf-drop-hover");
  state.dropTarget = getShelfDropTarget(event, state);
  state.dropTarget?.classList.add("shelf-drop-hover");
  return state.dropTarget;
}
