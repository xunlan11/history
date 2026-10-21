/* Reader content is optional: invalid/stale payloads leave the parent's plain-text renderer in charge. */
const readerContentCache = new Map();
const readerContentTextHashes = new Map();
const readerVisualBoundContainers = new WeakSet();
const readerVisualState = { pageKey: "", selected: null, hovered: null, sentenceActive: false };

function getReaderContentKey(item, page) {
  return JSON.stringify([typeof currentUser === "undefined" ? "" : currentUser?.id,
    item?.id, item?.processingRevision, item?.updatedAt, page?.id, page?.processingRevision,
    page?.readerContentRevision, page?.readerContentUpdatedAt, page?.updatedAt, page?.visualsExtracted,
    page?.visuals, page?.imageHash,
    getPageImageSource(page), getPagePrimaryText(page)]);
}

// Synchronous SHA-256 also works outside secure contexts, so direct rendering validates the same contract as loading.
function hashReaderContentText(text) {
  if (readerContentTextHashes.has(text)) return readerContentTextHashes.get(text);
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(size);
  data.set(bytes);
  data[bytes.length] = 128;
  const view = new DataView(data.buffer);
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(size - 4, (bytes.length * 8) >>> 0);
  const primes = [];
  for (let n = 2; primes.length < 64; n++) {
    if (primes.every((p) => n % p !== 0)) primes.push(n);
  }
  const constants = primes.map((p) => (Math.cbrt(p) % 1 * 0x100000000) >>> 0);
  const hash = primes.slice(0, 8).map((p) => (Math.sqrt(p) % 1 * 0x100000000) >>> 0);
  const rotate = (n, bits) => (n >>> bits) | (n << (32 - bits));
  const words = new Uint32Array(64);
  for (let block = 0; block < size; block += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2];
      words[i] = words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[i - 7] +
        (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) | 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => { hash[i] = (hash[i] + value) >>> 0; });
  }
  const result = hash.map((n) => n.toString(16).padStart(8, "0")).join("");
  readerContentTextHashes.set(text, result);
  if (readerContentTextHashes.size > 12) readerContentTextHashes.delete(readerContentTextHashes.keys().next().value);
  return result;
}

function readerTableSize(value) {
  return Array.isArray(value) ? value.length : value;
}

function isReaderTableModelValid(model) {
  const rows = readerTableSize(model?.rows), columns = readerTableSize(model?.columns);
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 ||
      rows * columns > 100000 || !Array.isArray(model.cells)) return false;
  const occupied = new Set();
  for (const cell of model.cells) {
    if (!cell || typeof cell !== "object") return false;
    const { row, column } = cell, rowSpan = cell.rowSpan ?? 1, colSpan = cell.colSpan ?? 1;
    if (![row, column, rowSpan, colSpan].every(Number.isInteger) || row < 0 || column < 0 ||
        rowSpan < 1 || colSpan < 1 || row + rowSpan > rows || column + colSpan > columns ||
        typeof cell.text !== "string") return false;
    for (let r = row; r < row + rowSpan; r++) for (let c = column; c < column + colSpan; c++) {
      const key = r * columns + c;
      if (occupied.has(key)) return false;
      occupied.add(key);
    }
  }
  return occupied.size === rows * columns;
}

function isReaderContentValid(content, page) {
  if (!page || !content || content.version !== 1 || content.sourceRevision !== page.processingRevision ||
      typeof content.displayedText !== "string" || content.displayedText !== getPagePrimaryText(page) ||
      content.textHash !== hashReaderContentText(content.displayedText) ||
      (page.imageHash && content.imageHash !== page.imageHash) ||
      !Array.isArray(content.items) || !content.visuals || typeof content.visuals !== "object") return false;
  let offset = 0;
  const seen = new Set(), text = content.displayedText;
  const boundary = (n) => !(n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1]) && /[\uDC00-\uDFFF]/.test(text[n]));
  for (const entry of content.items) {
    if (entry?.type === "text") {
      if (!Number.isInteger(entry.start) || !Number.isInteger(entry.end) || entry.start !== offset ||
          entry.end <= offset || entry.end > text.length || !boundary(entry.start) || !boundary(entry.end)) return false;
      offset = entry.end;
    } else if (entry?.type === "visual") {
      const visual = Object.hasOwn(content.visuals, entry.visualId) && content.visuals[entry.visualId];
      if (!visual || !visual.id || visual.id !== entry.visualId || seen.has(visual.id) ||
          !["figure", "chart", "table", "caption"].includes(visual.kind) ||
          !["structured", "image"].includes(visual.renderMode) ||
          (visual.renderMode === "structured" && visual.kind === "table" && !isReaderTableModelValid(visual.tableModel)) ||
          (visual.captions !== undefined && (!Array.isArray(visual.captions) || visual.captions.some((caption) =>
            !caption || !caption.id || typeof caption.text !== "string" || !["before", "after"].includes(caption.position))))) return false;
      seen.add(visual.id);
    } else return false;
  }
  return offset === text.length;
}

