/* Current-document search. All local offsets are UTF-16, like reader sentences. */
const readerSearchForm = document.querySelector("#reader-search-form");
const readerSearchInput = document.querySelector("#reader-search-input");
const readerSearchResults = document.querySelector("#reader-search-results");
const readerSearchStatus = document.querySelector("#reader-search-status");
const readerSearchMarkAll = document.querySelector("#reader-search-mark-all");
const readerSearchPageFrom = document.querySelector("#reader-search-page-from");
const readerSearchPageTo = document.querySelector("#reader-search-page-to");
const readerSearchNavButtons = [...document.querySelectorAll("[data-reader-search-nav]")];
const READER_SEARCH_LABELS = { exact: "严格匹配", partial: "部分匹配", semantic: "嵌入匹配" };
// 结果表列标题；第 1、3 列是纯数字，内容居中（reader-search-col-center）
const READER_SEARCH_COLUMNS = [
  { title: "序号", center: true },
  { title: "匹配文本", center: false },
  { title: "位置", center: true },
];
// 嵌入匹配的片段可能远长于检索词，列表里只截断显示前 N 个字符
const READER_SEARCH_TEXT_LIMIT = 100;
const readerSearchState = {
  documentId: null, snapshot: "", query: "", matches: [], levels: new Set(["exact", "partial", "semantic"]),
  pageFrom: null, pageTo: null,
  activeId: "", markAll: false, loading: false, warnings: [], semanticError: "",
  revision: 0, scrollPending: false,
};

function getReaderSearchText(page) {
  return page?.punctuatedText || page?.cleanText || "";
}

function readerSearchSnapshot(item) {
  return JSON.stringify([currentUser?.id, item?.id, (item?.pages || []).map((page) =>
    [page.id, page.pageNumber, getReaderSearchText(page)])]);
}

function readerSearchOccurrences(text, query) {
  const ranges = [];
  if (!query) return ranges;
  let position = text.indexOf(query);
  while (position !== -1) {
    ranges.push({ start: position, end: position + query.length });
    position = text.indexOf(query, position + 1);
  }
  return ranges;
}

function readerSearchNormalize(text) {
  let value = "";
  const starts = [], ends = [];
  let offset = 0;
  for (const point of text) {
    if (!/[\s\p{P}]/u.test(point)) {
      const folded = point.toLowerCase();
      value += folded;
      for (let i = 0; i < folded.length; i += 1) {
        starts.push(offset);
        ends.push(offset + point.length);
      }
    }
    offset += point.length;
  }
  return { value, starts, ends };
}

