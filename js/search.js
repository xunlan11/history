function runSearch() {
  const query = searchInput.value.trim();
  searchResults.innerHTML = "";

  if (!query) {
    renderSearchEmpty();
    return;
  }

  const results = documents.flatMap((item) => buildSearchEntries(item, query));

  if (!results.length) {
    searchResults.append(emptyState("未找到匹配内容"));
    return;
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
      renderAll();
      setView("workspace");
    });

    content.append(title, meta, excerpt);
    result.append(content, action);
    searchResults.append(result);
  });
}

function buildSearchEntries(item, query) {
  const entries = [];
  const metadata = [
    item.title,
    item.author,
    item.year,
    item.publisher,
    item.rights,
    item.source,
    item.tags,
    item.fileName,
  ].join("\n");
  const metadataSnippet = buildSnippet(metadata, query);

  if (metadataSnippet) {
    entries.push({ item, page: null, snippet: metadataSnippet });
  }

  item.pages.forEach((page) => {
    const pageSnippet = buildSnippet([page.text, page.notes].join("\n"), query);
    if (pageSnippet) {
      entries.push({ item, page, snippet: pageSnippet });
    }
  });

  return entries;
}
