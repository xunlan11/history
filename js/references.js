let pendingReferenceDocumentIds = new Set();

function ensureReferenceConversation() {
  return getSelectedConversation() || createConversation("新对话", selectedSmartMode || "chat");
}

function isReferenceScopeActive(conversation = getSelectedConversation()) {
  return getConversationReferenceDocumentIds(conversation).length > 0;
}

function getSmartScopeDocuments(conversation = getSelectedConversation()) {
  const referenceIds = getConversationReferenceDocumentIds(conversation);
  if (!referenceIds.length) {
    return documents;
  }

  const referenceIdSet = new Set(referenceIds);
  return documents.filter((item) => referenceIdSet.has(item.id));
}

function getSmartPagePrimaryText(page, conversation = getSelectedConversation()) {
  return isReferenceScopeActive(conversation)
    ? getPageProcessedText(page)
    : getPagePrimaryText(page);
}

function getSmartPageSearchText(page, conversation = getSelectedConversation()) {
  return isReferenceScopeActive(conversation)
    ? getPageProcessedSearchText(page)
    : getPageSearchText(page);
}

function getReferenceScopeReport(conversation = getSelectedConversation()) {
  const referenceIds = getConversationReferenceDocumentIds(conversation);
  if (!referenceIds.length) {
    return {
      active: false,
      documents,
      usableDocuments: documents,
      warnings: [],
      error: "",
    };
  }

  const documentsById = new Map(documents.map((item) => [item.id, item]));
  const selectedDocuments = referenceIds.map((id) => documentsById.get(id)).filter(Boolean);
  const missingCount = referenceIds.length - selectedDocuments.length;
  const usableDocuments = selectedDocuments.filter((item) => {
    return item.pages.some((page) => getPageProcessedText(page).trim());
  });
  const emptyDocuments = selectedDocuments.filter((item) => {
    return !item.pages.some((page) => getPageProcessedText(page).trim());
  });
  const partialDocuments = usableDocuments.filter((item) => {
    const task = item.processingTask;
    const expectedPages = Number(task?.totalPages) || item.pages.length;
    const processedPages = item.pages.filter((page) => getPageProcessedText(page).trim()).length;
    return Boolean(task && processedPages < expectedPages);
  });
  const warnings = [];

  if (missingCount) {
    warnings.push(`${missingCount} 篇已选文献已不存在`);
  }
  if (emptyDocuments.length) {
    warnings.push(`${emptyDocuments.map(getDocumentDisplayTitle).join("、")}暂无处理后文本`);
  }
  if (partialDocuments.length) {
    warnings.push(`${partialDocuments.map(getDocumentDisplayTitle).join("、")}仍在处理，将只使用已完成页面`);
  }

  return {
    active: true,
    documents: selectedDocuments,
    usableDocuments,
    warnings,
    error: usableDocuments.length ? "" : "所选文献暂无可用的处理后文本，请等待处理完成或重新选择。",
  };
}

function openReferenceDocumentDialog() {
  if (!referenceDocumentDialog) {
    return;
  }

  pendingReferenceDocumentIds = new Set(getConversationReferenceDocumentIds());
  referenceDocumentSearch.value = "";
  renderReferenceDocumentOptions();
  referenceDocumentDialog.classList.remove("hidden");
  referenceDocumentSearch.focus();
}

function closeReferenceDocumentDialog() {
  referenceDocumentDialog?.classList.add("hidden");
  pendingReferenceDocumentIds = new Set();
}

function confirmReferenceDocuments() {
  const conversation = ensureReferenceConversation();
  setConversationReferenceDocumentIds(Array.from(pendingReferenceDocumentIds), conversation);
  closeReferenceDocumentDialog();
  renderReferenceDocuments();
  renderConversationList();
}

