let searchRunToken = 0;

function runLiteralSearch(notice = "") {
  const query = searchInput.value.trim();
  searchResults.innerHTML = "";
  searchResults.classList.remove("empty-result-list");

  if (!query) {
    renderSearchEmpty();
    return;
  }

  const results = documents.flatMap((item) => buildSearchEntries(item, query));

  if (!results.length) {
    renderSearchNotice("未找到匹配内容");
    return;
  }

  if (notice) {
    const warning = document.createElement("p");
    warning.className = "meta-line";
    warning.textContent = notice;
    searchResults.append(warning);
  }

  results.forEach(({ item, page, snippet }) => {
    const result = document.createElement("article");
    result.className = "result-item";

    const content = document.createElement("div");
    const title = document.createElement("h4");
    const meta = document.createElement("p");
    const excerpt = document.createElement("p");
    const action = document.createElement("button");

    title.textContent = page ? `${item.title} · 第 ${page.pageNumber} 页` : item.title;
    meta.textContent = `${item.author || "著者未录"} · ${item.year || "年份未录"} · ${item.fileName}`;
    excerpt.innerHTML = highlight(snippet, query);
    action.className = "secondary-button";
    action.type = "button";
    action.textContent = "打开";
    action.addEventListener("click", () => {
      selectedDocumentId = item.id;
      selectedPageId = page?.id || item.pages[0]?.id || null;
      setReaderReturnView("library");
      renderAll();
      setView("reader");
    });

    content.append(title, meta, excerpt);
    result.append(content, action);
    searchResults.append(result);
  });
}

async function runSearch() {
  const query = searchInput.value.trim();
  const runToken = searchRunToken + 1;
  searchRunToken = runToken;
  searchResults.innerHTML = "";
  searchResults.classList.remove("empty-result-list");

  if (!query) {
    renderSearchEmpty();
    return;
  }

  if (!isLlmServiceConnected()) {
    runLiteralSearch("未连接大模型，已使用字面检索；异称、字号、别名可能无法召回。");
    return;
  }

  const searchDocuments = collectSearchDocumentsForLlm(query);
  if (!searchDocuments.length) {
    renderSearchNotice("暂无可用于检索的整理文本。");
    return;
  }

  renderSearchLoading();

  try {
    const result = await requestLlmTask("/search", {
      query,
      documents: searchDocuments,
      options: {
        source: "document-pages",
        maxMatches: 50,
        totalPageCount: countSearchPages(),
      },
    });

    if (runToken !== searchRunToken) {
      return;
    }

    if (!result.ready) {
      renderSearchNotice(result.message || "大模型服务未连接。");
      return;
    }

    renderLlmSearchResults(result.matches || [], result.warnings || [], query);
  } catch (error) {
    if (runToken !== searchRunToken) {
      return;
    }

    renderSearchNotice("暂时无法调用大模型检索。");
  }
}

function buildSearchEntries(item, query) {
  const entries = [];
  const metadata = [
    item.title,
    item.author,
    item.year,
    item.publisher,
    item.tags,
    item.fileName,
  ].join("\n");
  const metadataSnippet = buildSnippet(metadata, query);

  if (metadataSnippet) {
    entries.push({ item, page: null, snippet: metadataSnippet });
  }

  item.pages.forEach((page) => {
    const pageSnippet = buildSnippet(getPageSearchText(page), query);
    if (pageSnippet) {
      entries.push({ item, page, snippet: pageSnippet });
    }
  });

  return entries;
}

function collectSearchDocumentsForLlm(query) {
  const records = [];

  documents.forEach((item, documentIndex) => {
    const metadata = buildSearchMetadata(item);

    item.pages.forEach((page, pageIndex) => {
      const text = getPageSearchText(page).trim();
      if (!text) {
        return;
      }

      records.push({
        item,
        page,
        documentIndex,
        pageIndex,
        score: scoreSearchTextForLlm(`${metadata}\n${text}`, query),
      });
    });
  });

  const grouped = new Map();
  records
    .sort((a, b) => b.score - a.score || a.documentIndex - b.documentIndex || a.pageIndex - b.pageIndex)
    .forEach(({ item, page }) => {
      if (!grouped.has(item.id)) {
        grouped.set(item.id, {
          documentId: item.id,
          title: getDocumentDisplayTitle(item),
          author: item.author || "",
          year: item.year || "",
          publisher: item.publisher || "",
          tags: item.tags || "",
          fileName: item.fileName || "",
          pages: [],
        });
      }

      grouped.get(item.id).pages.push({
        pageId: page.id,
        pageNumber: page.pageNumber,
        text: getPageSearchText(page).slice(0, 1600),
        notes: (page.notes || "").slice(0, 400),
      });
    });

  return Array.from(grouped.values()).filter((item) => item.pages.length);
}

