/* 共享检索与 Unicode 来源锚点。在 core/auth 之后加载。 */
const RETRIEVAL_LEVEL_LABELS = { exact: "严格匹配", partial: "部分匹配", semantic: "嵌入匹配" };

async function retrievalJson(path, body) {
  const response = await fetch(endpoint("/data/api/retrieval/" + path), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof result.detail === "string" ? result.detail : `材料检索失败（${response.status}）`);
  }
  return result;
}

function fetchRetrievalEvidence(request) {
  return retrievalJson("query", request);
}

async function validateFrozenEvidence(request) {
  const library = (request.body.evidence || []).filter((e) => e.sourceType === "document-page");
  if (!library.length) return request;
  const allowed = new Set();
  const warnings = [...(request.warnings || [])];
  // 接口每次最多接受 200 个定位；所有命中仍会逐一校验。
  for (let offset = 0; offset < library.length; offset += 200) {
    const result = await retrievalJson("validate", {
      evidence: library.slice(offset, offset + 200).map(({chunkId, documentId, pageId, sourceLayer, sourceHash}) =>
        ({chunkId, documentId, pageId, sourceLayer, sourceHash})),
    });
    for (const id of result.allowedChunkIds) allowed.add(id);
    warnings.push(...(result.warnings || []));
  }
  request.body.evidence = request.body.evidence.filter((e) => e.sourceType === "conversation-file" || allowed.has(e.chunkId));
  request.sourceDocumentIds = [...new Set(request.body.evidence.filter((e) => e.sourceType === "document-page").map((e) => e.documentId))];
  request.warnings = [...new Set(warnings)];
  return request;
}

// 编年使用有界附件上下文；检索/对话在服务端匹配。
function attachmentEvidence(query, conversation) {
  return buildConversationAttachmentDocumentsForLlm(query, 8, 500, conversation).flatMap((item) => item.pages.map((page) => ({
    chunkId: `attachment:${item.attachmentId}:${page.pageNumber}`,
    sourceType: "conversation-file", attachmentId: item.attachmentId, documentId: item.documentId,
    title: item.title, author: item.author, year: item.year, pageId: page.pageId || "",
    pageNumber: page.pageNumber, text: page.text,
  })));
}

function mergeRetrievalMaterials(library, attachments) {
  // 交错排列，避免某一类材料总被提示词预算挤掉。
  const evidence = [];
  for (let i = 0; i < Math.max(library.length, attachments.length); i += 1) {
    if (library[i]) evidence.push(library[i]);
    if (attachments[i]) evidence.push(attachments[i]);
  }
  return evidence;
}

function buildEvidenceHref(evidence) {
  const params = new URLSearchParams({ document: evidence.documentId, page: evidence.pageId });
  for (const key of ["sourceLayer", "sourceHash", "start", "end"]) {
    if (evidence[key] !== undefined) params.set(key, String(evidence[key]));
  }
  return `reader.html?${params.toString()}`;
}

// 内网可能通过明文 HTTP 访问阅览器，此时没有 WebCrypto；
// 该兜底只对本地文本做哈希，不用于身份认证。
function sha256EvidenceBytes(bytes) {
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const buffer = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(buffer.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(buffer.length - 4, bytes.length * 8);
  const rotate = (value, n) => (value >>> n) | (value << (32 - n));
  for (let offset = 0; offset < buffer.length; offset += 64) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) >>> 0;
      const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((value, i) => {hash[i] = (hash[i] + value) >>> 0;});
  }
  return hash.map((value) => value.toString(16).padStart(8,"0")).join("");
}