function getCachedReaderContent(item, page) {
  if (!item?.id || !page?.id) return null;
  const value = readerContentCache.get(getReaderContentKey(item, page))?.value;
  return isReaderContentValid(value, page) ? value : null;
}

async function loadReaderContent(item, page) {
  if (!item?.id || !page?.id) return null;
  const key = getReaderContentKey(item, page), cached = readerContentCache.get(key);
  if (cached) return cached.promise || cached.value;
  const entry = { value: null, promise: null };
  readerContentCache.set(key, entry);
  while (readerContentCache.size > 12) readerContentCache.delete(readerContentCache.keys().next().value);
  entry.promise = (async () => {
    try {
      const response = await fetch(DATA_PROCESSING_URL + "/" + encodeURIComponent(item.id) + "/pages/" +
        encodeURIComponent(page.id) + "/reader-content", { cache: "no-store" });
      if (!response.ok) return null;
      const content = await response.json();
      if (getReaderContentKey(item, page) !== key || !isReaderContentValid(content, page)) return null;
      entry.value = content;
      return content;
    } catch {
      return null;
    } finally {
      entry.promise = null;
      if (!entry.value && readerContentCache.get(key) === entry) readerContentCache.delete(key);
    }
  })();
  return entry.promise;
}

function readerVisualElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readerVisualSafeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, document.baseURI || "http://localhost/");
    return ["http:", "https:", "blob:"].includes(url.protocol) ||
      (url.protocol === "data:" && /^data:image\/(png|jpe?g|webp|gif|avif);base64,/i.test(value)) ? url.href : "";
  } catch { return ""; }
}