function readerSearchPartialRanges(text, query, exact) {
  const normalized = readerSearchNormalize(text);
  const needle = readerSearchNormalize(query).value;
  if (!needle) return [];
  const terms = new Set([needle]);
  // Chinese has no mandatory word separators: contiguous bigrams provide a
  // deterministic literal fallback. Latin words are matched as complete words.
  for (const run of needle.match(/[\p{Script=Han}]+/gu) || []) {
    const points = Array.from(run);
    for (let i = 0; i + 1 < points.length; i += 1) terms.add(points.slice(i, i + 2).join(""));
  }
  for (const word of query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (!/\p{Script=Han}/u.test(word)) terms.add(word);
  }
  const ranges = [];
  for (const term of terms) {
    const wholeWord = /^[\p{Script=Latin}\p{N}]+$/u.test(term);
    for (const range of readerSearchOccurrences(normalized.value, term)) {
      const start = normalized.starts[range.start], end = normalized.ends[range.end - 1];
      if (wholeWord && (/[\p{Script=Latin}\p{N}]/u.test(text[start - 1] || "") ||
          /[\p{Script=Latin}\p{N}]/u.test(text[end] || ""))) continue;
      if (!exact.some((hit) => hit.start < end && hit.end > start)) ranges.push({ start, end });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else if (!previous || previous.start !== range.start || previous.end !== range.end) merged.push({ ...range });
  }
  return merged;
}

function createReaderSearchMatch(page, pageIndex, level, range) {
  return { ...range, pageId: page.id, pageIndex, pageNumber: page.pageNumber, level,
    id: JSON.stringify([page.id, level, range.start, range.end]), text: getReaderSearchText(page) };
}

function findReaderLiteralMatches(item, query) {
  const matches = [];
  const pages = item.pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
  pages.forEach((page, pageIndex) => {
    const text = getReaderSearchText(page);
    const exact = readerSearchOccurrences(text, query);
    for (const range of exact) matches.push(createReaderSearchMatch(page, pageIndex, "exact", range));
    for (const range of readerSearchPartialRanges(text, query, exact)) {
      matches.push(createReaderSearchMatch(page, pageIndex, "partial", range));
    }
  });
  return sortReaderSearchMatches(matches);
}

function sortReaderSearchMatches(matches) {
  return matches.sort((a, b) => a.pageIndex - b.pageIndex || a.start - b.start || a.end - b.end || a.level.localeCompare(b.level));
}

async function resolveReaderSemanticMatches(item, hits, literalMatches) {
  const matches = [], hashes = new Map(), seen = new Set();
  const pages = item.pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
  for (const hit of hits || []) {
    if (hit.documentId !== item.id || !hit.matchedBy?.includes("semantic")) continue;
    const pageIndex = pages.findIndex((page) => page.id === hit.pageId);
    const page = pages[pageIndex];
    if (!page) continue;
    const text = getReaderSearchText(page);
    const layer = page.punctuatedText ? "punctuatedText" : "cleanText";
    if (!text || hit.sourceLayer !== layer) continue;
    if (!hashes.has(page.id)) hashes.set(page.id, await hashEvidenceText(text));
    if (hashes.get(page.id) !== hit.sourceHash) continue;
    const points = Array.from(text);
    if (!Number.isInteger(hit.start) || !Number.isInteger(hit.end) || hit.start < 0 || hit.end <= hit.start || hit.end > points.length) continue;
    const start = points.slice(0, hit.start).join("").length;
    const end = start + points.slice(hit.start, hit.end).join("").length;
    if (text.slice(start, end) !== hit.text || literalMatches.some((match) =>
      match.pageId === page.id && match.start < end && match.end > start)) continue;
    const match = createReaderSearchMatch(page, pageIndex, "semantic", { start, end });
    if (!seen.has(match.id)) { matches.push(match); seen.add(match.id); }
  }
  return matches;
}

function syncReaderSearch(item) {
  if (!readerSearchForm) return;
  const snapshot = readerSearchSnapshot(item);
  if (readerSearchState.documentId !== (item?.id || null)) {
    Object.assign(readerSearchState, { documentId: item?.id || null, snapshot, query: "", matches: [],
      activeId: "", loading: false, warnings: [], semanticError: "",
      scrollPending: false, revision: readerSearchState.revision + 1 });
    readerSearchInput.value = "";
  } else if (snapshot !== readerSearchState.snapshot) {
    readerSearchState.snapshot = snapshot;
    readerSearchState.revision += 1;
    readerSearchState.matches = [];
    readerSearchState.activeId = "";
    readerSearchState.loading = false;
    readerSearchState.semanticError = "";
    if (item && readerSearchState.query) runReaderSearch(readerSearchState.query);
  }
  renderReaderSearchPanel();
}

async function runReaderSearch(query) {
  const item = getSelectedDocument();
  if (!item || readerEditing) return;
  query = query.trim();
  const revision = ++readerSearchState.revision;
  const snapshot = readerSearchSnapshot(item);
  Object.assign(readerSearchState, { documentId: item.id, snapshot, query,
    matches: query ? findReaderLiteralMatches(item, query) : [], activeId: "", scrollPending: false,
    loading: Boolean(query && item.pages.some((page) => getReaderSearchText(page).trim())),
    warnings: [], semanticError: "" });
  renderReaderSearchPanel();
  refreshReaderSearchText();
  if (!readerSearchState.loading) return;
  try {
    const literalMatches = readerSearchState.matches;
    const response = await fetchRetrievalEvidence({ query, mode: "reader", documentIds: [item.id], textPolicy: "reader" });
    if (revision !== readerSearchState.revision) return;
    const semantic = await resolveReaderSemanticMatches(item, response.hits, literalMatches);
    if (revision !== readerSearchState.revision || getSelectedDocument()?.id !== item.id ||
        snapshot !== readerSearchSnapshot(getSelectedDocument())) return;
    readerSearchState.matches = sortReaderSearchMatches([...readerSearchState.matches, ...semantic]);
    readerSearchState.warnings = response.warnings || [];
  } catch (error) {
    if (revision !== readerSearchState.revision) return;
    // 不单独写提示句：失败状态由「嵌入」计数格显示为「失败」（悬停看原因）
    readerSearchState.semanticError = error.message;
  } finally {
    if (revision === readerSearchState.revision) {
      readerSearchState.loading = false;
      renderReaderSearchPanel();
      refreshReaderSearchText();
    }
  }
}

function parseReaderSearchPage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : null;
}

function syncReaderSearchPageRange() {
  readerSearchState.pageFrom = parseReaderSearchPage(readerSearchPageFrom?.value);
  readerSearchState.pageTo = parseReaderSearchPage(readerSearchPageTo?.value);
}

