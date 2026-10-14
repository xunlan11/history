const AUTH_TOKEN_KEY = `${SITE_STORAGE_PREFIX}.authToken`;
// 认证模式按站点区分：history 保留本站本地账号（登录弹窗 + Bearer Token）；
// 其余站点（如 literature）走问渠统一登录（wenqu_session Cookie，跳转 /login）。
const USE_SSO = (typeof SITE_ID === "string" ? SITE_ID : "history") !== "history";
let currentUser = null;

const originalFetch = window.fetch.bind(window);
if (!USE_SSO) {
  // 本地登录站点：为所有同源请求自动附加 Bearer Token。
  window.fetch = (input, init = {}) => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (token) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set("Authorization", `Bearer ${token}`);
      init = { ...init, headers };
    }
    return originalFetch(input, init);
  };
}

function authUi() {
  // 认证控件只在首页顶部栏渲染。
  const isHomePage = document.body?.dataset.page === "library";
  if (isHomePage) {
    const bar = document.createElement("div"); bar.className = "auth-bar";
    const accountLink = USE_SSO
      ? '<a class="ghost-link settings-button icon-text-button" href="/account" style="text-decoration:none">个人中心</a>'
      : "";
    bar.innerHTML = `<div class="auth-actions"><span id="auth-user" class="auth-user hidden"></span>${accountLink}<button id="auth-action" class="ghost-link settings-button icon-text-button" type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3"></circle><path d="M5 21a7 7 0 0 1 14 0"></path></svg><span id="auth-label">登录</span></button><button id="auth-admin" class="ghost-link settings-button icon-text-button hidden" type="button" aria-haspopup="dialog" aria-controls="accounts-dialog"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"></circle><path d="M2.5 21a6.5 6.5 0 0 1 13 0"></path><path d="M16 5.5a3 3 0 0 1 0 5.8"></path><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.8"></path></svg>管理</button></div>`;
    document.querySelector("#auth-slot")?.append(bar);
  }
  if (USE_SSO) {
    // SSO 站点：点“登录”跳转统一登录页。
    document.querySelector("#auth-action")?.addEventListener("click", () => {
      if (currentUser) {
        logout();
        return;
      }
      loginRedirect();
    });
  } else {
    // 本地登录站点：渲染账号/密码弹窗（history 原有交互）。
    const modal = document.createElement("div");
    modal.className = "auth-modal hidden";
    modal.innerHTML = '<form class="auth-card" id="auth-form" method="post" autocomplete="on" novalidate><h2 id="auth-title">登录</h2><input id="auth-username" name="username" type="text" autocomplete="username" placeholder="账号"><input id="auth-password" name="password" type="password" autocomplete="off" placeholder="密码"><p id="auth-error"></p><button id="auth-submit" class="primary-button" type="submit">登录</button><button id="auth-switch" class="ghost-link" type="button">注册账户</button></form>';
    document.body.append(modal);
    setAuthInputRequirements(false);
    document.querySelector("#auth-action")?.addEventListener("click", () => {
      if (currentUser) {
        logout();
        return;
      }
      modal.classList.remove("hidden");
    });
    document.querySelector("#auth-switch").onclick = () => {
      const registerMode = document.querySelector("#auth-title").textContent !== "注册";
      document.querySelector("#auth-title").textContent = registerMode ? "注册" : "登录";
      document.querySelector("#auth-submit").textContent = registerMode ? "注册" : "登录";
      document.querySelector("#auth-switch").textContent = registerMode ? "返回登录" : "注册账户";
      setAuthInputRequirements(registerMode);
    };
    document.querySelector("#auth-form").addEventListener("submit", (event) => {
      event.preventDefault();
      submitAuth();
    });
  }
  document.querySelector("#auth-admin")?.addEventListener("click", manageUsers);
}

function setAuthInputRequirements(registerMode) {
  const usernameInput = document.querySelector("#auth-username");
  const passwordInput = document.querySelector("#auth-password");
  if (!usernameInput || !passwordInput) return;
  usernameInput.placeholder = registerMode ? "账号（至少2个字符）" : "账号";
  passwordInput.placeholder = registerMode ? "密码（至少6个字符）" : "密码";
  usernameInput.minLength = registerMode ? 2 : 0;
  passwordInput.minLength = registerMode ? 6 : 0;
  // 只在用户名输入框保留浏览器的账户建议。
  passwordInput.autocomplete = "off";
}

