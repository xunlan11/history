const STORAGE_KEY = "modernMilitaryHistory.documents.schema4";
const FONT_STORAGE_KEY = "modernMilitaryHistory.font.schema4";
const DATA_SCHEMA_VERSION = 4;
const HISTORY_BASE = "/history";

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