function createReaderVisualTable(model) {
  const table = readerVisualElement("table", "reader-visual-table");
  table.dataset.borderStyle = ["unknown", "ruled", "borderless"].includes(model.borderStyle) ? model.borderStyle : "unknown";
  const body = document.createElement("tbody");
  const starts = new Map(model.cells.map((cell) => [cell.row * readerTableSize(model.columns) + cell.column, cell]));
  for (let row = 0; row < readerTableSize(model.rows); row++) {
    const tr = document.createElement("tr");
    for (let column = 0; column < readerTableSize(model.columns); column++) {
      const cell = starts.get(row * readerTableSize(model.columns) + column);
      if (!cell) continue;
      const td = readerVisualElement(cell.header ? "th" : "td", "", cell.text);
      td.rowSpan = cell.rowSpan || 1;
      td.colSpan = cell.colSpan || 1;
      if (cell.id) td.dataset.cellId = cell.id;
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  return table;
}

function createReaderVisual(visual) {
  const figure = readerVisualElement("figure", "reader-visual");
  figure.dataset.readerAuxiliary = "true";
  figure.dataset.readerVisualId = visual.id;
  figure.tabIndex = 0;
  figure.setAttribute("aria-label", readerVisualKindLabel(visual.kind));
  const captions = (visual.captionCoverage === "included" ? [] : (visual.captions || []).filter((caption) => !caption.inImage)).map((caption) => {
    const node = readerVisualElement("figcaption", "reader-visual-caption", caption.text);
    node.dataset.readerVisualId = visual.id;
    node.dataset.readerCaptionId = caption.id;
    node.dataset.readerAuxiliary = "true";
    node.tabIndex = 0;
    return { node, caption };
  });
  for (const { node, caption } of captions) if (caption.position === "before") figure.append(node);
  if (visual.kind === "table" && visual.renderMode === "structured") {
    const scroll = readerVisualElement("div", "reader-visual-table-scroll");
    scroll.append(createReaderVisualTable(visual.tableModel));
    figure.append(scroll);
  } else if (visual.kind === "caption") {
    if (!captions.length && (visual.title || visual.text)) figure.append(readerVisualElement("figcaption", "reader-visual-caption", visual.title || visual.text));
    figure.append(readerVisualElement("p", "reader-visual-placement-status", "标题归属待核对"));
  } else {
    const url = readerVisualSafeUrl(visual.url);
    if (url) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = visual.title || readerVisualKindLabel(visual.kind);
      image.loading = "lazy";
      if (visual.width > 0) image.width = visual.width;
      if (visual.height > 0) image.height = visual.height;
      image.addEventListener("error", () => {
        image.replaceWith(readerVisualElement("p", "reader-visual-unavailable", "图像暂不可用"));
      }, { once: true });
      figure.append(image);
    } else if (visual.kind !== "caption") {
      figure.append(readerVisualElement("p", "reader-visual-unavailable", "图像暂不可用"));
      const locate = readerVisualElement("button", "reader-visual-locate", "查看原页");
      locate.type = "button";
      locate.addEventListener("click", () => setReaderVisualActive(visual.id, { scrollImage: true, scrollText: true }));
      figure.append(locate);
    }
  }
  for (const { node, caption } of captions) if (caption.position === "after") figure.append(node);
  if (visual.kind === "caption") return figure;
  const enlarge = readerVisualElement("button", "reader-visual-enlarge", "放大查看");
  enlarge.type = "button";
  enlarge.dataset.readerVisualEnlarge = visual.id;
  enlarge.setAttribute("aria-label", "放大查看" + readerVisualKindLabel(visual.kind));
  figure.append(enlarge);
  return figure;
}

function readerVisualKindLabel(kind) {
  return ({ figure: "插图", chart: "图表", table: "表格", caption: "图注" })[kind] || "图表";
}

function readerContentSentenceIndex(index, page, text) {
  if (!index || index.sourceRevision !== page.processingRevision || index.displayedText !== text || !Array.isArray(index.sentences)) return null;
  let offset = 0;
  for (const sentence of index.sentences) {
    if (!sentence.id || sentence.start !== offset || !Number.isInteger(sentence.end) || sentence.end <= offset ||
        sentence.end > text.length || text.slice(offset, sentence.end) !== sentence.text) return null;
    offset = sentence.end;
  }
  return offset === text.length ? index : null;
}

function renderReaderContent(page, content, readerIndex = null) {
  if ((typeof readerEditing !== "undefined" && readerEditing) || !isReaderContentValid(content, page) ||
      typeof readerText === "undefined" || !readerText) return false;
  const fragment = document.createDocumentFragment();
  const index = readerContentSentenceIndex(readerIndex, page, content.displayedText);
  for (const entry of content.items) {
    if (entry.type === "visual") {
      const figure = createReaderVisual(content.visuals[entry.visualId]);
      if (["unplaced", "approximate"].includes(entry.placement)) {
        figure.append(readerVisualElement("p", "reader-visual-placement-status",
          entry.placement === "unplaced" ? "位置待核对，请对照原页。" : "位置近似，请对照原页。"));
      }
      fragment.append(figure);
      continue;
    }
    const slices = index ? index.sentences.filter((sentence) => sentence.end > entry.start && sentence.start < entry.end) : [entry];
    for (const slice of slices) {
      const start = Math.max(entry.start, slice.start), end = Math.min(entry.end, slice.end);
      const span = readerVisualElement("span", index ? "reader-sentence" : "reader-content-text", content.displayedText.slice(start, end));
      span.dataset.readerTextStart = String(start);
      span.dataset.readerTextEnd = String(end);
      if (index) { span.dataset.sentenceId = slice.id; span.tabIndex = 0; }
      fragment.append(span);
    }
  }
  for (const message of content.warnings || []) {
    const warning = readerVisualElement("p", "reader-visual-placement-status", message);
    warning.dataset.readerAuxiliary = "true";
    fragment.append(warning);
  }
  const selectedItem = typeof getSelectedDocument === "function" ? getSelectedDocument() : null;
  const backfill = createReaderVisualBackfill(selectedItem, page, content);
  if (backfill) fragment.append(backfill);
  const key = JSON.stringify([typeof getSelectedDocument === "function" ? getSelectedDocument()?.id : "", page.id, page.processingRevision]);
  if (readerVisualState.pageKey !== key) {
    readerVisualState.pageKey = key;
    readerVisualState.selected = null;
    readerVisualState.hovered = null;
    readerVisualState.sentenceActive = false;
    notifyReaderVisualSelected(null);
  }
  readerText.replaceChildren(fragment);
  readerText.classList.remove("is-empty");
  bindReaderVisualEvents(readerText);
  applyReaderVisualActive();
  if (typeof applyReaderSearchHighlights === "function") applyReaderSearchHighlights(page);
  return true;
}

function readerVisualRegions(region, width, height) {
  const pointValid = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) &&
    p[0] >= 0 && p[1] >= 0 && p[0] <= width && p[1] <= height;
  if (Array.isArray(region?.polygon) && region.polygon.length >= 3 && region.polygon.every(pointValid)) {
    return { tag: "polygon", attributes: { points: region.polygon.map((p) => p.join(",")).join(" ") } };
  }
  const b = region?.bbox;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) ||
      b[0] < 0 || b[1] < 0 || b[2] <= b[0] || b[3] <= b[1] || b[2] > width || b[3] > height) return null;
  return { tag: "rect", attributes: { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] } };
}

