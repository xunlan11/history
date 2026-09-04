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
const DATA_SCHEMA_VERSION = 4;

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
