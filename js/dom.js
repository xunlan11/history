const views = {
  library: document.querySelector("#library-view"),
  workspace: document.querySelector("#workspace-view"),
};

const viewTitles = {
  library: "书库",
  workspace: "整理工作台",
};

const form = document.querySelector("#document-form");
const formSheet = document.querySelector("#document-form-sheet");
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
const llmTaskStatus = document.querySelector("#llm-task-status");
const searchInput = document.querySelector("#search-input");
const searchResults = document.querySelector("#search-results");
const chronicleTopic = document.querySelector("#chronicle-topic");
const chronicleResults = document.querySelector("#chronicle-results");
const cardTemplate = document.querySelector("#document-card-template");
const ocrServiceStatus = document.querySelector("#ocr-service-status");
const llmServiceStatus = document.querySelector("#llm-service-status");
const smartDock = document.querySelector("#smart-dock");
const conversationList = document.querySelector("#conversation-list");
const newConversationButton = document.querySelector("#new-conversation");
const chatTitle = document.querySelector("#chat-title");
const chatHint = document.querySelector("#chat-hint");
const messageFeed = document.querySelector("#message-feed");
const deleteConversationDialog = document.querySelector("#delete-conversation-dialog");
const deleteConversationMessage = document.querySelector("#delete-conversation-message");
const cancelDeleteConversation = document.querySelector("#cancel-delete-conversation");
const confirmDeleteConversation = document.querySelector("#confirm-delete-conversation");