function renderReaderVisualOverlay(page, content) {
  if ((typeof readerEditing !== "undefined" && readerEditing) || !isReaderContentValid(content, page) ||
      typeof readerOriginalPreview === "undefined" || !readerOriginalPreview) return false;
  readerOriginalPreview.querySelectorAll(".reader-visual-overlay").forEach((node) => node.remove());
  const image = readerOriginalPreview.querySelector(".reader-image-frame img");
  if (!image || !content.imageHash || !page.imageHash || page.imageHash !== content.imageHash) return false;
  const source = getPageImageSource(page);
  const expectedSource = readerVisualSafeUrl(source);
  if (!expectedSource || readerVisualSafeUrl(image.getAttribute("src") || image.src) !== expectedSource) return false;
  const namespace = "http://www.w3.org/2000/svg";
  let appended = false;
  for (const entry of content.items) {
    if (entry.type !== "visual") continue;
    const visual = content.visuals[entry.visualId], width = visual.sourceImageWidth, height = visual.sourceImageHeight;
    if (visual.geometryStatus !== "exact" || visual.sourceImageHash !== content.imageHash ||
        !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
    const overlay = document.createElementNS(namespace, "svg");
    overlay.classList.add("reader-visual-overlay");
    overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
    overlay.setAttribute("aria-label", "原文图表定位");
    overlay.style.visibility = "hidden";
    const add = (regions, caption) => {
      for (const region of Array.isArray(regions) ? regions : []) {
        const shape = readerVisualRegions(region, width, height);
        if (!shape) continue;
        const node = document.createElementNS(namespace, shape.tag);
        for (const [name, value] of Object.entries(shape.attributes)) node.setAttribute(name, String(value));
        node.classList.add("reader-visual-region");
        node.dataset.readerVisualId = visual.id;
        if (caption) node.dataset.readerCaptionId = caption.id;
        node.setAttribute("tabindex", "0");
        node.setAttribute("role", "button");
        node.setAttribute("aria-label", "定位整理文本：" + (caption?.text || readerVisualKindLabel(visual.kind)));
        overlay.append(node);
      }
    };
    add(visual.sourceRegions);
    for (const caption of visual.captions || []) add(caption.sourceRegions, caption);
    if (!overlay.childNodes.length) continue;
    const show = () => {
      const matches = image.naturalWidth === width && image.naturalHeight === height &&
        page.imageHash === content.imageHash && page.processingRevision === content.sourceRevision &&
        readerVisualSafeUrl(getPageImageSource(page)) === expectedSource &&
        readerVisualSafeUrl(image.getAttribute("src") || image.src) === expectedSource;
      overlay.style.visibility = matches ? "visible" : "hidden";
    };
    image.addEventListener("load", show);
    image.addEventListener("error", () => { overlay.style.visibility = "hidden"; }, { once: true });
    image.parentNode.append(overlay);
    if (image.complete) show();
    appended = true;
  }
  bindReaderVisualEvents(readerOriginalPreview);
  applyReaderVisualActive();
  return appended;
}

function applyReaderVisualActive() {
  const active = readerVisualState.sentenceActive ? null : (readerVisualState.hovered || readerVisualState.selected);
  for (const container of [typeof readerText === "undefined" ? null : readerText,
    typeof readerOriginalPreview === "undefined" ? null : readerOriginalPreview]) {
    container?.querySelectorAll("[data-reader-visual-id]").forEach((node) => {
      const matches = (state) => Boolean(state && node.dataset.readerVisualId === state.id &&
        (state.captionId ? node.dataset.readerCaptionId === state.captionId : !node.dataset.readerCaptionId));
      node.classList.toggle("is-active", matches(active));
      node.classList.toggle("is-selected", !readerVisualState.sentenceActive && matches(readerVisualState.selected));
    });
  }
}

// Parent sentence selection clears visual selection; temporary hover can clear only visual hover.
function clearReaderVisualHover() {
  readerVisualState.hovered = null;
  applyReaderVisualActive();
}

function clearReaderVisualSelection() {
  readerVisualState.selected = null;
  readerVisualState.hovered = null;
  applyReaderVisualActive();
  notifyReaderVisualSelected(null);
}

function clearReaderVisualActive() { clearReaderVisualSelection(); }

function setReaderVisualSentenceActive(active) {
  readerVisualState.sentenceActive = Boolean(active);
  if (active) readerVisualState.hovered = null;
  applyReaderVisualActive();
}

function notifyReaderVisualSelected(id, options = {}) {
  if (typeof renderReaderVisualCatalog === "function") renderReaderVisualCatalog();
}

function setReaderVisualActive(id, options = {}) {
  readerVisualState.sentenceActive = false;
  const selected = readerVisualState.selected;
  if (id && typeof setReaderLinkActive === "function") setReaderLinkActive(null);
  if (options.hover) readerVisualState.selected = selected;
  const state = id ? { id, captionId: options.captionId || null } : null;
  if (options.hover) readerVisualState.hovered = state;
  else { readerVisualState.selected = state; readerVisualState.hovered = null; }
  applyReaderVisualActive();
  if (!options.hover) notifyReaderVisualSelected(id, options);
  const find = (container) => Array.from(container?.querySelectorAll("[data-reader-visual-id]") || []).find((node) =>
    node.dataset.readerVisualId === id && (options.captionId ? node.dataset.readerCaptionId === options.captionId : !node.dataset.readerCaptionId));
  const scroll = (container) => {
    const node = find(container);
    if (!node) return;
    if (typeof scrollReaderRegionIntoView === "function") scrollReaderRegionIntoView(node, container);
    else node.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
  };
  if (!options.hover && options.scrollImage && typeof readerPanelState !== "undefined" &&
      readerPanelState.originalCollapsed && typeof toggleReaderPanel === "function") toggleReaderPanel("original");
  if (!options.hover && options.scrollText) scroll(typeof readerText === "undefined" ? null : readerText);
  if (!options.hover && options.scrollImage) scroll(typeof readerOriginalPreview === "undefined" ? null : readerOriginalPreview);
}

function openReaderVisualLarge(id) {
  const figure = Array.from(readerText.querySelectorAll(".reader-visual")).find((node) => node.dataset.readerVisualId === id);
  if (!figure) return;
  document.querySelector(".reader-visual-dialog")?.remove();
  const dialog = readerVisualElement("dialog", "reader-visual-dialog");
  dialog.setAttribute("aria-label", "图表大图");
  const close = readerVisualElement("button", "reader-visual-dialog-close", "关闭");
  close.type = "button";
  close.addEventListener("click", () => { if (dialog.open) dialog.close(); else dialog.remove(); });
  const copy = figure.cloneNode(true);
  copy.querySelectorAll(".reader-visual-enlarge").forEach((node) => node.remove());
  dialog.append(close, copy);
  const restore = () => { dialog.remove(); figure.querySelector(".reader-visual-enlarge")?.focus(); };
  dialog.addEventListener("close", restore, { once: true });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && typeof dialog.showModal !== "function") { event.preventDefault(); restore(); }
  });
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else { dialog.setAttribute("open", ""); dialog.setAttribute("role", "dialog"); }
  close.focus();
}

