function buildChronicle() {
  const topic = chronicleTopic.value.trim();
  const entries = collectChronicleEntries(topic);
  chronicleResults.innerHTML = "";

  if (!entries.length) {
    chronicleResults.append(emptyState("未找到可生成编年的日期条目。可先补充整理文字，或换一个主题。"));
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
