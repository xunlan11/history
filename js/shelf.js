// Personal shelf layout is independent of document metadata and permissions.
let shelfState = { folders: [], order: [] };
let shelfStorageKey = null;

function isPublicLibraryDocument(item) {
  return item?.visibility === "public" && !canEditDocument(item);
}

function getPublicLibraryDocuments() {
  return documents.filter(isPublicLibraryDocument);
}

function normalizeShelfState(value, items = documents) {
  items = items.filter((item) => canEditDocument(item));
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
  // 根目录（文献库）的显示名，可由标题行的重命名按钮自定义；空串表示用默认名。
  const rootName = typeof value?.rootName === "string" ? value.rootName.trim().slice(0, 80) : "";
  return { folders, order, rootName };
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
  } else if (kind !== "document" || !documents.some((item) => item.id === itemId && canEditDocument(item))) return false;
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
  delete listNode.dataset.publicLibrary;
  listNode.dataset.folderId = folderId;
  renderDocumentList();
  listNode.closest("[data-shelf-stage]").scrollTop = 0;
}

// 搜索只读取文献信息，不读取正文；可见性与其他栏目使用同样的匹配规则。
function normalizeShelfSearchText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

function getShelfSearchQuery(listNode) {
  return (listNode?.dataset.searchQuery || "").trim();
}

function matchesShelfSearch(item, query) {
  const text = normalizeShelfSearchText([
    item.title || "未识别", item.author || "未录", item.year || "未录",
    item.publisher || "未录", item.creator?.username || "创建者信息不可用",
    item.modifier?.username || "", item.tags || "未录",
    item.visibility === "public" ? "公开" : "私密",
  ].join("\n"));
  return normalizeShelfSearchText(query).trim().split(/\s+/).filter(Boolean)
    .every((term) => text.includes(term));
}

// 按各层书架顺序展开当前目录，搜索结果不包含文件夹卡片。
function getShelfSearchDocuments(state, folderId = "") {
  const foldersById = new Map(state.folders.map((folder) => [folder.id, folder]));
  const documentsById = new Map(documents.filter(canEditDocument).map((item) => [item.id, item]));
  const visited = new Set();
  const results = [];
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    const keys = id ? foldersById.get(id)?.order || [] : state.order;
    for (const key of keys) {
      if (key.startsWith("folder:")) visit(key.slice(7));
      else {
        const item = documentsById.get(key.slice(9));
        if (item) results.push(item);
      }
    }
  };
  visit(folderId);
  return results;
}

const shelfSearchForm = document.querySelector("#shelf-search-form");
const shelfSearchInput = document.querySelector("#shelf-search-input");
const shelfSearchClear = document.querySelector("#shelf-search-clear");

function updateShelfSearch() {
  const listNode = document.querySelector("[data-shelf-list]");
  if (!listNode || !shelfSearchInput) return;
  listNode.dataset.searchQuery = shelfSearchInput.value.trim();
  if (shelfSearchClear) shelfSearchClear.hidden = !getShelfSearchQuery(listNode);
  renderDocumentList();
  listNode.closest("[data-shelf-stage]").scrollTop = 0;
}

shelfSearchInput?.addEventListener("input", updateShelfSearch);
shelfSearchForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  updateShelfSearch();
});
shelfSearchClear?.addEventListener("click", () => {
  shelfSearchInput.value = "";
  updateShelfSearch();
  shelfSearchInput.focus();
});

// 根目录显示名：没自定义过就是「文献库」。
function getShelfRootName(state = getShelfState()) {
  return state.rootName || "文献库";
}

function getShelfPathParts(folder, state = getShelfState()) {
  const byId = new Map(state.folders.map((entry) => [entry.id, entry]));
  const ancestors = [];
  for (let current = folder; current; current = byId.get(current.parentId)) ancestors.unshift(current);
  return [getShelfRootName(state), ...ancestors.map((entry) => entry.name)];
}