function bindReaderVisualEvents(container) {
  if (!container || readerVisualBoundContainers.has(container)) return;
  readerVisualBoundContainers.add(container);
  const target = (event) => {
    const node = event.target?.closest?.("[data-reader-visual-id]");
    return node && container.contains(node) && !(typeof readerEditing !== "undefined" && readerEditing) ? node : null;
  };
  const hover = (event) => {
    const node = target(event);
    if (node) setReaderVisualActive(node.dataset.readerVisualId, { hover: true, captionId: node.dataset.readerCaptionId });
    else if (event.target?.closest?.("[data-sentence-id]")) clearReaderVisualHover();
  };
  const leave = (event) => {
    if (!target(event)) return;
    const related = event.relatedTarget?.closest?.("[data-reader-visual-id]");
    if (related && container.contains(related)) {
      setReaderVisualActive(related.dataset.readerVisualId, { hover: true, captionId: related.dataset.readerCaptionId });
    } else {
      readerVisualState.hovered = null;
      applyReaderVisualActive();
    }
  };
  const click = (event) => {
    const node = target(event);
    if (!node) return;
    const enlarge = event.target?.closest?.("[data-reader-visual-enlarge]");
    if (enlarge) { openReaderVisualLarge(enlarge.dataset.readerVisualEnlarge); return; }
    if (event.target?.closest?.("button,a,input,select,textarea") && !node.classList.contains("reader-visual-region")) return;
    setReaderVisualActive(node.dataset.readerVisualId, { captionId: node.dataset.readerCaptionId, scrollText: true, scrollImage: true });
  };
  container.addEventListener("pointerover", hover);
  container.addEventListener("pointerout", leave);
  container.addEventListener("focusin", hover);
  container.addEventListener("focusout", leave);
  container.addEventListener("click", click);
  container.addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key) && target(event) && !event.target.closest?.("button,a,input,select,textarea")) {
      event.preventDefault(); click(event);
    }
  });
}