async function submitAuth() {
  const isRegister = document.querySelector("#auth-title").textContent === "注册";
  const usernameInput = document.querySelector("#auth-username");
  const passwordInput = document.querySelector("#auth-password");
  const errorNode = document.querySelector("#auth-error");
  const body = { username: usernameInput.value.trim(), password: passwordInput.value };
  errorNode.textContent = "";
  if (!body.username) {
    errorNode.textContent = "请输入账号";
    return;
  }
  if (!body.password) {
    errorNode.textContent = "请输入密码";
    return;
  }
  if (isRegister && body.username.length < 2) {
    errorNode.textContent = "账号至少需要2个字符";
    return;
  }
  if (isRegister && body.password.length < 6) {
    errorNode.textContent = "密码至少需要6个字符";
    return;
  }
  const submit = document.querySelector("#auth-submit");
  submit.disabled = true;
  try {
    const authPath = isRegister ? "/data/api/auth/register" : "/data/api/auth/login";
    const response = await originalFetch(endpoint(authPath), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let result = {};
    try { result = await response.json(); } catch (_) { /* 非 JSON 代理错误 */ }
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
    document.querySelector(".auth-modal")?.classList.add("hidden");
    updateAuthUi();
    window.location.reload();
  } catch (error) {
    errorNode.textContent = "无法连接账户服务，请确认数据服务已启动";
  } finally {
    submit.disabled = false;
  }
}

function loginRedirect() {
  location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
}

async function logout() {
  if (USE_SSO) {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  } else {
    await originalFetch(endpoint("/data/api/auth/logout"), {
      method: "POST",
      headers: { Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY) || ""}` },
    }).catch(() => {});
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }
  currentUser = null;
  window.location.href = new URL("index.html", location.href).href;
}

function updateAuthUi() {
  const actionNode = document.querySelector("#auth-action");
  const adminNode = document.querySelector("#auth-admin");
  if (!actionNode || !adminNode) return;
  const labelNode = actionNode.querySelector("#auth-label");
  const label = currentUser ? "登出" : "登录";
  if (labelNode) labelNode.textContent = label;
  else actionNode.textContent = label;
  actionNode.setAttribute("aria-label", currentUser ? "登出" : "登录");
  actionNode.removeAttribute("title");
  const userNode = document.querySelector("#auth-user");
  if (userNode) {
    userNode.textContent = currentUser
      ? `${currentUser.username}（${currentUser.isAdmin ? "管理员" : "普通用户"}）`
      : "";
    userNode.classList.toggle("hidden", !currentUser);
  }
  adminNode.classList.toggle("hidden", !currentUser?.isAdmin);
}

async function ensureAuthenticated() {
  authUi();
  if (USE_SSO) {
    // SSO 站点：wenqu_session Cookie 由浏览器自动携带。
    const response = await fetch(endpoint("/data/api/auth/me"), { credentials: "same-origin" });
    if (response.ok) {
      const data = await response.json();
      if (data.user) {
        currentUser = data.user;
        updateAuthUi();
        return true;
      }
    }
    // 未登录：首页（library）以未登录状态停留在本模块；受保护页才跳转 SSO 登录。
    updateAuthUi();
    if (document.body?.dataset.page !== "library") {
      loginRedirect();
    }
    return false;
  }
  // 本地登录站点：无 Token 时弹出登录框；Token 失效则清除后重新弹出。
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) {
    document.querySelector(".auth-modal")?.classList.remove("hidden");
    return false;
  }
  const response = await originalFetch(endpoint("/data/api/auth/me"), { headers: { Authorization: `Bearer ${token}` } });
  if (response.ok) {
    currentUser = (await response.json()).user;
    updateAuthUi();
    return true;
  }
  localStorage.removeItem(AUTH_TOKEN_KEY);
  document.querySelector(".auth-modal")?.classList.remove("hidden");
  return false;
}

async function manageUsers() {
  if (!currentUser?.isAdmin || typeof window.openAccountsModal !== "function") return;
  window.openAccountsModal();
}
