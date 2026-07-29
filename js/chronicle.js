function buildChronicleByRegex() {
  const topic = chronicleTopic.value.trim();
  const entries = collectChronicleEntries(topic);
  chronicleResults.innerHTML = "";
  chronicleResults.classList.remove("empty-result-list");

  if (!entries.length) {
    const empty = emptyState("未找到可生成编年的日期条目。");
    empty.classList.add("result-empty");
    chronicleResults.classList.add("empty-result-list");
    chronicleResults.append(empty);
    return;
  }

  entries
    .sort((a, b) => a.sortKey - b.sortKey || a.pageNumber - b.pageNumber)
    .forEach((entry, index, list) => {
      const result = document.createElement("article");
      const content = document.createElement("div");
      const title = document.createElement("h4");
      const summary = document.createElement("p");
      const source = document.createElement("p");
      const action = document.createElement("button");
      const sameDay = index > 0 && entry.dateLabel === list[index - 1].dateLabel;

      result.className = "result-item";
      title.textContent = sameDay ? `同日：${entry.dateLabel}` : entry.dateLabel;
      summary.textContent = entry.sentence;
      source.textContent = `来源：${formatSource(entry.document)}，第 ${entry.pageNumber} 页。`;
      action.className = "secondary-button";
      action.type = "button";
      action.textContent = "查看原页";
      action.addEventListener("click", () => {
        selectedDocumentId = entry.document.id;
        selectedPageId = entry.pageId;
        renderAll();
        setView("workspace");
      });

      content.append(title, summary, source);
      result.append(content, action);
      chronicleResults.append(result);
    });
}

function collectChronicleEntries(topic) {
  const entries = [];

  documents.forEach((item) => {
    item.pages.forEach((page) => {
      splitSentences(getPagePrimaryText(page)).forEach((sentence) => {
        if (topic && !matchesTopic(item, page, sentence, topic)) {
          return;
        }

        const date = parseHistoricalDate(sentence);
        if (!date) {
          return;
        }

        entries.push({
          document: item,
          pageId: page.id,
          pageNumber: page.pageNumber,
          sentence,
          dateLabel: date.label,
          sortKey: date.sortKey,
        });
      });
    });
  });

  return entries;
}

function splitSentences(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？；;])/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

function matchesTopic(item, page, sentence, topic) {
  const haystack = [
    item.title,
    item.author,
    item.publisher,
    item.source,
    item.tags,
    page.notes,
    sentence,
  ].join("\n");

  return haystack.toLowerCase().includes(topic.toLowerCase());
}

function parseHistoricalDate(sentence) {
  const fullDate = sentence.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})[日号]/);
  if (fullDate) {
    const year = Number(fullDate[1]);
    const month = Number(fullDate[2]);
    const day = Number(fullDate[3]);
    return {
      label: `${year}年${month}月${day}日（农历待核）`,
      sortKey: year * 10000 + month * 100 + day,
    };
  }

  const minguoDate = sentence.match(/民国\s*(\d{1,2})年\s*(\d{1,2})月\s*(\d{1,2})[日号]/);
  if (minguoDate) {
    const year = Number(minguoDate[1]) + 1911;
    const month = Number(minguoDate[2]);
    const day = Number(minguoDate[3]);
    return {
      label: `${year}年${month}月${day}日（原文作民国${minguoDate[1]}年${month}月${day}日；农历待核）`,
      sortKey: year * 10000 + month * 100 + day,
    };
  }

  const yearOnly = sentence.match(/(\d{4})年/);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    return {
      label: `${year}年（月日待核；农历待核）`,
      sortKey: year * 10000,
    };
  }

  return null;
}

function formatSource(item) {
  const author = item.author || "著者未录";
  const title = item.title || "文献名未录";
  const publisher = item.publisher || "出版信息未录";
  const year = item.year || "年份未录";
  const rights = item.rights ? `，${item.rights}` : "";
  return `${author}：《${title}》，${publisher}${rights}，${year}`;
}

async function buildChronicle() {
  const topic = chronicleTopic.value.trim();
  const chronicleDocuments = collectChronicleDocumentsForLlm(topic);
  chronicleResults.innerHTML = "";
  chronicleResults.classList.remove("empty-result-list");

  if (!chronicleDocuments.length) {
    renderChronicleNotice("暂无可用于生成编年的整理文本。");
    return;
  }

  if (!isLlmServiceConnected()) {
    renderChronicleNotice("未连接大模型，无法生成复杂纪年编排。");
    return;
  }

  renderChronicleLoading();

  try {
    const result = await requestLlmTask("/chronicle", {
      topic,
      events: [],
      documents: chronicleDocuments,
      options: {
        source: "document-pages",
        maxEntries: 40,
        totalPageCount: countChroniclePagesForLlm(),
      },
    });

    if (!result.ready) {
      renderChronicleNotice(result.message || "大模型服务未连接。");
      return;
    }

    renderChronicleLlmEntries(result.entries || [], result.warnings || []);
  } catch (error) {
    renderChronicleNotice("暂时无法调用大模型生成编年。");
  }
}

