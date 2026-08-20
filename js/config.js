const STORAGE_KEY = "modernMilitaryHistory.documents.v2";
const LEGACY_STORAGE_KEY = "modernMilitaryHistory.documents.v1";
const FONT_STORAGE_KEY = "modernMilitaryHistory.font.v1";
const HISTORY_BASE = "/history";

function endpoint(proxiedPath) {
  return `${HISTORY_BASE}/api${proxiedPath}`;
}

const OCR_SERVICE_URL = endpoint("/ocr/ocr");
const OCR_COVER_SERVICE_URL = endpoint("/ocr/ocr/cover-candidate");
const OCR_BATCH_SERVICE_URL = endpoint("/ocr/ocr/batch");
const OCR_HEALTH_URL = endpoint("/ocr/health");
const DATA_BOOTSTRAP_URL = endpoint("/data/api/bootstrap");
const DATA_SYNC_URL = endpoint("/data/api/sync");
const DATA_PUSH_URL = endpoint("/data/api/sync/push");
const LLM_SERVICE_URL = endpoint("/llm/llm");
const LLM_HEALTH_URL = endpoint("/llm/health");
const VERSION_STATUS_URL = endpoint("/version/version");
const VERSION_UPDATE_URL = endpoint("/version/update");