// 当前目录及其所有子目录下的文献总数（不含文件夹本身）。
function countShelfDocuments(state = getShelfState(), folderId = "") {
  const childrenByParent = new Map();
  for (const folder of state.folders) {
    const key = folder.parentId || "";
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(folder);
  }
  const inAnyFolder = new Set(state.folders.flatMap((folder) => folder.documentIds));
  const countFrom = (id) => {
    const own = id
      ? state.folders.find((folder) => folder.id === id)?.documentIds.length || 0
      : documents.filter((item) => canEditDocument(item) && !inAnyFolder.has(item.id)).length;
    return own + (childrenByParent.get(id) || []).reduce((sum, child) => sum + countFrom(child.id), 0);
  };
  return countFrom(folderId || "");
}

// 标题里的层级：整条放得下就显示完整路径；放不下只留最后一层，
// 前面用重复的「›」标出省略了几层（不加省略号），最后一层从头显示、尾部省略。
function renderShelfTitle(listNode, folder, state = getShelfState()) {
  const renameButton = document.querySelector("#rename-shelf-folder");
  if (renameButton) renameButton.hidden = listNode.dataset.publicLibrary === "true";
  const node = document.querySelector("#shelf-title");
  if (!node) return;
  const parts = getShelfPathParts(folder, state);
  if (listNode.dataset.publicLibrary === "true") parts.push("公开文献库");
  node.classList.remove("is-collapsed");
  node.textContent = parts.join(" › ");
  if (parts.length < 2 || node.scrollWidth <= node.clientWidth + 1) return;
  node.classList.add("is-collapsed");
  node.textContent = `${"›".repeat(parts.length - 1)}${parts[parts.length - 1]}`;
}

// 窗口尺寸变了要重新决定要不要折叠（宽度变了服务端同步不会及时重渲染）。
let shelfTitleResizeFrame = 0;
window.addEventListener("resize", () => {
  window.cancelAnimationFrame(shelfTitleResizeFrame);
  shelfTitleResizeFrame = window.requestAnimationFrame(() => {
    const listNode = document.querySelector("[data-shelf-list]");
    if (!listNode) return;
    const state = getShelfState();
    renderShelfTitle(listNode, state.folders.find((entry) => entry.id === listNode.dataset.folderId), state);
  });
});

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
  const hint = document.createElement("small");
  hint.textContent = description;
  // 缺省状态的小字提示一律不显示，只有拖拽变形成故纸堆/解散时才由 setDocumentTrashMode 打开。
  hint.hidden = !description;
  button.append(icon, label, hint);
  card.append(button);
  return card;
}

// 同一个入口两种状态：平时是「新增文献」，开始拖拽后由 setDocumentTrashMode 变成「故纸堆」删除区。
// 每一层文件夹（含根目录）都渲染同一张卡片，行为完全一致。
function createShelfAddCard() {
  const card = createShelfUtilityCard("shelf-add-card", "＋", "新增文献", "");
  const button = card.querySelector("button");
  button.onclick = () => {
    if (Date.now() < suppressDocumentClickUntil) return;
    openDocumentForm();
  };
  return card;
}

// 不弹窗，直接在当前层建一个叫「新建文件夹」的文件夹，改名用文件夹卡片上的 ✎。
function createShelfFolder(parentId = "") {
  const state = getShelfState();
  const targetId = state.folders.some((entry) => entry.id === parentId) ? parentId : "";
  const id = newId();
  state.folders.push({ id, name: "新建文件夹", parentId: targetId, documentIds: [], order: [] });
  getShelfContainerOrder(state, targetId).push(`folder:${id}`);
  saveShelfState();
  renderDocumentList();
  return id;
}

const SHELF_CREATE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v4M10 13h4"/></svg>';
const SHELF_DISSOLVE_ICON = "↑";

// 「新建子文件夹」同样做成书架卡片，排在「新增文献 / 故纸堆」的下一个。
function createShelfCreateCard(folderId = "") {
  const card = createShelfUtilityCard("shelf-create-card", "", "新建文件夹", "");
  card.querySelector(".shelf-utility-icon").innerHTML = SHELF_CREATE_ICON;
  const button = card.querySelector("button");
  button.onclick = () => {
    if (Date.now() < suppressDocumentClickUntil) return;
    createShelfFolder(folderId);
  };
  return card;
}

