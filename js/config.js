const STORAGE_KEY = "modernMilitaryHistory.documents.v2";
const LEGACY_STORAGE_KEY = "modernMilitaryHistory.documents.v1";
const FONT_STORAGE_KEY = "modernMilitaryHistory.font.v1";

// 子路径基址：生产环境部署在 /history 下时走 nginx 代理；
// 本地开发（直接 python -m http.server）则继续直连 127.0.0.1。
const HISTORY_BASE = (window.__HISTORY_BASE__ ||
  (location.pathname.startsWith("/history") ? "/history" : "")
).replace(/\/+$/, "");

function endpoint(localUrl, proxiedPath) {
  return HISTORY_BASE ? `${HISTORY_BASE}/api${proxiedPath}` : localUrl;
}

const OCR_SERVICE_URL = endpoint("http://127.0.0.1:8765/ocr", "/ocr/ocr");
const OCR_COVER_SERVICE_URL = endpoint("http://127.0.0.1:8765/ocr/cover-candidate", "/ocr/ocr/cover-candidate");
const OCR_BATCH_SERVICE_URL = endpoint("http://127.0.0.1:8765/ocr/batch", "/ocr/ocr/batch");
const OCR_HEALTH_URL = endpoint("http://127.0.0.1:8765/health", "/ocr/health");
const DATA_BOOTSTRAP_URL = endpoint("http://127.0.0.1:8665/api/bootstrap", "/data/api/bootstrap");
const DATA_SYNC_URL = endpoint("http://127.0.0.1:8665/api/sync", "/data/api/sync");
const DATA_PUSH_URL = endpoint("http://127.0.0.1:8665/api/sync/push", "/data/api/sync/push");
const LLM_SERVICE_URL = endpoint("http://127.0.0.1:8865/llm", "/llm/llm");
const LLM_HEALTH_URL = endpoint("http://127.0.0.1:8865/health", "/llm/health");
const VERSION_STATUS_URL = endpoint("http://127.0.0.1:8965/version", "/version/version");
const VERSION_UPDATE_URL = endpoint("http://127.0.0.1:8965/update", "/version/update");
