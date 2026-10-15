// Global simplified/traditional switching. OCR and user-entered text may use either form.
// All visible text is converted to the current target variant and dynamic content is
// converted incrementally by the MutationObserver.
(() => {
  const SIMPLIFIED = "simplified";
  const TRADITIONAL = "traditional";
  const CONVERTED_ATTRS = ["placeholder", "title", "aria-label"];
  const SKIP_SELECTOR = "script, style, noscript, [data-variant-skip]";
  const MAX_BATCH = 4000;
  const TRADITIONAL_ALIASES = new Set(["traditional", "t", "hant", "zh-hant", "zh-tw", "zh-hk", "tw", "hk"]);

  const convertedByVariant = new Map(); // target variant -> (raw text -> converted text)

  function convertedFor(variant) {
    let converted = convertedByVariant.get(variant);
    if (!converted) {
      converted = new Map();
      convertedByVariant.set(variant, converted);
    }
    return converted;
  }
  const textOrigins = new WeakMap();  // Text -> 原文
  const textApplied = new WeakMap();  // Text -> 我最后写入的值（用于忽略自身写入）
  const attrOrigins = new WeakMap();  // Element -> { attr: 原文 }
  const attrApplied = new WeakMap();  // Element -> { attr: 我最后写入的值 }
  const trackedText = new Set();
  const trackedElements = new Set();

  let current = SIMPLIFIED;
  let titleOrigin = null;
  let titleApplied = null;
  let pendingText = new Set();
  let pendingElements = new Set();
  let running = false;
  let scheduled = false;
  let observer = null;

  function normalize(value) {
    const key = String(value == null ? "" : value).trim().toLowerCase();
    return TRADITIONAL_ALIASES.has(key) ? TRADITIONAL : SIMPLIFIED;
  }

  function applyText(node) {
    const raw = textOrigins.get(node);
    if (raw == null) return;
    const target = convertedFor(current).get(raw);
    if (target == null || node.data === target) return;
    textApplied.set(node, target);
    node.data = target;
  }

  function applyAttrs(element) {
    const origins = attrOrigins.get(element);
    if (!origins) return;
    const applied = attrApplied.get(element) || {};
    CONVERTED_ATTRS.forEach((attr) => {
      const raw = origins[attr];
      if (raw == null) return;
      const target = convertedFor(current).get(raw);
      if (target == null || element.getAttribute(attr) === target) return;
      applied[attr] = target;
      element.setAttribute(attr, target);
    });
    attrApplied.set(element, applied);
  }

  function applyTitle() {
    if (document.title !== titleApplied) {
      // 标题被外部改动，视为新的原文
      titleOrigin = document.title;
    }
    if (titleOrigin == null) return;
    const target = convertedFor(current).get(titleOrigin);
    if (target == null || document.title === target) return;
    titleApplied = target;
    document.title = target;
  }

  function registerText(node) {
    if (textOrigins.has(node)) return;
    const parent = node.parentElement;
    if (parent && parent.closest(SKIP_SELECTOR)) return;
    textOrigins.set(node, node.data);
    trackedText.add(node);
    queueText(node);
  }

  function registerElement(element) {
    if (element.closest(SKIP_SELECTOR)) return;
    const origins = attrOrigins.get(element) || {};
    let changed = false;
    CONVERTED_ATTRS.forEach((attr) => {
      if (origins[attr] != null) return;
      const value = element.getAttribute(attr);
      if (value) {
        origins[attr] = value;
        changed = true;
      }
    });
    if (!changed) return;
    attrOrigins.set(element, origins);
    trackedElements.add(element);
    queueAttr(element);
  }

  function scan(node) {
    if (!node) return;
    const type = node.nodeType;
    if (type === 3) {
      registerText(node);
      return;
    }
    if (type === 11) {
      node.childNodes.forEach(scan);
      return;
    }
    if (type !== 1) return;
    if (node.matches(SKIP_SELECTOR)) return;
    registerElement(node);
    node.querySelectorAll("[placeholder],[title],[aria-label]").forEach(registerElement);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        const parent = textNode.parentElement;
        if (!parent || parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let textNode;
    while ((textNode = walker.nextNode())) registerText(textNode);
  }

  function queueText(node) {
    pendingText.add(node);
    scheduleFlush();
  }

  function queueAttr(element) {
    pendingElements.add(element);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (scheduled || running) return;
    scheduled = true;
    window.setTimeout(run, 0);
  }

  async function fetchConverted(variant, raws) {
    const list = [...raws];
    const converted = convertedFor(variant);
    for (let index = 0; index < list.length; index += MAX_BATCH) {
      const chunk = list.slice(index, index + MAX_BATCH);
      const response = await fetch(VARIANT_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant, texts: chunk }),
      });
      if (!response.ok) throw new Error(`variant convert failed: ${response.status}`);
      const data = await response.json();
      const output = Array.isArray(data?.texts) ? data.texts : [];
      chunk.forEach((raw, i) => {
        if (typeof output[i] === "string") converted.set(raw, output[i]);
      });
    }
  }

  // 供导出等非 DOM 场景使用：按当前简繁体批量转换文本，复用同一份缓存与接口。
  async function convertTexts(texts) {
    const list = texts.map((text) => (text == null ? "" : String(text)));
    const converted = convertedFor(current);
    const raws = new Set(list.filter((text) => text && !converted.has(text)));
    if (raws.size) {
      try {
        await fetchConverted(current, raws);
      } catch (error) {
        console.warn("简繁转换请求失败，保留原文", error);
      }
    }
    return list.map((text) => (converted.has(text) ? converted.get(text) : text));
  }

  window.convertVariantTexts = convertTexts;

  async function flush() {
    const targetVariant = current;
    const converted = convertedFor(targetVariant);
    const nodes = [...pendingText];
    const elements = [...pendingElements];
    pendingText = new Set();
    pendingElements = new Set();

    const raws = new Set();
    nodes.forEach((node) => {
      const raw = textOrigins.get(node);
      if (raw && !converted.has(raw)) raws.add(raw);
    });
    elements.forEach((element) => {
      const origins = attrOrigins.get(element);
      if (!origins) return;
      CONVERTED_ATTRS.forEach((attr) => {
        const raw = origins[attr];
        if (raw && !converted.has(raw)) raws.add(raw);
      });
    });
    if (titleOrigin && !converted.has(titleOrigin)) raws.add(titleOrigin);

    if (raws.size) {
      try {
        await fetchConverted(targetVariant, raws);
      } catch (error) {
        console.warn("简繁转换请求失败，保留原文", error);
      }
    }

    nodes.forEach(applyText);
    elements.forEach(applyAttrs);
    applyTitle();
  }

  async function run() {
    scheduled = false;
    if (running) return;
    running = true;
    try {
      await flush();
    } catch (error) {
      console.warn("简繁转换失败", error);
    }
    running = false;
    if (pendingText.size || pendingElements.size) scheduleFlush();
  }

  function applyAll() {
    trackedText.forEach(applyText);
    trackedElements.forEach(applyAttrs);
    applyTitle();
  }

  function updateButtons() {
    variantOptionButtons.forEach((button) => {
      const isActive = normalize(button.dataset.variantOption) === current;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
  }

  function setVariant(value, persist = true) {
    current = normalize(value);
    if (persist) localStorage.setItem(VARIANT_STORAGE_KEY, current);
    updateButtons();
    trackedText.forEach(queueText);
    trackedElements.forEach(queueAttr);
    applyAll();
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === "characterData") {
          const node = record.target;
          if (textApplied.get(node) === node.data) return; // 自身写入
          textOrigins.set(node, node.data);
          trackedText.add(node);
          queueText(node);
        } else if (record.type === "attributes") {
          const element = record.target;
          const attr = record.attributeName;
          const applied = attrApplied.get(element);
          const value = element.getAttribute(attr) || "";
          if (applied && applied[attr] === value) return; // 自身写入
          const origins = attrOrigins.get(element) || {};
          origins[attr] = value;
          attrOrigins.set(element, origins);
          trackedElements.add(element);
          queueAttr(element);
        } else if (record.type === "childList") {
          record.addedNodes.forEach(scan);
        }
      });
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: CONVERTED_ATTRS,
    });
  }

  function boot() {
    titleOrigin = document.title;
    current = normalize(localStorage.getItem(VARIANT_STORAGE_KEY));
    updateButtons();
    scan(document.body);
    startObserver();
    trackedText.forEach(queueText);
    trackedElements.forEach(queueAttr);
  }

  variantOptionButtons.forEach((button) => {
    button.addEventListener("click", () => setVariant(button.dataset.variantOption));
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