/* Optional extraction backfill. All requests and refreshes are scoped to the selected page and source image. */
const readerVisualExtractionJobs = new Map();

function readerVisualExtractionKey(item, page) {
  return JSON.stringify([typeof currentUser === "undefined" ? "" : currentUser?.id,
    item?.id, page?.id, page?.processingRevision, page?.imageHash, getPageImageSource(page)]);
}

function updateReaderVisualExtractionStatus(job) {
  const labels = { queued: "图表提取已排队…", running: "正在提取本页图表…", completed: "图表提取完成", failed: "图表提取失败" };
  for (const node of document.querySelectorAll("[data-reader-extraction-key]")) {
    if (node.dataset.readerExtractionKey !== job.key) continue;
    const button = node.querySelector("button"), status = node.querySelector("[role=\"status\"]");
    if (button) {
      button.disabled = Boolean(job.promise);
      button.textContent = job.status === "completed" && !job.refreshed ? "刷新本页图表" : "补提取本页图表";
    }
    if (status) status.textContent = job.error || (job.status === "completed" && !job.refreshed ? "提取完成，保存文字后可刷新图表" : labels[job.status] || "");
  }
}

function createReaderVisualBackfill(item, page, content) {
  if (!item?.id || !page?.id || typeof canEditDocument !== "function" || !canEditDocument(item) ||
      (content ? content.layoutStatus !== "layout_unavailable" : page.visualsExtracted === true)) return null;
  const key = readerVisualExtractionKey(item, page);
  const node = readerVisualElement("div", "reader-visual-backfill");
  node.dataset.readerAuxiliary = "true";
  node.dataset.readerExtractionKey = key;
  const button = readerVisualElement("button", "", "补提取本页图表");
  button.type = "button";
  const status = readerVisualElement("span", "reader-visual-extraction-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const job = readerVisualExtractionJobs.get(key);
  if (job) {
    button.disabled = Boolean(job.promise);
    if (job.status === "completed" && !job.refreshed) button.textContent = "刷新本页图表";
    status.textContent = job.error || ({ queued: "图表提取已排队…", running: "正在提取本页图表…", completed: "图表提取完成", failed: "图表提取失败" })[job.status] || "";
  }
  button.addEventListener("click", () => requestReaderVisualExtraction(item, page));
  node.append(button, status);
  return node;
}

function readerVisualExtractionCurrent(job) {
  const item = typeof getSelectedDocument === "function" ? getSelectedDocument() : null;
  const page = typeof getSelectedPage === "function" ? getSelectedPage() : null;
  return item && page && readerVisualExtractionKey(item, page) === job.key;
}

async function refreshReaderVisualExtraction(job) {
  if (!readerVisualExtractionCurrent(job) || (typeof readerEditing !== "undefined" && readerEditing)) return false;
  if (typeof flushPendingSync === "function") await flushPendingSync();
  if ((typeof syncDirty !== "undefined" && syncDirty) || !readerVisualExtractionCurrent(job) ||
      (typeof readerEditing !== "undefined" && readerEditing)) return false;
  // syncFromServer normalizes the replacement page and preserves server-owned processing fields.
  const beforeItem = getSelectedDocument(), beforePage = getSelectedPage();
  if (typeof syncFromServer === "function") await syncFromServer({ render: false });
  const item = getSelectedDocument(), page = getSelectedPage();
  if (item?.id !== beforeItem?.id || page?.id !== beforePage?.id || page?.imageHash !== beforePage?.imageHash ||
      (typeof readerEditing !== "undefined" && readerEditing)) return false;
  // Backfill can leave processingRevision unchanged. Explicitly evict content and catalogue snapshots.
  readerContentCache.delete(getReaderContentKey(item, page));
  if (typeof readerVisualCatalogCache !== "undefined") readerVisualCatalogCache.clear();
  job.refreshed = true;
  if (typeof renderReader === "function") renderReader();
  if (typeof syncReaderVisualCatalog === "function") await syncReaderVisualCatalog(item);
  return true;
}

async function requestReaderVisualExtraction(item, page) {
  if (!item?.id || !page?.id || typeof canEditDocument !== "function" || !canEditDocument(item)) return false;
  const key = readerVisualExtractionKey(item, page);
  let job = readerVisualExtractionJobs.get(key);
  if (job?.promise) return job.promise;
  if (!job) {
    job = { key, status: "idle", error: "", promise: null, refreshed: false };
    readerVisualExtractionJobs.set(key, job);
    // Retain in-flight jobs; only evict settled history.
    for (const [oldKey, old] of readerVisualExtractionJobs) {
      if (readerVisualExtractionJobs.size <= 12) break;
      if (!old.promise && oldKey !== key) readerVisualExtractionJobs.delete(oldKey);
    }
  }
  if (!readerVisualExtractionCurrent(job)) return false;
  const url = DATA_PROCESSING_URL + "/" + encodeURIComponent(item.id) + "/pages/" + encodeURIComponent(page.id) + "/extract-visuals";
  job.error = "";
  job.promise = (async () => {
    await Promise.resolve();
    try {
      if (job.status === "completed") return await refreshReaderVisualExtraction(job);
      if (!["queued", "running"].includes(job.status)) {
        if (typeof readerEditing !== "undefined" && readerEditing) throw new Error("请先保存当前页的修改");
        if (typeof flushPendingSync === "function") await flushPendingSync();
        if (!readerVisualExtractionCurrent(job)) return false;
        if (typeof syncDirty !== "undefined" && syncDirty) throw new Error("请先保存当前页的修改");
        const response = await fetch(url, { method: "POST" });
        if (!response.ok) throw new Error("图表补提取提交失败，请重试");
        const result = await response.json();
        job.status = result.status;
      }
      for (let attempt = 0; attempt < 600; attempt++) {
        if (!readerVisualExtractionCurrent(job)) return false;
        updateReaderVisualExtractionStatus(job);
        if (job.status === "completed") return await refreshReaderVisualExtraction(job);
        if (job.status === "failed") throw new Error(job.error || "图表提取失败，请重试");
        if (!["queued", "running"].includes(job.status)) throw new Error("图表提取状态不可用，请重试");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!readerVisualExtractionCurrent(job)) return false;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error("图表提取进度加载失败，请重试");
        const result = await response.json();
        job.status = result.status;
        job.error = result.error || "";
      }
      throw new Error("图表提取仍在处理中，请稍后重试");
    } catch (error) {
      job.status = "failed";
      job.error = error.message || "图表提取失败，请重试";
      return false;
    } finally {
      job.promise = null;
      updateReaderVisualExtractionStatus(job);
    }
  })();
  updateReaderVisualExtractionStatus(job);
  return job.promise;
}
