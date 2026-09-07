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
  bar.innerHTML = '<span id="auth-user" class="hidden"></span><div class="auth-actions"><button id="auth-admin" class="ghost-link hidden">管理</button><button id="auth-action" class="ghost-link">登录</button></div>';
  (document.querySelector("#auth-slot") || document.querySelector("header"))?.append(bar);
  const modal = document.createElement("div"); modal.className = "auth-modal hidden"; modal.innerHTML = '<div class="auth-card"><h2 id="auth-title">登录</h2><input id="auth-username" placeholder="账号"><input id="auth-password" type="password" placeholder="密码"><p id="auth-error"></p><button id="auth-submit" class="primary-button">登录</button><button id="auth-switch" class="ghost-link">注册账户</button></div>';
  document.body.append(modal);
  document.querySelector("#auth-action").onclick = () => currentUser ? logout() : modal.classList.remove("hidden");
  document.querySelector("#auth-switch").onclick = () => { const reg = document.querySelector("#auth-title").textContent === "注册"; document.querySelector("#auth-title").textContent = reg ? "登录" : "注册"; document.querySelector("#auth-submit").textContent = reg ? "登录" : "注册"; document.querySelector("#auth-switch").textContent = reg ? "注册账户" : "返回登录"; };
  document.querySelector("#auth-submit").onclick = submitAuth;
  document.querySelectorAll("#auth-username, #auth-password").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitAuth();
    });
  });
  document.querySelector("#auth-admin").onclick = manageUsers;
}

async function submitAuth() {
  const isRegister = document.querySelector("#auth-title").textContent === "注册";
  const usernameInput = document.querySelector("#auth-username");
  const passwordInput = document.querySelector("#auth-password");
  const errorNode = document.querySelector("#auth-error");
  const body = { username: usernameInput.value.trim(), password: passwordInput.value };
  errorNode.textContent = "";
  if (!body.username || !body.password) {
    errorNode.textContent = "请输入账号和密码";
    return;
  }
  const submit = document.querySelector("#auth-submit");
  submit.disabled = true;
  try {
    const authPath = isRegister ? "/data/api/auth/register" : "/data/api/auth/login";
    const response = await originalFetch(endpoint(authPath), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let result = {};
    try { result = await response.json(); } catch (_) { /* non-JSON proxy errors */ }
    if (!response.ok) {
      errorNode.textContent = result.detail || `请求失败（${response.status}）`;
      return;
    }
    if (!result.token || !result.user) {
      errorNode.textContent = "服务器返回无效登录信息";
      return;
    }
    localStorage.setItem(AUTH_TOKEN_KEY, result.token);
    currentUser = result.user;
    authReady = true;
    document.querySelector(".auth-modal").classList.add("hidden");
    updateAuthUi();
    window.location.reload();
  } catch (error) {
    errorNode.textContent = "无法连接账户服务，请确认数据服务已启动";
  } finally {
    submit.disabled = false;
  }
}
async function logout() { await originalFetch(endpoint("/data/api/auth/logout"), { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY)}` } }); localStorage.removeItem(AUTH_TOKEN_KEY); currentUser = null; window.location.href = new URL("index.html", location.href).href; }
function updateAuthUi() {
  const userNode = document.querySelector("#auth-user");
  userNode.textContent = currentUser ? currentUser.username : "";
  userNode.classList.toggle("hidden", !currentUser);
  document.querySelector("#auth-action").textContent = currentUser ? "登出" : "登录";
  document.querySelector("#auth-admin").classList.toggle("hidden", !currentUser?.isAdmin);
}
async function ensureAuthenticated() {
  authUi(); const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) { const response = await originalFetch(endpoint("/data/api/auth/me"), { headers: { Authorization: `Bearer ${token}` } }); if (response.ok) { currentUser = (await response.json()).user; authReady = true; updateAuthUi(); return true; } localStorage.removeItem(AUTH_TOKEN_KEY); }
  document.querySelector(".auth-modal").classList.remove("hidden"); return false;
}
async function manageUsers() {
  // 完整账户管理页（列表/搜索/分页/新建/角色/删除），仿 poem 平台的用户管理
  window.location.href = new URL("accounts.html", location.href).href;
}