// 公共入口固定在个人书架的工具卡片之后，不参与排序或拖拽。
function createPublicLibraryCard(listNode) {
  const card = createShelfUtilityCard("shelf-public-card", "◎", "公开文献库", "");
  const button = card.querySelector("button");
  button.onclick = () => {
    if (Date.now() < suppressDocumentClickUntil) return;
    listNode.dataset.publicLibrary = "true";
    renderDocumentList();
    listNode.closest("[data-shelf-stage]").scrollTop = 0;
  };
  return card;
}

function createPublicLibraryReturnCard(listNode, folder, state) {
  const name = folder?.name || getShelfRootName(state);
  const card = createShelfUtilityCard("shelf-parent-card", "↰", name, "");
  const button = card.querySelector("button");
  button.onclick = () => setShelfFolder(listNode, folder?.id || "");
  return card;
}

// 拖拽文件夹时把这张卡切成「解散文件夹」：拖到它上面松手 = 删掉该文件夹、内容上移一层。
function setShelfDissolveMode(listNode, isActive) {
  const card = listNode.querySelector(".shelf-create-card");
  if (!card) return;
  card.classList.toggle("dissolve-active", isActive);
  card.classList.remove("dissolve-hover");
  const icon = card.querySelector(".shelf-utility-icon");
  if (icon) icon.innerHTML = isActive ? SHELF_DISSOLVE_ICON : SHELF_CREATE_ICON;
  const name = card.querySelector(".folder-name");
  if (name) name.textContent = isActive ? "解散" : "新建文件夹";
  const hint = card.querySelector("small");
  if (hint) {
    hint.textContent = isActive ? "内容移到上层" : "";
    hint.hidden = !isActive;
  }
}

// 递归取得某个文件夹下的全部文件夹与文献（不含自身以外的前置节点）。
function collectShelfFolder(state, folderId) {
  const folders = [];
  const documentIds = [];
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const folder = state.folders.find((entry) => entry.id === id);
    if (!folder) return;
    folders.push(folder);
    documentIds.push(...folder.documentIds);
    for (const child of state.folders) if (child.parentId === id) walk(child.id);
  };
  walk(folderId);
  return { folders, documentIds };
}

// 递归删除文件夹：文件夹及其子文件夹全部移除，里面的文献交给 deleteDocument
// （不可编辑的文献 deleteDocument 会忽略，随后 normalizeShelfState 把它们退回根目录）。
function deleteShelfFolder(folderId) {
  const state = getShelfState();
  if (!state.folders.some((entry) => entry.id === folderId)) return false;
  const { folders, documentIds } = collectShelfFolder(state, folderId);
  const folderIds = new Set(folders.map((entry) => entry.id));
  const removedKeys = new Set([
    ...folders.map((entry) => `folder:${entry.id}`),
    ...documentIds.map((id) => `document:${id}`),
  ]);
  const dropRemoved = (order) => order.filter((key) => !removedKeys.has(key));
  state.folders = state.folders.filter((entry) => !folderIds.has(entry.id));
  state.order = dropRemoved(state.order);
  for (const survivor of state.folders) {
    survivor.order = dropRemoved(survivor.order);
    survivor.documentIds = survivor.documentIds.filter((id) => !documentIds.includes(id));
  }
  saveShelfState();
  for (const id of documentIds) deleteDocument(id);
  // 文献删除后重存一次，把已不存在的文献键从顺序里清掉。
  saveShelfState();
  return true;
}

function requestDeleteShelfFolder(folderId) {
  const state = getShelfState();
  const folder = state.folders.find((entry) => entry.id === folderId);
  if (!folder) return false;
  const { folders, documentIds } = collectShelfFolder(state, folderId);
  const subCount = folders.length - 1;
  const ownedCount = documentIds.filter((id) => canEditDocument(documents.find((item) => item.id === id))).length;
  const keptCount = documentIds.length - ownedCount;
  const bits = [];
  if (subCount) bits.push(`${subCount} 个子文件夹`);
  if (ownedCount) bits.push(`${ownedCount} 篇文献`);
  const what = bits.length ? `及 ${bits.join("、")}` : "";
  const note = keptCount ? `（其中 ${keptCount} 篇非本人文献会移到上层）` : "";
  if (!window.confirm(`删除“${folder.name}”${what}？删除后不可找回。${note}`)) return false;
  return deleteShelfFolder(folderId);
}

