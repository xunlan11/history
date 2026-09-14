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
  // Authentication controls are only rendered in the homepage top bar.
  const isHomePage = document.body?.dataset.page === "library";
  if (isHomePage) {
    const bar = document.createElement("div"); bar.className = "auth-bar";
    bar.innerHTML = '<div class="auth-actions"><button id="auth-admin" class="ghost-link settings-button hidden" type="button" aria-haspopup="dialog" aria-controls="accounts-dialog">管理</button><button id="auth-action" class="ghost-link settings-button" type="button">登录</button></div>';
    document.querySelector("#auth-slot")?.append(bar);
  }
  document.querySelector("#auth-action")?.addEventListener("click", () => {
    if (currentUser) {
      logout();
      return;
    }
    showAuthModal();
  });
  document.querySelector("#auth-admin")?.addEventListener("click", manageUsers);
}

// 登录与注册必须是两个独立的 <form>：Chromium 明确要求不要把「登录」「注册」
// 这类不同流程合并到同一个表单里；字段上的 autocomplete（username /
// current-password / new-password）也是浏览器识别登录表单并保存、回填
// 「账号 + 密码」这一对凭据的前提，缺一不可。
const AUTH_MODAL_HTML = `
  <form class="auth-card" id="auth-login-form" method="post" autocomplete="on" novalidate>
    <h2 id="auth-title">登录</h2>
    <input id="auth-username" name="username" type="text" autocomplete="username" placeholder="账号">
    <input id="auth-password" name="password" type="password" autocomplete="current-password" placeholder="密码">
    <p id="auth-error" class="auth-error"></p>
    <button id="auth-submit" class="primary-button" type="submit">登录</button>
    <button id="auth-switch" class="ghost-link" type="button">注册账户</button>
  </form>
  <form class="auth-card hidden" id="auth-register-form" method="post" autocomplete="on" novalidate>
    <h2>注册</h2>
    <input id="register-username" name="username" type="text" autocomplete="username" placeholder="账号（至少2个字符）">
    <input id="register-password" name="password" type="password" autocomplete="new-password" placeholder="密码（至少6个字符）">
    <p id="register-error" class="auth-error"></p>
    <button id="register-submit" class="primary-button" type="submit">注册</button>
    <button id="register-switch" class="ghost-link" type="button">返回登录</button>
  </form>`;

function authModal() {
  let modal = document.querySelector(".auth-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.className = "auth-modal hidden";
    modal.innerHTML = AUTH_MODAL_HTML;
    document.body.append(modal);
    bindAuthModal(modal);
  }
  return modal;
}

function bindAuthModal(modal) {
  const loginForm = modal.querySelector("#auth-login-form");
  const registerForm = modal.querySelector("#auth-register-form");
  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAuth(loginForm, false);
  });
  registerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAuth(registerForm, true);
  });
  modal.querySelector("#auth-switch").addEventListener("click", () => toggleAuthMode(true));
  modal.querySelector("#register-switch").addEventListener("click", () => toggleAuthMode(false));
}

function toggleAuthMode(registerMode) {
  document.querySelector("#auth-login-form")?.classList.toggle("hidden", registerMode);
  document.querySelector("#auth-register-form")?.classList.toggle("hidden", !registerMode);
}

function showAuthModal() {
  authModal().classList.remove("hidden");
}

// Chromium 判定「登录成功」的条件之一是提交后密码表单从页面中消失
// （见 Create Amazing Password Forms），因此这里整体移除弹窗而不是仅隐藏；
// 否则浏览器会认为登录失败，永远不会提示保存密码。
function dismissAuthModal() {
  document.querySelector(".auth-modal")?.remove();
}

// 说明：此处曾用 navigator.credentials.get({ password: true, mediation: "silent" })
// 试图「补填」浏览器没有填的密码，但它永远拿不到值：
//   1) Credential Management API 只返回本站通过 navigator.credentials.store()
//      写入的凭据，本项目从未写入过；
//   2) mediation: "silent" 在缺少用户授权时按规范直接 resolve(null)；
//   3) 异常被空 catch 吞掉，所以表现为「代码写了但完全没生效」。
// 正确做法是让浏览器自己保存并回填「账号 + 密码」，见 submitAuth / ensureAuthenticated。
async function submitAuth(form, isRegister) {
  const usernameInput = form.querySelector('input[name="username"]');
  const passwordInput = form.querySelector('input[name="password"]');
  const errorNode = form.querySelector(".auth-error");
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
  const submit = form.querySelector('button[type="submit"]');
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
    updateAuthUi();
    // 先移除登录表单，再整页刷新：Chromium 只有在提交后「密码表单消失」时
    // 才认定登录成功并提示保存账号 + 密码，下次点账号才会连密码一起回填。
    dismissAuthModal();
    window.location.reload();
  } catch (error) {
    errorNode.textContent = "无法连接账户服务，请确认数据服务已启动";
  } finally {
    submit.disabled = false;
  }
}
async function logout() { await originalFetch(endpoint("/data/api/auth/logout"), { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY)}` } }); localStorage.removeItem(AUTH_TOKEN_KEY); currentUser = null; window.location.href = new URL("index.html", location.href).href; }
function updateAuthUi() {
  const actionNode = document.querySelector("#auth-action");
  const adminNode = document.querySelector("#auth-admin");
  if (!actionNode || !adminNode) return;
  actionNode.textContent = currentUser ? "登出" : "登录";
  adminNode.classList.toggle("hidden", !currentUser?.isAdmin);
}
async function ensureAuthenticated() {
  authUi();
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) {
    // 未登录：在页面加载阶段就把登录表单放进 DOM，浏览器才把它当作登录表单
    // 处理，之后保存的账号 + 密码才能一次点选回填。
    showAuthModal();
    return false;
  }
  const response = await originalFetch(endpoint("/data/api/auth/me"), { headers: { Authorization: `Bearer ${token}` } });
  if (response.ok) { currentUser = (await response.json()).user; authReady = true; updateAuthUi(); return true; }
  localStorage.removeItem(AUTH_TOKEN_KEY);
  showAuthModal();
  return false;
}
async function manageUsers() {
  if (!currentUser?.isAdmin || typeof window.openAccountsModal !== "function") return;
  window.openAccountsModal();
}
