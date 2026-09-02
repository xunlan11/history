async function buildChronicle() {
  const topic = chronicleTopic.value.trim();
  const contextReport = getConversationContextReport();
  if (contextReport.error) {
    renderChronicleNotice(contextReport.error);
    return;
  }
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
      documents: chronicleDocuments,
      options: {
        source: "conversation-context",
        maxEntries: 40,
        totalPageCount: countChroniclePagesForLlm(),
      },
    });

    if (!result.ready) {
      renderChronicleNotice(result.message || "大模型服务未连接。");
      return;
    }

    renderChronicleLlmEntries(
      result.entries || [],
      [...contextReport.warnings, ...(result.warnings || [])],
    );
  } catch (error) {
    renderChronicleNotice("暂时无法调用大模型生成编年。");
  }
}

function collectChronicleDocumentsForLlm(topic) {
  const records = [];
  const attachmentDocuments = buildConversationAttachmentDocumentsForLlm(topic, 10, 1800);
  const attachmentPageCount = attachmentDocuments.reduce((total, item) => total + item.pages.length, 0);

  getSmartScopeDocuments().forEach((item, documentIndex) => {
    item.pages.forEach((page, pageIndex) => {
      const text = getSmartPagePrimaryText(page).trim();
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
    .slice(0, Math.max(18, 36 - attachmentPageCount))
    .forEach(({ item, page }) => {
      if (!grouped.has(item.id)) {
        grouped.set(item.id, {
          documentId: item.id,
          title: getDocumentDisplayTitle(item),
          author: item.author || "",
          year: item.year || "",
          publisher: item.publisher || "",
          tags: item.tags || "",
          pages: [],
        });
      }

      grouped.get(item.id).pages.push({
        pageId: page.id,
        pageNumber: page.pageNumber,
        text: getSmartPagePrimaryText(page).slice(0, 1800),
        notes: (page.notes || "").slice(0, 500),
      });
    });

  return [
    ...Array.from(grouped.values()),
    ...attachmentDocuments,
  ];
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
    item.tags,
    page.notes,
    text,
  ].join("\n").toLowerCase();

  return haystack.includes(normalizedTopic) ? 3 : 1;
}

function countChroniclePagesForLlm() {
  const documentPages = getSmartScopeDocuments().reduce((total, item) => {
    return total + item.pages.filter((page) => getSmartPagePrimaryText(page).trim()).length;
  }, 0);
  return documentPages + countConversationAttachmentChunks(chronicleTopic.value.trim(), 10, 1800);
}

function renderChronicleLoading() {
  renderResultState(chronicleResults, "正在调用大模型生成编年...");
}

function renderChronicleNotice(message) {
  renderResultState(chronicleResults, message);
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
    const attachment = sourceTarget?.attachment || null;

    result.className = "result-item";
    title.textContent = sameDay ? `同日：${dateLabel}` : dateLabel;
    summary.textContent = entry.summary || entry.event || "史事待核";
    source.textContent = formatChronicleLlmSources(entry.sources);
    action.className = "secondary-button";
    action.type = "button";
    action.textContent = attachment ? "打开文件" : "查看原页";
    action.disabled = !sourceTarget || Boolean(attachment && !attachment.fileUrl);
    action.addEventListener("click", () => {
      if (!sourceTarget) {
        return;
      }

      if (attachment) {
        openConversationAttachment(attachment);
        return;
      }

      selectedDocumentId = sourceTarget.documentId;
      selectedPageId = sourceTarget.pageId;
      setReaderReturnView("library");
      renderAll();
      setView("reader");
    });

    content.append(title, summary, source);
    if (Array.isArray(warnings) && warnings.length && index === entries.length - 1) {
      content.append(formatWarnings(warnings));
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
      const pageNumber = source.pageNumber
        ? source.sourceType === "conversation-file"
          ? `，内容片段 ${source.pageNumber}`
          : `，第 ${source.pageNumber} 页`
        : "";
      const quote = source.quote ? `；原文：${source.quote}` : "";
      if (source.sourceType === "conversation-file") {
        return `来源：当前对话上传文件（快速读取）：《${title}》${pageNumber}${quote}`;
      }
      return `来源：${author}：《${title}》，${publisher}，${year}${pageNumber}${quote}`;
    })
    .join("\n");
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
      const attachment = findConversationAttachment(source.attachmentId || source.documentId, source.title);
      if (attachment) {
        return { attachment };
      }
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