// 只在文件夹内渲染：一级文件夹显示「文献库」，更深层显示上一级文件夹名；根目录没有上级，不渲染本卡片。
function createShelfParentCard(listNode, folder, state) {
  const parent = state.folders.find((entry) => entry.id === folder.parentId);
  const parentName = parent?.name || getShelfRootName(state);
  const card = createShelfUtilityCard("shelf-parent-card", "↰", parentName, "");
  card.dataset.shelfParent = "";
  card.dataset.folderId = parent?.id || "";
  const button = card.querySelector("button");
  button.setAttribute("aria-label", `返回上一级文件夹：${parentName}`);
  button.onclick = () => {
    if (Date.now() >= suppressDocumentClickUntil) setShelfFolder(listNode, parent?.id || "");
  };
  return card;
}

// 拖拽时这张卡也进入可投放态：拖文献或文件夹到它上面松手，就把拖的东西移到上一层。
function setShelfParentMode(listNode, isActive) {
  const card = listNode.querySelector(".shelf-parent-card");
  if (!card) return;
  card.classList.toggle("move-active", isActive);
  const hint = card.querySelector("small");
  if (hint) {
    hint.textContent = isActive ? "移到上层" : "";
    hint.hidden = !isActive;
  }
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
  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "folder-rename";
  rename.textContent = "✎";
  rename.setAttribute("aria-label", `重命名文件夹：${folder.name}`);
  rename.onpointerdown = (event) => event.stopPropagation();
  rename.onclick = () => openShelfNameDialog(folder.id);
  const nameRow = document.createElement("span");
  nameRow.className = "folder-name-row";
  nameRow.append(name, rename);
  const count = document.createElement("span");
  count.className = "folder-count";
  count.textContent = countText;
  count.title = countText;
  cover.append(icon, nameRow, count);
  // 打开按钮做成覆盖整张卡片的透明层：<button> 里不能嵌 <button>，改名按钮只能与它并列。
  card.append(button, cover);
  button.onclick = () => {
    if (Date.now() < suppressDocumentClickUntil || documentDragState?.phase === "dragging") return;
    setShelfFolder(card.closest(".document-list"), folder.id);
  };
  card.addEventListener("pointerdown", (event) => prepareDocumentDrag(event, card, folder.id, "folder"));
  card.addEventListener("contextmenu", (event) => event.preventDefault());
  return card;
}

// 只用于重命名（新建文件夹已改成点击即建，不再走弹窗）。
function openShelfNameDialog(folderId = "") {
  const dialog = document.querySelector("#shelf-name-dialog");
  const form = dialog.querySelector("form");
  const input = dialog.querySelector("input");
  const state = getShelfState();
  const folder = folderId ? state.folders.find((entry) => entry.id === folderId) : null;
  if (folderId && !folder) return;
  // 传空 folderId 就是重命名根目录（文献库）的显示名；标题统一成「重命名 + 当前名字」。
  const currentName = folder ? folder.name : getShelfRootName(state);
  dialog.querySelector("h2").textContent = `重命名 ${currentName}`;
  input.value = currentName;
  input.setCustomValidity("");
  input.oninput = () => input.setCustomValidity("");
  form.onsubmit = (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.setCustomValidity("请输入名称");
      input.reportValidity();
      return;
    }
    const live = getShelfState();
    if (folderId) {
      const liveFolder = live.folders.find((entry) => entry.id === folderId);
      if (liveFolder) liveFolder.name = name.slice(0, 80);
    } else {
      live.rootName = name.slice(0, 80);
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

// 标题行里的「重命名当前文件夹」按钮（根目录时改的是「文献库」这个显示名）。
document.querySelector("#rename-shelf-folder")?.addEventListener("click", () => {
  const listNode = document.querySelector("[data-shelf-list]");
  if (!listNode) return;
  openShelfNameDialog(listNode.dataset.folderId || "");
});

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
