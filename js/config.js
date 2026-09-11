// —— 站点识别：按 URL 首段区分已发布子站（/history、/literature…）——
// 同一份静态代码可同时服务多个子站；/history 下所有行为与旧版完全一致。
const SITE_PATH_SEGMENT = (location.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
const SITE_ID = SITE_PATH_SEGMENT && SITE_PATH_SEGMENT !== "html" ? SITE_PATH_SEGMENT : "history";
const HISTORY_BASE = `/${SITE_ID}`;

// 各子站品牌名（首页大标题 / 页面 <title> 后缀 / PDF 导出署名）
const SITE_TITLES = {
  history: "近代军史数智平台",
  literature: "文献库",
};
const SITE_TITLE = SITE_TITLES[SITE_ID] || SITE_ID;

// localStorage 按站点隔离（/history 沿用旧前缀，既有用户数据不变）
const SITE_STORAGE_PREFIX = SITE_ID === "history" ? "modernMilitaryHistory" : `wenqu.${SITE_ID}`;

const STORAGE_KEY = `${SITE_STORAGE_PREFIX}.documents.schema4`;
const FONT_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.font.schema4`;
const DATA_SCHEMA_VERSION = 6;

function endpoint(proxiedPath) {
  return `${HISTORY_BASE}/api${proxiedPath}`;
}

const OCR_SERVICE_URL = endpoint("/ocr/ocr");
const OCR_COVER_SERVICE_URL = endpoint("/ocr/ocr/cover-candidate");
const OCR_STREAM_SERVICE_URL = endpoint("/ocr/ocr/stream");
const OCR_HEALTH_URL = endpoint("/ocr/health");
const DATA_BOOTSTRAP_URL = endpoint("/data/api/bootstrap");
const DATA_SYNC_URL = endpoint("/data/api/sync");
const DATA_PUSH_URL = endpoint("/data/api/sync/push");
const DATA_FILE_UPLOAD_URL = endpoint("/data/api/files/upload");
const DOCUMENT_ANNOTATION_API_URL = endpoint("/data/api/documents");
const CONVERSATION_FILE_UPLOAD_URL = endpoint("/data/api/conversation-files/upload");
const CONVERSATION_FILE_API_URL = endpoint("/data/api/conversation-files");
const LLM_SERVICE_URL = endpoint("/llm/llm");
const LLM_HEALTH_URL = endpoint("/llm/health");
const VERSION_STATUS_URL = endpoint("/version/version");
const VERSION_UPDATE_URL = endpoint("/version/update");

// —— 运行时品牌（config.js 在各页 body 末尾最先加载，可安全访问上方 DOM）——
// 首页“大标题”元素用 id="home-site-title" 标记，随站点显示对应名称；
// 非 /history 子站的页面 <title> 中旧品牌名自动替换为当前站点名。
const homeSiteTitle = document.getElementById("home-site-title");
if (homeSiteTitle) {
  homeSiteTitle.textContent = SITE_TITLE;
}
if (SITE_ID !== "history") {
  let nextTitle = document.title.replace(/近代军史数智平台/g, SITE_TITLE);
  if (nextTitle === `${SITE_TITLE} · ${SITE_TITLE}`) {
    nextTitle = SITE_TITLE;
  }
  document.title = nextTitle;
}

// —— 平台更新广播：任一页面执行「更新」发布后，全平台已打开的页面一起强制刷新 ——
// 机制：发布页写入 localStorage 信号，其它页通过 storage 事件立即刷新；标签页重新可见/
// 获得焦点时再比对一次信号，避免后台标签页错过事件。sessionStorage 记录本页已处理的信号，
// 防止刷新后循环触发。（信号按域名共享，故 /history 与 /literature 会同时刷新。）
const PLATFORM_RELOAD_KEY = "wenqu.platform.reload";
const PLATFORM_RELOAD_ACK_KEY = "wenqu.platform.reload.acked";

function acknowledgedReloadSignal() {
  try {
    return sessionStorage.getItem(PLATFORM_RELOAD_ACK_KEY);
  } catch (_) {
    return null;
  }
}

function acknowledgeReloadSignal(signal) {
  try {
    sessionStorage.setItem(PLATFORM_RELOAD_ACK_KEY, signal);
  } catch (_) {
    /* 隐私模式等存储不可用时忽略 */
  }
}

function applyPlatformReloadSignal(force = false) {
  let signal = null;
  try {
    signal = localStorage.getItem(PLATFORM_RELOAD_KEY);
  } catch (_) {
    return;
  }
  if (!signal) {
    return;
  }
  if (!force && acknowledgedReloadSignal() === signal) {
    return;
  }
  acknowledgeReloadSignal(signal);
  window.location.reload();
}

// 发布完成后调用：标记本页已处理，并通知其它页面刷新
function broadcastPlatformReload() {
  const signal = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  acknowledgeReloadSignal(signal);
  try {
    localStorage.setItem(PLATFORM_RELOAD_KEY, signal);
  } catch (_) {
    /* 存储不可用时仅本页刷新 */
  }
  return signal;
}

window.addEventListener("storage", (event) => {
  if (event.key === PLATFORM_RELOAD_KEY) {
    applyPlatformReloadSignal(true);
  }
});
window.addEventListener("focus", () => applyPlatformReloadSignal());
window.addEventListener("pageshow", () => applyPlatformReloadSignal());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    applyPlatformReloadSignal();
  }
});