function getFilteredReaderSearchMatches() {
  const { levels, pageFrom, pageTo } = readerSearchState;
  return readerSearchState.matches.filter((match) => {
    if (!levels.has(match.level)) return false;
    if (pageFrom === null && pageTo === null) return true;
    const page = match.pageIndex + 1;
    return (pageFrom === null || page >= pageFrom) && (pageTo === null || page <= pageTo);
  });
}

function renderReaderSearchPanel() {
  if (!readerSearchForm) return;
  const item = getSelectedDocument();
  readerSearchInput.disabled = !item || readerEditing;
  document.querySelector("#reader-search-submit").disabled = !item || readerEditing;
  renderReaderSearchMarkAll();
  const filtered = getFilteredReaderSearchMatches();
  for (const button of readerSearchNavButtons) button.disabled = !filtered.length || readerEditing;
  // 「标注」标的是筛选后的结果，没有可标注的项时与导航按钮一起禁用
  if (readerSearchMarkAll) readerSearchMarkAll.disabled = !filtered.length || readerEditing;
  for (const level of Object.keys(READER_SEARCH_LABELS)) {
    const node = document.querySelector(`[data-reader-search-count="${level}"]`);
    // 嵌入检索失败时不显示 0（会被误读成「没有相近段落」），改为「失败」并悬停提示原因
    const failed = level === "semantic" && Boolean(readerSearchState.semanticError);
    node.textContent = failed
      ? "失败"
      : String(readerSearchState.matches.filter((match) => match.level === level).length);
    node.classList.toggle("is-failed", failed);
    if (failed) node.title = `嵌入检索失败：${readerSearchState.semanticError}`;
    else node.removeAttribute("title");
  }
  // 只在「已检索且确实一条都没匹配上」时提示；未检索、无整理文本、层级未选、编辑态等一律不提示
  const searched = !readerEditing && Boolean(readerSearchState.query) &&
    Boolean(item && item.pages.some((page) => getReaderSearchText(page).trim()));
  if (readerSearchStatus) {
    readerSearchStatus.textContent =
      searched && !readerSearchState.loading && !readerSearchState.matches.length ? "未找到匹配项。" : "";
  }
  readerSearchResults.setAttribute("aria-busy", String(readerSearchState.loading));
  readerSearchResults.replaceChildren();
  const fragment = document.createDocumentFragment();
  const appendCells = (target, cells) => {
    for (const [className, text] of cells) {
      const cell = document.createElement("span");
      if (className) cell.className = className;
      cell.textContent = text;
      target.append(cell);
    }
  };
  if (filtered.length) {
    // 表头（随列表滚动吸顶）；aria-hidden，列名对屏幕阅读器无意义
    const head = document.createElement("li");
    head.className = "reader-search-results-head";
    head.setAttribute("aria-hidden", "true");
    appendCells(head, READER_SEARCH_COLUMNS.map(({ title, center }) => [center ? "reader-search-col-center" : "", title]));
    fragment.append(head);
  }
  filtered.forEach((match, index) => {
    const row = document.createElement("li");
    row.className = "reader-search-result-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reader-search-result";
    button.classList.toggle("is-active", match.id === readerSearchState.activeId);
    button.setAttribute("aria-current", String(match.id === readerSearchState.activeId));
    button.disabled = readerEditing;
    // 只列匹配到的片段，不带上下文
    const previewEnd = Math.min(match.end, match.start + READER_SEARCH_TEXT_LIMIT);
    appendCells(button, [
      [`reader-search-result-index reader-search-col-center reader-search-level-${match.level}`, String(index + 1)],
      ["reader-search-result-text", match.text.slice(match.start, previewEnd) + (previewEnd < match.end ? "…" : "")],
      ["reader-search-result-page reader-search-col-center", String(match.pageIndex + 1)],
    ]);
    button.addEventListener("click", () => openReaderSearchMatch(match.id));
    row.append(button);
    fragment.append(row);
  });
  readerSearchResults.append(fragment);
}

// 在当前筛选结果里跳转：选中目标项 → 列表高亮该行，正文也跟着圈出并滚动到该处
function jumpReaderSearchMatch(kind) {
  const matches = getFilteredReaderSearchMatches();
  if (!matches.length) return;
  const index = matches.findIndex((match) => match.id === readerSearchState.activeId);
  let target;
  if (kind === "first") target = 0;
  else if (kind === "last") target = matches.length - 1;
  else if (kind === "next") target = index === -1 ? 0 : Math.min(index + 1, matches.length - 1);
  else target = index === -1 ? matches.length - 1 : Math.max(index - 1, 0);
  openReaderSearchMatch(matches[target].id);
}

