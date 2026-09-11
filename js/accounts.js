// —— 账户管理弹窗 ——
// 用户管理（列表 / 搜索 / 分页 / 角色切换 / 删除），以弹窗形式展示，替代独立 accounts.html 页面。
(function () {
  const PAGE_SIZE = 15;
  let users = [];
  let query = "";
  let page = 1;

  let dialog = null;
  let tbody = null;
  let paginationEl = null;
  let countEl = null;
  let searchInput = null;
  let toastEl = null;
  let confirmDialog = null;
  let confirmTitle = null;
  let confirmMessage = null;
  let confirmOk = null;
  let confirmCancel = null;
  let previouslyFocused = null;

  function endpointPath(sub) {
    return `/data/api/admin/users${sub}`;
  }

  async function api(path, options = {}) {
    const response = await fetch(endpoint(path), options);
    let data = null;
    try { data = await response.json(); } catch (_) { /* 非 JSON 响应 */ }
    if (!response.ok) {
      const error = new Error((data && data.detail) || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function myId() {
    return currentUser ? Number(currentUser.id) : null;
  }

  function isSelf(id) {
    return myId() !== null && Number(id) === myId();
  }

  function toast(message, isError = false) {
    if (!toastEl || !message) return;
    toastEl.textContent = message;
    toastEl.classList.toggle("toast-error", isError);
    toastEl.classList.remove("hidden");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toastEl.classList.add("hidden"), 2600);
  }

  function filterAndSort(list) {
    const q = query.trim().toLowerCase();
    let result = list.slice();
    if (q) result = result.filter((u) => String(u.username).toLowerCase().includes(q));
    return result.sort((a, b) => Number(a.id) - Number(b.id));
  }

  function rowHtml(user) {
    const isAdmin = Boolean(user.isAdmin);
    const roleHtml = isAdmin
      ? '<span class="account-tag account-tag-admin">管理员</span>'
      : '<span class="account-tag account-tag-user">普通用户</span>';
    const created = user.createdAt ? formatDateTime(new Date(user.createdAt)) : "";
    let actions = "";
    if (isSelf(user.id)) {
      actions = '<span class="accounts-current">当前账户</span>';
    } else {
      const toggle = isAdmin
        ? `<button type="button" class="accounts-btn" data-id="${user.id}" data-act="role" data-val="0">设为普通用户</button>`
        : `<button type="button" class="accounts-btn" data-id="${user.id}" data-act="role" data-val="1">设为管理员</button>`;
      actions = `<div class="accounts-row">${toggle}<button type="button" class="accounts-btn accounts-btn-danger" data-id="${user.id}" data-act="delete">删除</button></div>`;
    }
    return (
      "<tr>" +
      `<td class="col-id">${user.id}</td>` +
      `<td class="col-username">${escapeHtml(user.username)}</td>` +
      `<td>${roleHtml}</td>` +
      `<td class="col-created">${escapeHtml(created)}</td>` +
      `<td class="col-actions">${actions}</td>` +
      "</tr>"
    );
  }

  function renderPagination(totalCount, totalPages) {
    paginationEl.innerHTML = "";
    if (!totalCount) {
      const info = document.createElement("span");
      info.className = "pagination-info";
      info.textContent = "暂无账户";
      paginationEl.appendChild(info);
      return;
    }

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "accounts-btn";
    prevBtn.textContent = "◀";
    prevBtn.disabled = page <= 1;
    prevBtn.addEventListener("click", () => { if (page > 1) { page -= 1; render(); } });

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "accounts-btn";
    nextBtn.textContent = "▶";
    nextBtn.disabled = page >= totalPages;
    nextBtn.addEventListener("click", () => { if (page < totalPages) { page += 1; render(); } });

    const info = document.createElement("span");
    info.className = "pagination-info";
    info.textContent = "第 ";
    const input = document.createElement("input");
    input.type = "number";
    input.className = "pagination-input";
    input.min = "1";
    input.max = String(totalPages);
    input.value = String(page);
    input.title = "输入页码后按回车";
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const target = parseInt(input.value, 10);
        if (!Number.isNaN(target)) goToPage(target);
      }
    });
    input.addEventListener("blur", () => { input.value = String(page); });
    info.appendChild(input);
    const suffix = document.createElement("span");
    suffix.textContent = ` / ${totalPages} 页`;
    info.appendChild(suffix);

    paginationEl.appendChild(prevBtn);
    paginationEl.appendChild(info);
    paginationEl.appendChild(nextBtn);
  }

  function goToPage(target) {
    const total = filteredCount();
    const totalPages = total ? Math.ceil(total / PAGE_SIZE) : 1;
    const next = Math.max(1, Math.min(target, totalPages));
    if (next === page) return;
    page = next;
    render();
  }

  function filteredCount() {
    return filterAndSort(users).length;
  }

  function render() {
    const filtered = filterAndSort(users);
    const total = filtered.length;
    const totalPages = total ? Math.ceil(total / PAGE_SIZE) : 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const start = total ? (page - 1) * PAGE_SIZE : 0;
    const rows = filtered.slice(start, start + PAGE_SIZE);
    countEl.textContent = `共 ${total} 人`;
    if (rows.length) {
      tbody.innerHTML = rows.map(rowHtml).join("");
    } else {
      tbody.innerHTML = '<tr><td class="accounts-empty" colspan="5">没有匹配的账户</td></tr>';
    }
    renderPagination(total, totalPages);
  }

  async function loadUsers() {
    users = await api(endpointPath(""));
    render();
  }

  function askConfirm(title, message, okText) {
    return new Promise((resolve) => {
      confirmTitle.textContent = title;
      confirmMessage.textContent = message;
      confirmOk.textContent = okText;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        confirmDialog.classList.add("hidden");
        confirmOk.onclick = null;
        confirmCancel.onclick = null;
        resolve(value);
      };
      confirmOk.onclick = () => finish(true);
      confirmCancel.onclick = () => finish(false);
      confirmDialog.classList.remove("hidden");
    });
  }

  async function handleAction(button) {
    const user = users.find((u) => Number(u.id) === Number(button.dataset.id));
    if (!user) return;
    const act = button.dataset.act;
    if (act === "delete") {
      const ok = await askConfirm("删除账户", `确定删除账户 “${user.username}” 吗？删除后无法恢复。`, "删除");
      if (!ok) return;
      try {
        await api(endpointPath(`/${user.id}`), { method: "DELETE" });
        toast(`已删除账户 “${user.username}”`);
      } catch (error) {
        toast(error.message, true);
      }
      await loadUsers();
      return;
    }
    if (act === "role") {
      const isAdmin = button.dataset.val === "1";
      const ok = await askConfirm(
        "修改角色",
        `确定将 “${user.username}” 设为${isAdmin ? "管理员" : "普通用户"}吗？`,
        "确认"
      );
      if (!ok) return;
      try {
        await api(endpointPath(`/${user.id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isAdmin }),
        });
        toast(`已将 “${user.username}” 设为${isAdmin ? "管理员" : "普通用户"}`);
      } catch (error) {
        toast(error.message, true);
      }
      await loadUsers();
    }
  }

  function buildDialog() {
    dialog = document.createElement("div");
    dialog.className = "accounts-dialog hidden";
    dialog.id = "accounts-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "accounts-title");
    dialog.innerHTML = `
      <section class="accounts-dialog-card">
        <header class="accounts-header">
          <h2 id="accounts-title">账户管理</h2>
          <button class="icon-button subtle" id="close-accounts" type="button" aria-label="关闭">×</button>
        </header>
        <div class="accounts-toolbar">
          <div class="accounts-toolbar-left">
            <input id="accounts-search" class="accounts-search" type="search" placeholder="搜索用户名" autocomplete="off" />
          </div>
          <div id="accounts-pagination" class="accounts-pagination"></div>
          <div id="accounts-count" class="accounts-count">共 0 人</div>
        </div>
        <div class="accounts-table-wrap">
          <table class="accounts-table">
            <colgroup>
              <col class="col-id" />
              <col class="col-username" />
              <col class="col-role" />
              <col class="col-created" />
              <col class="col-actions" />
            </colgroup>
            <thead>
              <tr><th>ID</th><th>用户名</th><th>角色</th><th>创建时间</th><th>操作</th></tr>
            </thead>
            <tbody id="accounts-tbody"></tbody>
          </table>
        </div>
      </section>`;

    const confirm = document.createElement("div");
    confirm.className = "confirm-dialog hidden";
    confirm.id = "accounts-confirm";
    confirm.setAttribute("role", "dialog");
    confirm.setAttribute("aria-modal", "true");
    confirm.setAttribute("aria-labelledby", "accounts-confirm-title");
    confirm.innerHTML = `
      <div class="confirm-card">
        <h2 id="accounts-confirm-title">确认操作</h2>
        <p id="accounts-confirm-message"></p>
        <div class="confirm-actions">
          <button class="secondary-button" id="accounts-confirm-cancel" type="button">取消</button>
          <button class="danger-button" id="accounts-confirm-ok" type="button">确认</button>
        </div>
      </div>`;

    const toast = document.createElement("div");
    toast.className = "accounts-toast hidden";
    toast.id = "accounts-toast";
    toast.setAttribute("role", "status");

    document.body.append(dialog, confirm, toast);

    tbody = dialog.querySelector("#accounts-tbody");
    paginationEl = dialog.querySelector("#accounts-pagination");
    countEl = dialog.querySelector("#accounts-count");
    searchInput = dialog.querySelector("#accounts-search");
    toastEl = toast;
    confirmDialog = confirm;
    confirmTitle = confirm.querySelector("#accounts-confirm-title");
    confirmMessage = confirm.querySelector("#accounts-confirm-message");
    confirmOk = confirm.querySelector("#accounts-confirm-ok");
    confirmCancel = confirm.querySelector("#accounts-confirm-cancel");
  }

  function bindEvents() {
    dialog.querySelector("#close-accounts").addEventListener("click", closeAccountsModal);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeAccountsModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (confirmDialog && !confirmDialog.classList.contains("hidden")) {
        confirmCancel.click();
        return;
      }
      if (dialog && !dialog.classList.contains("hidden")) closeAccountsModal();
    });
    searchInput.addEventListener("input", () => {
      clearTimeout(bindEvents._timer);
      bindEvents._timer = setTimeout(() => {
        query = searchInput.value;
        page = 1;
        render();
      }, 220);
    });
    tbody.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-act]");
      if (button) handleAction(button);
    });
    confirmDialog.addEventListener("click", (event) => {
      if (event.target === confirmDialog) confirmCancel.click();
    });
  }

  function openAccountsModal() {
    if (!dialog) {
      buildDialog();
      bindEvents();
    }
    query = "";
    page = 1;
    if (searchInput) searchInput.value = "";
    previouslyFocused = document.activeElement;
    dialog.classList.remove("hidden");
    searchInput.focus();
    loadUsers().catch((error) => toast(error.message, true));
  }

  function closeAccountsModal() {
    if (!dialog) return;
    dialog.classList.add("hidden");
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
  }

  window.openAccountsModal = openAccountsModal;
  window.closeAccountsModal = closeAccountsModal;
})();