function renderReferenceDocuments() {
  if (!referenceDocumentChips || !referenceDocumentCount || !referenceScopeStatus) {
    return;
  }

  const conversation = getSelectedConversation();
  const referenceIds = getConversationReferenceDocumentIds(conversation);
  const documentsById = new Map(documents.map((item) => [item.id, item]));
  referenceDocumentChips.innerHTML = "";

  referenceIds.forEach((id) => {
    const item = documentsById.get(id);
    const chip = document.createElement("span");
    const label = document.createElement("span");
    const remove = document.createElement("button");

    chip.className = "reference-chip";
    chip.classList.toggle("reference-chip-warning", !item);
    label.textContent = item ? getDocumentDisplayTitle(item) : "文献已不存在";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `移除${label.textContent}`;
    remove.setAttribute("aria-label", `移除参考文献：${label.textContent}`);
    remove.addEventListener("click", () => {
      setConversationReferenceDocumentIds(referenceIds.filter((value) => value !== id), conversation);
      renderReferenceDocuments();
      renderConversationList();
    });
    chip.append(label, remove);
    referenceDocumentChips.append(chip);
  });

  referenceDocumentCount.textContent = String(referenceIds.length);
  referenceDocumentCount.classList.toggle("hidden", !referenceIds.length);

  const report = getReferenceScopeReport(conversation);
  if (!report.active) {
    referenceScopeStatus.textContent = "";
    referenceScopeStatus.classList.add("hidden");
    referenceScopeStatus.classList.remove("reference-scope-warning");
    return;
  }

  const base = `后续请求仅使用所选 ${referenceIds.length} 篇文献的处理后数据。`;
  referenceScopeStatus.textContent = report.warnings.length
    ? `${base}${report.warnings.join("；")}。`
    : base;
  referenceScopeStatus.classList.remove("hidden");
  referenceScopeStatus.classList.toggle("reference-scope-warning", Boolean(report.warnings.length));
}

function renderReferenceDocumentOptions() {
  if (!referenceDocumentList || !referenceSelectionSummary) {
    return;
  }

  const query = (referenceDocumentSearch?.value || "").trim().toLowerCase();
  const matchedDocuments = documents.filter((item) => {
    const haystack = [item.title, item.author, item.year, item.tags, item.fileName]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return !query || haystack.includes(query);
  });
  referenceDocumentList.innerHTML = "";

  if (!matchedDocuments.length) {
    const empty = document.createElement("p");
    empty.className = "reference-document-empty";
    empty.textContent = documents.length ? "没有匹配的文献" : "文献库为空，请先登记并处理文献";
    referenceDocumentList.append(empty);
  }

  matchedDocuments.forEach((item) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const body = document.createElement("span");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const processedCount = item.pages.filter((page) => getPageProcessedText(page).trim()).length;

    label.className = "reference-document-option";
    checkbox.type = "checkbox";
    checkbox.checked = pendingReferenceDocumentIds.has(item.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        pendingReferenceDocumentIds.add(item.id);
      } else {
        pendingReferenceDocumentIds.delete(item.id);
      }
      updateReferenceSelectionSummary();
    });
    title.textContent = getDocumentDisplayTitle(item);
    meta.textContent = [
      item.author || "著者未录",
      item.year || "年份未录",
      `处理后文本 ${processedCount}/${item.pages.length} 页`,
    ].join(" · ");
    body.append(title, meta);
    label.append(checkbox, body);
    referenceDocumentList.append(label);
  });

  updateReferenceSelectionSummary();
}

function updateReferenceSelectionSummary() {
  if (!referenceSelectionSummary) {
    return;
  }
  const count = pendingReferenceDocumentIds.size;
  referenceSelectionSummary.textContent = count ? `已选择 ${count} 篇文献` : "未选择文献，将使用整个文献库";
}

openReferenceDocumentsButton?.addEventListener("click", openReferenceDocumentDialog);
closeReferenceDocumentsButton?.addEventListener("click", closeReferenceDocumentDialog);
cancelReferenceDocumentsButton?.addEventListener("click", closeReferenceDocumentDialog);
confirmReferenceDocumentsButton?.addEventListener("click", confirmReferenceDocuments);
referenceDocumentSearch?.addEventListener("input", renderReferenceDocumentOptions);
referenceDocumentDialog?.addEventListener("click", (event) => {
  if (event.target === referenceDocumentDialog) {
    closeReferenceDocumentDialog();
  }
});