function collectChronicleDocumentsForLlm(topic) {
  const records = [];

  documents.forEach((item, documentIndex) => {
    item.pages.forEach((page, pageIndex) => {
      const text = getPagePrimaryText(page).trim();
      if (!text) {
        return;
      }

      records.push({
        item,
        page,
        documentIndex,
        pageIndex,
        score: scoreChroniclePageForLlm(item, page, text, topic),
      });
    });
  });

  const grouped = new Map();
  records
    .sort((a, b) => b.score - a.score || a.documentIndex - b.documentIndex || a.pageIndex - b.pageIndex)
    .slice(0, 36)
    .forEach(({ item, page }) => {
      if (!grouped.has(item.id)) {
        grouped.set(item.id, {
          documentId: item.id,
          title: getDocumentDisplayTitle(item),
          author: item.author || "",
          year: item.year || "",
          publisher: item.publisher || "",
          rights: item.rights || "",
          source: item.source || "",
          tags: item.tags || "",
          pages: [],
        });
      }

      grouped.get(item.id).pages.push({
        pageId: page.id,
        pageNumber: page.pageNumber,
        text: getPagePrimaryText(page).slice(0, 1800),
        notes: (page.notes || "").slice(0, 500),
      });
    });

  return Array.from(grouped.values());
}

function scoreChroniclePageForLlm(item, page, text, topic) {
  if (!topic) {
    return 1;
  }

  const normalizedTopic = topic.toLowerCase();
  const haystack = [
    item.title,
    item.author,
    item.publisher,
    item.source,
    item.tags,
    page.notes,
    text,
  ].join("\n").toLowerCase();

  return haystack.includes(normalizedTopic) ? 3 : 1;
}

function countChroniclePagesForLlm() {
  return documents.reduce((total, item) => {
    return total + item.pages.filter((page) => getPagePrimaryText(page).trim()).length;
  }, 0);
}

function renderChronicleLoading() {
  const loading = emptyState("正在调用大模型生成编年...");
  loading.classList.add("result-empty");
  chronicleResults.classList.add("empty-result-list");
  chronicleResults.append(loading);
}

function renderChronicleNotice(message) {
  chronicleResults.innerHTML = "";
  chronicleResults.classList.add("empty-result-list");
  const empty = emptyState(message);
  empty.classList.add("result-empty");
  chronicleResults.append(empty);
}

function renderChronicleLlmEntries(entries, warnings = []) {
  chronicleResults.innerHTML = "";
  chronicleResults.classList.remove("empty-result-list");

  if (!entries.length) {
    renderChronicleNotice("未找到可生成编年的日期条目。");
    return;
  }

  entries.forEach((entry, index, list) => {
    const result = document.createElement("article");
    const content = document.createElement("div");
    const title = document.createElement("h4");
    const summary = document.createElement("p");
    const source = document.createElement("p");
    const action = document.createElement("button");
    const dateLabel = getChronicleDateLabel(entry);
    const sameDay = Boolean(entry.sameDay) || (index > 0 && dateLabel === getChronicleDateLabel(list[index - 1]));
    const sourceTarget = resolveChronicleSource(entry);

    result.className = "result-item";
    title.textContent = sameDay ? `同日：${dateLabel}` : dateLabel;
    summary.textContent = entry.summary || entry.event || "史事待核";
    source.textContent = formatChronicleLlmSources(entry.sources);
    action.className = "secondary-button";
    action.type = "button";
    action.textContent = "查看原页";
    action.disabled = !sourceTarget;
    action.addEventListener("click", () => {
      if (!sourceTarget) {
        return;
      }

      selectedDocumentId = sourceTarget.documentId;
      selectedPageId = sourceTarget.pageId;
      renderAll();
      setView("workspace");
    });

    content.append(title, summary, source);
    if (Array.isArray(warnings) && warnings.length && index === entries.length - 1) {
      content.append(formatChronicleWarnings(warnings));
    }
    result.append(content, action);
    chronicleResults.append(result);
  });
}

function getChronicleDateLabel(entry) {
  return entry?.dateLabel || entry?.dateGregorian || entry?.dateOriginal || "日期待核";
}

function formatChronicleLlmSources(sources = []) {
  if (!Array.isArray(sources) || !sources.length) {
    return "来源：待核。";
  }

  return sources
    .map((source) => {
      const author = source.author || "著者未录";
      const title = source.title || "文献名未录";
      const publisher = source.publisher || "出版信息未录";
      const year = source.year || "年份未录";
      const pageNumber = source.pageNumber ? `，第 ${source.pageNumber} 页` : "";
      const quote = source.quote ? `；原文：${source.quote}` : "";
      return `来源：${author}：《${title}》，${publisher}，${year}${pageNumber}${quote}`;
    })
    .join("\n");
}

function formatChronicleWarnings(warnings) {
  const node = document.createElement("p");
  node.className = "meta-line";
  node.textContent = `提示：${warnings.join("；")}`;
  return node;
}

function resolveChronicleSource(entry) {
  const sources = Array.isArray(entry.sources) ? entry.sources : [];

  for (const source of sources) {
    const item = source.documentId
      ? documents.find((documentItem) => documentItem.id === source.documentId)
      : documents.find((documentItem) => {
          return getDocumentDisplayTitle(documentItem) === source.title || documentItem.title === source.title;
        });

    if (!item) {
      continue;
    }

    const page = source.pageId
      ? item.pages.find((pageItem) => pageItem.id === source.pageId)
      : item.pages.find((pageItem) => pageItem.pageNumber === Number(source.pageNumber));

    if (page) {
      return {
        documentId: item.id,
        pageId: page.id,
      };
    }
  }

  return null;
}
