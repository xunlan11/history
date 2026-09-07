const AUTH_TOKEN_KEY = `${SITE_STORAGE_PREFIX}.authToken`;
let currentUser = null;
let authReady = false;

const originalFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("Authorization", `Bearer ${token}`);
    init = { ...init, headers };
  }
  return originalFetch(input, init);
};

function authUi() {
  const bar = document.createElement("div"); bar.className = "auth-bar";
  bar.innerHTML = '<span id="auth-user"></span><button id="auth-admin" class="ghost-link hidden">管理账户</button><button id="auth-action" class="ghost-link">登录</button>';
  document.querySelector("header")?.append(bar);
  const modal = document.createElement("div"); modal.className = "auth-modal hidden"; modal.innerHTML = '<div class="auth-card"><h2 id="auth-title">登录</h2><input id="auth-username" placeholder="账号"><input id="auth-password" type="password" placeholder="密码"><p id="auth-error"></p><button id="auth-submit" class="primary-button">登录</button><button id="auth-switch" class="ghost-link">注册账户</button></div>';
  document.body.append(modal);
  document.querySelector("#auth-action").onclick = () => currentUser ? logout() : modal.classList.remove("hidden");
  document.querySelector("#auth-switch").onclick = () => { const reg = document.querySelector("#auth-title").textContent === "注册"; document.querySelector("#auth-title").textContent = reg ? "登录" : "注册"; document.querySelector("#auth-submit").textContent = reg ? "登录" : "注册"; document.querySelector("#auth-switch").textContent = reg ? "注册账户" : "返回登录"; };
  document.querySelector("#auth-submit").onclick = submitAuth;
  document.querySelector("#auth-admin").onclick = manageUsers;
}

async function submitAuth() {
  const isRegister = document.querySelector("#auth-title").textContent === "注册";
  const body = { username: document.querySelector("#auth-username").value, password: document.querySelector("#auth-password").value };
  const response = await originalFetch(`${HISTORY_BASE}/api/auth/${isRegister ? "register" : "login"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) { document.querySelector("#auth-error").textContent = (await response.json()).detail || "登录失败"; return; }
  const result = await response.json(); localStorage.setItem(AUTH_TOKEN_KEY, result.token); currentUser = result.user; authReady = true; document.querySelector(".auth-modal").classList.add("hidden"); updateAuthUi(); window.location.reload();
}
async function logout() { await originalFetch(`${HISTORY_BASE}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY)}` } }); localStorage.removeItem(AUTH_TOKEN_KEY); currentUser = null; window.location.href = new URL("index.html", location.href).href; }
function updateAuthUi() { document.querySelector("#auth-user").textContent = currentUser ? currentUser.username : ""; document.querySelector("#auth-action").textContent = currentUser ? "登出" : "登录"; document.querySelector("#auth-admin").classList.toggle("hidden", !currentUser?.isAdmin); }
async function ensureAuthenticated() {
  authUi(); const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) { const response = await originalFetch(`${HISTORY_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }); if (response.ok) { currentUser = (await response.json()).user; authReady = true; updateAuthUi(); return true; } localStorage.removeItem(AUTH_TOKEN_KEY); }
  document.querySelector(".auth-modal").classList.remove("hidden"); return false;
}
async function manageUsers() {
  const response = await fetch(`${HISTORY_BASE}/api/admin/users`); if (!response.ok) return;
  const users = await response.json();
  const create = prompt(`账户管理\n${users.map((u) => `${u.username}${u.isAdmin ? " (管理员)" : ""}`).join("\n")}\n\n输入“账号:密码”创建普通账户，取消关闭`);
  if (create?.includes(":")) {
    const [username, password] = create.split(":", 2);
    await fetch(`${HISTORY_BASE}/api/admin/users`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  }
}
