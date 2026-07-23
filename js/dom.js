const views = {
  library: document.querySelector("#library-view"),
  workspace: document.querySelector("#workspace-view"),
  search: document.querySelector("#search-view"),
  chronicle: document.querySelector("#chronicle-view"),
};

const viewTitles = {
  library: "文献库",
  workspace: "整理工作台",
  search: "全文检索",
  chronicle: "史事编年",
};

const form = document.querySelector("#document-form");
const documentList = document.querySelector("#document-list");
const documentCount = document.querySelector("#document-count");
const detailNode = document.querySelector("#document-detail");
const selectedStatus = document.querySelector("#selected-status");
const selectedPageStatus = document.querySelector("#selected-page-status");
const originalPageStatus = document.querySelector("#original-page-status");
const pageCount = document.querySelector("#page-count");
const pageList = document.querySelector("#page-list");
const pageNumberInput = document.querySelector("#page-number-input");
const pageImageInput = document.querySelector("#page-image-input");
const originalPreview = document.querySelector("#original-preview");
const recognizeStatus = document.querySelector("#recognize-status");
const offlineActions = document.querySelector("#offline-actions");
const offlineStatus = document.querySelector("#offline-status");
const ocrRawText = document.querySelector("#ocr-raw-text");
const cleanText = document.querySelector("#clean-text");
const punctuatedText = document.querySelector("#punctuated-text");
const pageNotes = document.querySelector("#page-notes");
const searchInput = document.querySelector("#search-input");
const searchResults = document.querySelector("#search-results");
const chronicleTopic = document.querySelector("#chronicle-topic");
const chronicleResults = document.querySelector("#chronicle-results");
const cardTemplate = document.querySelector("#document-card-template");
const ocrServiceStatus = document.querySelector("#ocr-service-status");