function openReaderSearchMatch(id) {
  if (readerEditing) return;
  const match = getFilteredReaderSearchMatches().find((entry) => entry.id === id);
  const page = getSelectedDocument()?.pages.find((entry) => entry.id === match?.pageId);
  if (!match || !page || getReaderSearchText(page) !== match.text) { syncReaderSearch(getSelectedDocument()); return; }
  readerSearchState.activeId = id;
  readerSearchState.scrollPending = true;
  // Clear external citation anchors so search navigation only marks reading text.
  const url = new URL(window.location.href);
  for (const key of ["sourceLayer", "sourceHash", "start", "end"]) url.searchParams.delete(key);
  window.history.replaceState(null, "", url.href);
  selectedPageId = page.id;
  renderAll();
}

function refreshReaderSearchText() {
  const item = getSelectedDocument(), page = getSelectedPage();
  if (!readerSearchForm || !page || readerEditing || !readerText || readerText.classList.contains("is-empty")) return;
  readerText.replaceChildren();
  renderReaderText(page, getCachedReaderIndex(item, page), { evidence: false });
}

function applyReaderSearchHighlights(page) {
  if (!readerSearchForm || readerEditing || !page || getSelectedDocument()?.id !== readerSearchState.documentId) return;
  const ranges = getFilteredReaderSearchMatches().filter((match) => match.pageId === page.id &&
    match.text === getReaderSearchText(page) && (readerSearchState.markAll || match.id === readerSearchState.activeId));
  if (!ranges.length) return;
  const events = new Map();
  for (const range of ranges) {
    const active = range.id === readerSearchState.activeId ? 1 : 0;
    for (const [offset, delta] of [[range.start, 1], [range.end, -1]]) {
      const value = events.get(offset) || { count: 0, active: 0 };
      value.count += delta; value.active += delta * active;
      events.set(offset, value);
    }
  }
  const intervals = [];
  let count = 0, active = 0, previous = 0;
  for (const [offset, value] of [...events].sort((a, b) => a[0] - b[0])) {
    if (count > 0 && offset > previous) intervals.push({ start: previous, end: offset, active: active > 0 });
    count += value.count; active += value.active; previous = offset;
  }
  const walker = document.createTreeWalker(readerText, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let position = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, start: position, end: position + node.textContent.length });
    position += node.textContent.length;
  }
  let firstActive = null, intervalIndex = 0;
  for (const entry of nodes) {
    while (intervalIndex < intervals.length && intervals[intervalIndex].end <= entry.start) intervalIndex += 1;
    const intersections = [];
    for (let i = intervalIndex; i < intervals.length && intervals[i].start < entry.end; i += 1) {
      intersections.push(intervals[i]);
    }
    if (!intersections.length) continue;
    const fragment = document.createDocumentFragment(), text = entry.node.textContent;
    let cursor = 0;
    for (const interval of intersections) {
      const start = Math.max(interval.start, entry.start) - entry.start;
      const end = Math.min(interval.end, entry.end) - entry.start;
      fragment.append(text.slice(cursor, start));
      const mark = document.createElement("mark");
      mark.className = "reader-search-highlight" + (interval.active ? " is-current" : "");
      mark.textContent = text.slice(start, end);
      fragment.append(mark);
      if (interval.active) firstActive ||= mark;
      cursor = end;
    }
    fragment.append(text.slice(cursor));
    entry.node.replaceWith(fragment);
  }
  if (firstActive && readerSearchState.scrollPending) {
    readerSearchState.scrollPending = false;
    scrollReaderRegionIntoView(firstActive, readerText);
  }
}

readerSearchForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  runReaderSearch(readerSearchInput.value);
});
readerSearchInput?.addEventListener("input", () => {
  if (!readerSearchInput.value.trim()) runReaderSearch("");
});
document.querySelectorAll("[data-reader-search-level]").forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) readerSearchState.levels.add(input.dataset.readerSearchLevel);
    else readerSearchState.levels.delete(input.dataset.readerSearchLevel);
    renderReaderSearchPanel();
    refreshReaderSearchText();
  });
});
for (const input of [readerSearchPageFrom, readerSearchPageTo]) {
  input?.addEventListener("input", () => {
    syncReaderSearchPageRange();
    renderReaderSearchPanel();
    refreshReaderSearchText();
  });
}
for (const button of readerSearchNavButtons) {
  button.addEventListener("click", () => jumpReaderSearchMatch(button.dataset.readerSearchNav));
}
function renderReaderSearchMarkAll() {
  if (!readerSearchMarkAll) return;
  readerSearchMarkAll.setAttribute("aria-pressed", String(readerSearchState.markAll));
}

readerSearchMarkAll?.addEventListener("click", () => {
  readerSearchState.markAll = !readerSearchState.markAll;
  renderReaderSearchMarkAll();
  refreshReaderSearchText();
});
