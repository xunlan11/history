const READER_PANEL_STATE_STORAGE_KEY = `${SITE_STORAGE_PREFIX}.readerPanels`;

function loadReaderPanelState() {
  try {
    const value = JSON.parse(localStorage.getItem(READER_PANEL_STATE_STORAGE_KEY)) || {};
    return {
      originalCollapsed: value.originalCollapsed === true,
      annotationCollapsed: value.annotationCollapsed === true,
    };
  } catch {
    return { originalCollapsed: false, annotationCollapsed: false };
  }
}

let readerPanelState = loadReaderPanelState();

function applyReaderPanelState() {
  const { originalCollapsed, annotationCollapsed } = readerPanelState;
  readerCompare?.classList.toggle("is-original-collapsed", originalCollapsed);
  readerCompare?.classList.toggle("is-annotation-collapsed", annotationCollapsed);
  readerOriginalPanel?.classList.toggle("reader-panel-collapsed", originalCollapsed);
  readerAnnotationPanel?.classList.toggle("reader-panel-collapsed", annotationCollapsed);

  if (readerOriginalToggle) {
    readerOriginalToggle.setAttribute("aria-expanded", String(!originalCollapsed));
    readerOriginalToggle.setAttribute("aria-label", originalCollapsed ? "展开原始资料" : "折叠原始资料");
    readerOriginalToggle.title = originalCollapsed ? "展开原始资料" : "折叠原始资料";
  }
  if (readerAnnotationToggle) {
    readerAnnotationToggle.setAttribute("aria-expanded", String(!annotationCollapsed));
    readerAnnotationToggle.setAttribute("aria-label", annotationCollapsed ? "展开笺注" : "折叠笺注");
    readerAnnotationToggle.title = annotationCollapsed ? "展开笺注" : "折叠笺注";
  }
}

function toggleReaderPanel(panel) {
  if (panel === "original") {
    readerPanelState.originalCollapsed = !readerPanelState.originalCollapsed;
  } else if (panel === "annotation") {
    readerPanelState.annotationCollapsed = !readerPanelState.annotationCollapsed;
  } else {
    return;
  }
  localStorage.setItem(READER_PANEL_STATE_STORAGE_KEY, JSON.stringify(readerPanelState));
  applyReaderPanelState();
}

readerOriginalToggle?.addEventListener("click", () => toggleReaderPanel("original"));
readerAnnotationToggle?.addEventListener("click", () => toggleReaderPanel("annotation"));
applyReaderPanelState();
