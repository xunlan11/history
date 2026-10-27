/* 阅览器增强内容是可选的：载荷无效或过期时，仍由父级的纯文本渲染负责。 */
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

// 同步 SHA-256 在非安全上下文也可用，因此直接渲染与加载走同一套校验。
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
          visual.renderMode !== "image" ||
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
  if (visual.kind === "caption") {
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
      figure.classList.add("is-zoomable");
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

// 句子文本常把上一自然段结尾的换行一起包进来；这些空白若留在高亮节点里，
// 会在上一段末尾和空行上画出小色块，所以拆成普通文本节点，只高亮正文。
function splitSentenceEdges(text) {
  const value = String(text ?? "");
  const leading = value.match(/^\s*/)[0];
  const rest = value.slice(leading.length);
  const trailing = rest.match(/\s*$/)[0];
  return { leading, body: rest.slice(0, rest.length - trailing.length), trailing };
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
      const { leading, body, trailing } = splitSentenceEdges(content.displayedText.slice(start, end));
      if (leading) fragment.append(leading);
      if (body) {
        const span = readerVisualElement("span", index ? "reader-sentence" : "reader-content-text", body);
        span.dataset.readerTextStart = String(start + leading.length);
        span.dataset.readerTextEnd = String(end - trailing.length);
        if (index) { span.dataset.sentenceId = slice.id; span.tabIndex = 0; }
        fragment.append(span);
      }
      if (trailing) fragment.append(trailing);
    }
  }
  for (const message of content.warnings || []) {
    const warning = readerVisualElement("p", "reader-visual-placement-status", message);
    warning.dataset.readerAuxiliary = "true";
    fragment.append(warning);
  }
  const key = JSON.stringify([getSelectedDocument()?.id, page.id, page.processingRevision]);
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
  applyReaderSearchHighlights(page);
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

// 父级选中句子会清除视觉选中；临时悬停只清除视觉悬停。
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
  renderReaderVisualCatalog();
}

function setReaderVisualActive(id, options = {}) {
  readerVisualState.sentenceActive = false;
  const selected = readerVisualState.selected;
  if (id) setReaderLinkActive(null);
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
    scrollReaderRegionIntoView(node, container);
  };
  if (!options.hover && options.scrollImage && readerPanelState.originalCollapsed) toggleReaderPanel("original");
  if (!options.hover && options.scrollText) scroll(readerText);
  if (!options.hover && options.scrollImage) scroll(readerOriginalPreview);
}

// 大图视图按原图 2.5 倍展示（不超过视口），比页内嵌图明显更大。
const READER_VISUAL_LARGE_SCALE = 2.5;

function scaleReaderVisualLarge(image) {
  const natural = Number(image.naturalWidth) || 0;
  if (!natural) return;
  const viewport = Number(document.documentElement?.clientWidth) || Number(globalThis.innerWidth) || 1200;
  const available = Math.max(320, viewport * 0.94 - 80);
  image.style.width = `${Math.round(Math.min(natural * READER_VISUAL_LARGE_SCALE, available))}px`;
  image.style.height = "auto";
  image.style.maxWidth = "none";
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
  dialog.append(close, copy);
  const largeImage = copy.querySelector("img");
  if (largeImage) {
    largeImage.loading = "eager";
    if (largeImage.complete && largeImage.naturalWidth) scaleReaderVisualLarge(largeImage);
    else largeImage.addEventListener("load", () => scaleReaderVisualLarge(largeImage), { once: true });
  }
  const restore = () => { dialog.remove(); figure.focus(); };
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
    if (event.target?.closest?.("button,a,input,select,textarea") && !node.classList.contains("reader-visual-region")) return;
    // 图表本体（含图片）单击即看大图；题注仍走选中/定位。
    if (!node.dataset.readerCaptionId && node.querySelector("img")) {
      openReaderVisualLarge(node.dataset.readerVisualId);
      return;
    }
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