function buildSearchMetadata(item) {
  return [
    item.title,
    item.author,
    item.year,
    item.publisher,
    item.tags,
    item.fileName,
  ].filter(Boolean).join("\n");
}

function scoreSearchTextForLlm(text, query) {
  if (!query) {
    return 1;
  }

  const normalizedText = text.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/[\s,，、；;]+/)
    .map((term) => term.trim())
    .filter(Boolean);

  return terms.reduce((score, term) => {
    return score + (normalizedText.includes(term) ? 3 : 0);
  }, 1);
}

function countSearchPages() {
  return documents.reduce((total, item) => {
    return total + item.pages.filter((page) => getPageSearchText(page).trim()).length;
  }, 0);
}

function renderSearchLoading() {
  const loading = emptyState("正在调用大模型检索...");
  loading.classList.add("result-empty");
  searchResults.classList.add("empty-result-list");
  searchResults.append(loading);
}

function renderSearchNotice(message) {
  searchResults.innerHTML = "";
  searchResults.classList.add("empty-result-list");
  const empty = emptyState(message);
  empty.classList.add("result-empty");
  searchResults.append(empty);
}

function renderLlmSearchResults(matches, warnings = [], query = "") {
  searchResults.innerHTML = "";
  searchResults.classList.remove("empty-result-list");

  if (!matches.length) {
    renderSearchNotice("未找到匹配内容");
    return;
  }

  matches.forEach((match, index) => {
    const target = resolveSearchMatch(match);
    const item = target?.item || {};
    const page = target?.page || null;
    const result = document.createElement("article");
    const content = document.createElement("div");
    const title = document.createElement("h4");
    const meta = document.createElement("p");
    const excerpt = document.createElement("p");
    const reason = document.createElement("p");
    const action = document.createElement("button");

    result.className = "result-item";
    title.textContent = page
      ? `${getDocumentDisplayTitle(item)} · 第 ${page.pageNumber} 页`
      : match.title || "匹配结果";
    meta.textContent = [
      match.author || item.author || "著者未录",
      match.year || item.year || "年份未录",
      match.matchedAs ? `按“${match.matchedAs}”匹配` : "",
      match.matchType || "",
    ].filter(Boolean).join(" · ");
    excerpt.innerHTML = highlightIfLiteral(match.quote || match.snippet || match.summary || "", query);
    reason.textContent = match.reason ? `判断：${match.reason}` : "";
    reason.className = "meta-line";
    action.className = "secondary-button";
    action.type = "button";
    action.textContent = "打开";
    action.disabled = !target;
    action.addEventListener("click", () => {
      if (!target) {
        return;
      }

      selectedDocumentId = item.id;
      selectedPageId = page?.id || item.pages[0]?.id || null;
      setReaderReturnView("library");
      renderAll();
      setView("reader");
    });

    content.append(title, meta, excerpt);
    if (reason.textContent) {
      content.append(reason);
    }
    if (Array.isArray(warnings) && warnings.length && index === matches.length - 1) {
      content.append(formatSearchWarnings(warnings));
    }
    result.append(content, action);
    searchResults.append(result);
  });
}

function highlightIfLiteral(text, query) {
  if (!text) {
    return "";
  }

  return buildSnippet(text, query) ? highlight(text, query) : escapeHtml(text);
}

function formatSearchWarnings(warnings) {
  const node = document.createElement("p");
  node.className = "meta-line";
  node.textContent = `提示：${warnings.join("；")}`;
  return node;
}

function resolveSearchMatch(match) {
  const item = match.documentId
    ? documents.find((documentItem) => documentItem.id === match.documentId)
    : documents.find((documentItem) => {
        return getDocumentDisplayTitle(documentItem) === match.title || documentItem.title === match.title;
      });

  if (!item) {
    return null;
  }

  const page = match.pageId
    ? item.pages.find((pageItem) => pageItem.id === match.pageId)
    : item.pages.find((pageItem) => pageItem.pageNumber === Number(match.pageNumber));

  return {
    item,
    page: page || null,
  };
}