async function hashEvidenceText(text) {
  const bytes = new TextEncoder().encode(text);
  if (!globalThis.crypto?.subtle) return sha256EvidenceBytes(bytes);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getReaderVisualSource(page, layer) {
  if (!page || typeof layer !== "string") return null;
  const parts = layer.split(":");
  if (parts.length !== 3 || parts[0] !== "visual_caption") return null;
  let visualId, itemId;
  try {
    [visualId, itemId] = parts.slice(1).map(decodeURIComponent);
    // Python 的 quote(..., safe="") 还会转义 encodeURIComponent 未处理的字符。
    const encode = (id) => encodeURIComponent(id).replace(/[!'()*]/g,
      (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
    if (!visualId || !itemId || encode(visualId) !== parts[1] || encode(itemId) !== parts[2]) return null;
  } catch { return null; }
  const cached = page?.visuals == null && typeof getCachedReaderContent === "function" &&
    typeof getSelectedDocument === "function" ? getCachedReaderContent(getSelectedDocument(), page) : null;
  const catalog = page?.visuals ?? cached?.visuals;
  const visuals = Array.isArray(catalog) ? catalog : catalog && typeof catalog === "object" ? Object.values(catalog) : [];
  const visual = visuals.find((entry) => entry?.id === visualId);
  const entries = visual?.captions;
  const item = Array.isArray(entries) ? entries.find((entry) => entry?.id === itemId) : null;
  if (typeof item?.text !== "string" || !item.text.trim()) return null;
  return { text: item.text, visualId, captionId: itemId };
}

async function resolveEvidenceAnchor(page, locator) {
  const layer = locator.sourceLayer;
  const visual = getReaderVisualSource(page, layer);
  if (!visual && !["ocrText", "punctuatedText", "notes"].includes(layer)) return { status: "missing" };
  const text = visual ? visual.text : typeof page?.[layer] === "string" ? page[layer] : "";
  if (await hashEvidenceText(text) !== locator.sourceHash) return { status: "stale", sourceLayer: layer };
  const start = Number(locator.start), end = Number(locator.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > Array.from(text).length) return { status: "missing" };
  return { status: "ready", start, end, sourceLayer: layer, ...(visual || {}) };
}

let evidenceRenderRevision = 0;

function getReaderEvidenceBodyText() {
  return typeof getReaderTextNodes === "function"
    ? getReaderTextNodes(readerText).map(({ node }) => node.textContent).join("") : readerText.textContent;
}

function markEvidenceRange(container, start, end) {
  const body = typeof readerText !== "undefined" && container === readerText && typeof getReaderTextNodes === "function";
  const nodes = body ? getReaderTextNodes(container) : [];
  if (!body) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let position = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      nodes.push({ node, start: position, end: position + node.textContent.length });
      position += node.textContent.length;
    }
  }
  const points = Array.from(nodes.map(({ node }) => node.textContent).join(""));
  const from = points.slice(0, start).join("").length, to = points.slice(0, end).join("").length;
  let first = null;
  for (const item of nodes) {
    if (item.start >= to || item.end <= from) continue;
    item.node.splitText(Math.min(item.end, to) - item.start);
    const selected = item.node.splitText(Math.max(item.start, from) - item.start);
    const mark = document.createElement("mark");
    mark.className = "retrieval-highlight";
    selected.replaceWith(mark);
    mark.append(selected);
    first ||= mark;
  }
  return first;
}

// 把引用片段（层内偏移）映射到正文句子：同层直接用偏移，跨层退回按文本查找。
// 引用偏移是 Unicode 码点，句子偏移是 UTF-16，需要换算。
function evidenceSentence(displayed, source, start, end, sentences) {
  if (source === displayed) {
    const points = Array.from(displayed);
    const from = points.slice(0, start).join("").length;
    const to = points.slice(0, end).join("").length;
    return sentences.find((sentence) => sentence.end > from && sentence.start < to);
  }
  const needle = Array.from(source || "").slice(start, end).join("");
  const found = needle ? displayed.indexOf(needle) : -1;
  return found < 0 ? undefined
    : sentences.find((sentence) => sentence.end > found && sentence.start < found + needle.length);
}

async function showReaderEvidence(page, readerIndex = null) {
  const revision = ++evidenceRenderRevision;
  document.querySelector(".reader-evidence-status")?.remove();
  const href = window.location.href, params = new URL(href).searchParams;
  const item = getSelectedDocument();
  if (!params.has("sourceHash") || params.get("page") !== page?.id || params.get("document") !== item?.id || readerEditing) return;
  const current = () => revision === evidenceRenderRevision && !readerEditing && window.location.href === href &&
    getSelectedDocument()?.id === item.id && getSelectedPage()?.id === page.id;
  const locator = Object.fromEntries(["sourceLayer", "sourceHash", "start", "end"].map((key) => [key, params.get(key)]));
  let anchor;
  try {
    let loaded = true;
    if (/^visual_caption:/.test(locator.sourceLayer) && typeof loadReaderContent === "function") {
      loaded = await loadReaderContent(item, page);
      if (!current()) return;
    }
    const currentPage = getSelectedPage();
    anchor = loaded ? await resolveEvidenceAnchor(currentPage, locator) : { status: "missing" };
  } catch { anchor = { status: "missing" }; }
  if (!current()) return;
  const panel = document.createElement("section");
  panel.className = "reader-evidence-status";
  panel.setAttribute("aria-label", "引用定位");
  readerText.before(panel);
  if (anchor.status !== "ready") {
    setReaderCitationSentence("");
    panel.textContent = anchor.status === "stale" ? "原文已更新，先前引用位置已失效。" : "无法定位片段，已打开来源页。";
    return;
  }
  const labels = { ocrText: "OCR 原文", punctuatedText: "整理正文", notes: "笔记" };
  const visualLabel = anchor.captionId ? "图注" : "";
  const label = document.createElement("p");
  label.className = "meta-line";
  label.textContent = "引用来自：" + (visualLabel || labels[anchor.sourceLayer] || anchor.sourceLayer);
  panel.append(label);
  if (anchor.visualId) {
    setReaderCitationSentence("");
    if (typeof setReaderVisualActive === "function") setReaderVisualActive(anchor.visualId,
      { captionId: anchor.captionId, scrollText: true, scrollImage: true });
    return;
  }
  // 高亮与「选中句子」一致：正文句子与原文区域一起高亮；悬停其它句子会临时改变高亮。
  const sentences = readerIndex?.sentences?.length ? readerIndex.sentences : null;
  const sentence = sentences
    ? evidenceSentence(getPagePrimaryText(page), page[anchor.sourceLayer], anchor.start, anchor.end, sentences) : null;
  if (sentence) {
    setReaderCitationSentence(sentence.id);
    return;
  }
  setReaderCitationSentence("");
  // 有句子索引却定位不到该片段时不画按字符的黄块，避免与选中高亮混淆。
  if (sentences) return;
  // 没有句子索引（未校对/索引未就绪）时，退回按字符高亮。
  const source = page[anchor.sourceLayer];
  let mark;
  if (source === getPagePrimaryText(page) && getReaderEvidenceBodyText() === source) {
    mark = markEvidenceRange(readerText, anchor.start, anchor.end);
    mark?.setAttribute("data-variant-skip", "");
  } else {
    // OCR/笔记中的命中可能属于与当前正文不同的层。
    const target = document.createElement("div");
    target.className = "reader-evidence-text";
    target.setAttribute("data-variant-skip", "");
    target.textContent = source;
    panel.append(target);
    mark = markEvidenceRange(target, anchor.start, anchor.end);
  }
  mark?.scrollIntoView({ block: "center" });
}
