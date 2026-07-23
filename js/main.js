persist();

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const file = formData.get("file");

  if (!file || !file.name) {
    return;
  }

  const firstPage = createPage(1);
  const item = {
    id: newId(),
    title: textValue("title") || file.name,
    author: textValue("author"),
    year: textValue("year"),
    publisher: textValue("publisher"),
    rights: textValue("rights"),
    source: textValue("source"),
    tags: textValue("tags"),
    fileName: file.name,
    fileType: file.type || "unknown",
    fileSize: file.size,
    processMode: formData.get("processMode") || "online",
    offlineTask: null,
    createdAt: new Date().toISOString(),
    status: "待整理",
    pages: [firstPage],
  };

  documents.unshift(item);
  selectedDocumentId = item.id;
  selectedPageId = firstPage.id;

  if (item.processMode === "offline") {
    item.offlineTask = createOfflineTask(file);
    item.status = "提交整本处理中";
    persist();
    form.reset();
    renderAll();
    setView("workspace");
    submitOfflineTask(item, file);
    return;
  }

  if (file.type.startsWith("image/")) {
    readImageFile(file, (image) => {
      firstPage.imageDataUrl = image.dataUrl;
      firstPage.imageName = file.name;
      firstPage.updatedAt = new Date().toISOString();
      persist();
      form.reset();
      renderAll();
      setView("workspace");
    });
    return;
  }

  persist();
  form.reset();
  renderAll();
  setView("workspace");
});

document.querySelector("#add-page").addEventListener("click", () => {
  const item = getSelectedDocument();
  if (!item) {
    return;
  }

  const pageNumber = Math.max(1, Number(pageNumberInput.value) || nextPageNumber(item));
  let page = item.pages.find((entry) => entry.pageNumber === pageNumber);

  if (!page) {
    page = createPage(pageNumber);
    item.pages.push(page);
    item.pages.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  selectedPageId = page.id;
  item.status = summarizeDocumentStatus(item);
  item.updatedAt = new Date().toISOString();
  persist();
  renderAll();
});

document.querySelector("#save-ocr").addEventListener("click", () => {
  if (saveCurrentPage()) {
    renderAll();
  }
});

document.querySelector("#mark-reviewed").addEventListener("click", () => {
  if (saveCurrentPage("待核对")) {
    renderAll();
  }
});

document.querySelector("#prev-page").addEventListener("click", () => {
  saveCurrentPage();
  moveToAdjacentPage(-1);
});

document.querySelector("#next-page").addEventListener("click", () => {
  saveCurrentPage();
  moveToAdjacentPage(1);
});

document.querySelector("#save-next").addEventListener("click", () => {
  const item = getSelectedDocument();

  if (!item || !saveCurrentPage()) {
    return;
  }

  moveToAdjacentPage(1, { createIfMissing: true });
});

pageImageInput.addEventListener("change", () => {
  const item = getSelectedDocument();
  const page = getSelectedPage();
  const file = pageImageInput.files[0];

  if (!item || !page || !file) {
    return;
  }

  readImageFile(file, (image) => {
    page.imageDataUrl = image.dataUrl;
    page.imageName = file.name;
    page.updatedAt = new Date().toISOString();
    item.updatedAt = new Date().toISOString();
    persist();
    pageImageInput.value = "";
    renderAll();
  });
});

document.querySelector("#recognize-page").addEventListener("click", recognizeCurrentPage);
document.querySelector("#refresh-offline").addEventListener("click", refreshOfflineTask);
document.querySelector("#search-button").addEventListener("click", runSearch);
document.querySelector("#build-chronicle").addEventListener("click", buildChronicle);
document.querySelector("#export-json").addEventListener("click", exportDataBackup);
document.querySelector("#export-pdf").addEventListener("click", exportPdf);

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    runSearch();
  }
});

chronicleTopic.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    buildChronicle();
  }
});

function textValue(name) {
  return form.elements[name].value.trim();
}

renderAll();
refreshOcrServiceStatus();
setInterval(refreshOcrServiceStatus, 10000);
