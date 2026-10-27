const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

class FakeNode {
  constructor(tag, ownerDocument, type = 1) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.nodeType = type;
    this.childNodes = []; this.parentNode = null; this.dataset = {}; this.attributes = {};
    this.style = {}; this.listeners = {}; this._classes = new Set(); this.nodeValue = type === 3 ? tag : null;
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => { const on = force ?? !this._classes.has(name); on ? this._classes.add(name) : this._classes.delete(name); return on; },
    };
  }
  set className(value) { this._classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set id(value) { this.attributes.id = value; }
  get id() { return this.attributes.id || ''; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  set src(value) { this.setAttribute('src', value); }
  get src() { return this.getAttribute('src'); }
  set textContent(value) {
    if (this.nodeType === 3) { this.nodeValue = String(value); return; }
    this.replaceChildren();
    if (String(value)) this.append(this.ownerDocument.createTextNode(String(value)));
  }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((node) => node.textContent).join(''); }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] ?? null;
    if (name === 'class') return this.className;
    return this.attributes[name] ?? null;
  }
  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = String(value);
    else if (name === 'class') this.className = value;
    else this.attributes[name] = String(value);
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node === 'string') node = this.ownerDocument.createTextNode(node);
      if (node.nodeType === 11) { this.append(...node.childNodes.slice()); continue; }
      node.remove(); this.childNodes.push(node); node.parentNode = this;
    }
  }
  replaceChildren(...nodes) { for (const node of this.childNodes) node.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this); this.parentNode = null; }
  replaceWith(node) { const parent = this.parentNode, index = parent.childNodes.indexOf(this); this.remove(); parent.childNodes.splice(index, 0, node); node.parentNode = parent; }
  insertBefore(node, reference) {
    if (typeof node === 'string') node = this.ownerDocument.createTextNode(node);
    node.remove();
    const index = this.childNodes.indexOf(reference);
    if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
  matches(selector) {
    return selector.split(',').some((part) => {
      part = part.trim();
      if (part.startsWith('#')) return this.id === part.slice(1);
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      if (part.startsWith('[')) {
        const [, name, value] = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) || [];
        return name && (value === undefined ? this.hasAttribute(name) : this.getAttribute(name) === value);
      }
      return this.tagName === part.toUpperCase();
    });
  }
  closest(selector) { if (this.nodeType === 1 && this.matches(selector)) return this; return this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) {
    const parts = selector.split(/\s+/);
    const found = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1 && child.matches(parts.at(-1))) {
          let ancestor = child.parentNode, i = parts.length - 2;
          while (i >= 0 && ancestor) { if (ancestor.matches(parts[i])) i--; ancestor = ancestor.parentNode; }
          if (i < 0) found.push(child);
        }
        walk(child);
      }
    };
    walk(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, callback, options = {}) { (this.listeners[type] ||= []).push({ callback, once: options.once }); }
  dispatch(type, details = {}) {
    const event = { type, target: this, preventDefault() { this.defaultPrevented = true; }, ...details };
    for (let node = this; node; node = node.parentNode) {
      for (const listener of [...(node.listeners[type] || [])]) {
        listener.callback(event);
        if (listener.once) node.listeners[type] = node.listeners[type].filter((item) => item !== listener);
      }
    }
    return event;
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrolled = (this.scrolled || 0) + 1; }
  cloneNode(deep) {
    const copy = new FakeNode(this.nodeType === 3 ? this.nodeValue : this.tagName, this.ownerDocument, this.nodeType);
    copy.attributes = { ...this.attributes }; copy.dataset = { ...this.dataset }; copy.className = this.className;
    if (deep) for (const child of this.childNodes) copy.append(child.cloneNode(true));
    return copy;
  }
}
class FakeDocument extends FakeNode {
  constructor() { super('#document', null, 9); this.ownerDocument = this; this.baseURI = 'https://reader.example/'; this.body = this.createElement('body'); this.append(this.body); }
  createElement(tag) { return new FakeNode(tag, this); }
  createElementNS(namespace, tag) { return this.createElement(tag); }
  createTextNode(text) { return new FakeNode(text, this, 3); }
  createDocumentFragment() { return new FakeNode('#fragment', this, 11); }
}
const digest = (text) => createHash('sha256').update(text).digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value));
// getReaderTextNodes 现已合并进 reader.js，用标记注释截取该片段再注入沙箱。
function readerTextDomSource() {
  const source = fs.readFileSync('js/reader.js', 'utf8');
  const start = source.indexOf('/* reader-text-dom:start */');
  const end = source.indexOf('/* reader-text-dom:end */');
  if (start < 0 || end < start) throw new Error('reader.js missing reader-text-dom block');
  return source.slice(start, end);
}
function fixture() {
  const page = { id: 'p/1', pageNumber: 4, processingRevision: 7, imageHash: 'image-hash', imageUrl: '/original.png', text: 'A😀B\nC' };
  const item = { id: 'doc/1', pages: [page] };
  const content = { version: 1, sourceRevision: 7, displayedText: page.text, textHash: digest(page.text), imageHash: page.imageHash,
    items: [{ type: 'text', start: 0, end: 3 }, { type: 'visual', visualId: 'v1', placement: 'inline' }, { type: 'text', start: 3, end: 6 }],
    visuals: { v1: { id: 'v1', kind: 'table', renderMode: 'image', status: 'ready', url: '/visual.png', width: 90, height: 95,
      captions: [{ id: 'cap', text: 'A separate caption', position: 'after', sourceRegions: [{ bbox: [5, 110, 95, 125] }] }],
      sourceImageHash: page.imageHash, sourceImageWidth: 100, sourceImageHeight: 200, geometryStatus: 'exact',
      sourceRegions: [{ bbox: [5, 5, 95, 100] }] } }, warnings: [], layoutStatus: 'ready' };
  return { item, page, content };
}
function setup(overrides = {}) {
  const data = fixture(), document = new FakeDocument();
  const readerText = document.createElement('div'), readerOriginalPreview = document.createElement('div');
  document.body.append(readerText, readerOriginalPreview);
  const c = vm.createContext({ console, TextEncoder, URL, setTimeout, clearTimeout, document, readerText, readerOriginalPreview,
    readerEditing: false, selectedPageId: data.page.id, DATA_PROCESSING_URL: '/api/documents', currentUser: { id: 'u' },
    getSelectedDocument: () => data.item, getSelectedPage: () => data.item.pages.find((page) => page.id === c.selectedPageId),
    getPagePrimaryText: (page) => page?.text || '', getPageImageSource: (page) => page?.imageUrl || '',
    applyReaderSearchHighlights: () => {}, renderReaderVisualCatalog: () => {}, setReaderLinkActive: () => {},
    scrollReaderRegionIntoView: () => {}, toggleReaderPanel: () => {}, readerPanelState: {},
    getCachedReaderIndex: () => null, syncSelectionToUrl: () => {}, flushPendingSync: async () => {},
    syncDirty: false,
    fetch: async () => ({ ok: true, json: async () => data.content }), ...overrides });
  vm.runInContext(readerTextDomSource(), c);
  vm.runInContext(fs.readFileSync('js/reader-content.js', 'utf8'), c);
  return { ...data, c, document, readerText, readerOriginalPreview };
}
function addImage(env, width = 100, height = 200) {
  const frame = env.document.createElement('div'); frame.className = 'reader-image-frame';
  const image = env.document.createElement('img'); image.src = env.page.imageUrl;
  image.naturalWidth = width; image.naturalHeight = height; image.complete = true;
  frame.append(image); env.readerOriginalPreview.append(frame); return image;
}
module.exports = { FakeNode, FakeDocument, fixture, setup, addImage, digest, plain };

if (require.main === module) {
  test('SHA-256 matches node crypto for empty, non-BMP, long and unpaired UTF-16 text', () => {
    const { c } = setup();
    for (const text of ['', 'abc', 'A😀B\nC', '文'.repeat(100), '\uD800']) assert.equal(c.hashReaderContentText(text), digest(text));
  });
  test('rendering preserves exact UTF-16 text offsets and sentence IDs around auxiliary tables', () => {
    const { c, page, content, readerText } = setup();
    const index = { sourceRevision: 7, displayedText: page.text, sentences: [
      { id: 's1', start: 0, end: 4, text: 'A😀B' }, { id: 's2', start: 4, end: 6, text: '\nC' }] };
    assert.equal(c.renderReaderContent(page, content, index), true);
    const nodes = c.getReaderTextNodes(readerText);
    assert.deepEqual(plain(nodes.map(({ start, end }) => ({ start, end }))), [{ start: 0, end: 3 }, { start: 3, end: 4 }, { start: 4, end: 5 }, { start: 5, end: 6 }]);
    assert.equal(nodes.map(({ node }) => node.nodeValue).join(''), page.text);
    assert.deepEqual(readerText.querySelectorAll('[data-sentence-id]').map((node) => node.dataset.sentenceId), ['s1', 's1', 's2']);
    assert.equal(readerText.querySelector('img').getAttribute('src'), 'https://reader.example/visual.png');
    assert.equal(readerText.querySelectorAll('table').length, 0);
    assert.equal(readerText.querySelector('figcaption').dataset.readerCaptionId, 'cap');
  });
  test('invalid content returns false without changing the container', () => {
    const { c, page, content, readerText } = setup(); readerText.textContent = 'fallback';
    const mutations = [
      (x) => x.sourceRevision++, (x) => { x.textHash = 'wrong'; }, (x) => { x.displayedText = 'changed'; },
      (x) => { x.imageHash = 'wrong'; }, (x) => { x.items[2].start = 4; }, (x) => { x.items[0].end = 2; x.items[2].start = 2; },
      (x) => { x.items.push({ type: 'visual', visualId: 'v1' }); }, (x) => { x.visuals.v1.renderMode = 'structured'; },
      (x) => { x.visuals.v1.kind = 'video'; }, (x) => { x.items[1].visualId = '__proto__'; },
    ];
    for (const mutate of mutations) { const broken = structuredClone(content); mutate(broken); assert.equal(c.renderReaderContent(page, broken), false); }
    c.readerEditing = true; assert.equal(c.renderReaderContent(page, content), false);
    assert.equal(readerText.textContent, 'fallback');
  });
  test('text-node traversal honors explicit wrapper offsets, nested marks and auxiliary exclusion', () => {
    const { c, document } = setup(); const root = document.createElement('div');
    root.append(document.createTextNode('ab'));
    const aux = document.createElement('span'); aux.dataset.readerAuxiliary = ''; aux.textContent = 'ignored'; root.append(aux);
    const span = document.createElement('span'); span.dataset.readerTextStart = '12';
    const mark = document.createElement('mark'); mark.textContent = '😀'; span.append(mark, document.createTextNode('z')); root.append(span);
    assert.deepEqual(plain(c.getReaderTextNodes(root).map(({ start, end }) => [start, end])), [[0, 2], [12, 14], [14, 15]]);
  });
  test('cached loading deduplicates requests, uses encoded IDs and invalidates for exact text changes', async () => {
    const env = setup(); let calls = 0, url;
    env.c.fetch = async (value) => { calls++; url = value; return { ok: true, json: async () => env.content }; };
    const values = await Promise.all([env.c.loadReaderContent(env.item, env.page), env.c.loadReaderContent(env.item, env.page)]);
    assert.equal(calls, 1); assert.equal(values[0], values[1]);
    assert.equal(url, '/api/documents/doc%2F1/pages/p%2F1/reader-content');
    assert.equal(env.c.getCachedReaderContent(env.item, env.page), env.content);
    env.page.text += ' ';
    assert.equal(env.c.getCachedReaderContent(env.item, env.page), null);
    assert.equal(await env.c.loadReaderContent(env.item, env.page), null);
    assert.equal(calls, 2);
  });
  test('failed loads can retry; responses for old processing revisions are discarded', async () => {
    const env = setup(); let resolve;
    env.c.fetch = () => new Promise((done) => { resolve = done; });
    const pending = env.c.loadReaderContent(env.item, env.page);
    env.page.processingRevision++;
    resolve({ ok: true, json: async () => env.content });
    assert.equal(await pending, null);
    env.page.processingRevision--;
    env.c.fetch = async () => ({ ok: false });
    assert.equal(await env.c.loadReaderContent(env.item, env.page), null);
    env.c.fetch = async () => ({ ok: true, json: async () => env.content });
    assert.equal(await env.c.loadReaderContent(env.item, env.page), env.content);
  });
  test('visual overlays have independent caption boxes and exact source guards', () => {
    const env = setup(); const image = addImage(env);
    assert.equal(env.c.renderReaderVisualOverlay(env.page, env.content), true);
    let overlay = env.readerOriginalPreview.querySelector('.reader-visual-overlay');
    assert.equal(overlay.style.visibility, 'visible');
    assert.equal(overlay.querySelectorAll('[data-reader-visual-id]').length, 2);
    assert.equal(overlay.querySelector('[data-reader-caption-id]').dataset.readerCaptionId, 'cap');
    assert.equal(overlay.querySelectorAll('[data-sentence-id]').length, 0);
    image.naturalWidth = 200; image.dispatch('load'); assert.equal(overlay.style.visibility, 'hidden');
    env.content.visuals.v1.sourceImageHash = 'stale';
    assert.equal(env.c.renderReaderVisualOverlay(env.page, env.content), false);
    assert.equal(env.readerOriginalPreview.querySelector('.reader-visual-overlay'), null);
  });
  test('polygon coordinates are bounded and image source/hash mismatches prevent overlays', () => {
    const env = setup(); const image = addImage(env);
    env.content.visuals.v1.sourceRegions = [{ polygon: [[1, 1], [20, 1], [10, 20]] }];
    env.c.renderReaderVisualOverlay(env.page, env.content);
    assert.ok(env.readerOriginalPreview.querySelector('polygon'));
    image.src = '/different.png'; assert.equal(env.c.renderReaderVisualOverlay(env.page, env.content), false);
    assert.equal(env.readerOriginalPreview.querySelector('.reader-visual-overlay'), null);
    image.src = env.page.imageUrl; env.page.imageHash = '';
    assert.equal(env.c.renderReaderVisualOverlay(env.page, env.content), false);
    assert.equal(env.c.readerVisualRegions({ polygon: [[-1, 0], [2, 0], [2, 2]] }, 100, 200), null);
  });
  test('hover never scrolls; clicking a figure opens the large view; caption click selects', () => {
    const env = setup(); addImage(env); const scrolls = [], sentences = [];
    env.c.scrollReaderRegionIntoView = (node, container) => scrolls.push([node, container]);
    env.c.setReaderLinkActive = (id) => sentences.push(id);
    env.c.renderReaderContent(env.page, env.content); env.c.renderReaderVisualOverlay(env.page, env.content);
    const figure = env.readerText.querySelector('.reader-visual'), caption = env.readerText.querySelector('figcaption');
    figure.click(); assert.equal(scrolls.length, 0);
    assert.ok(env.document.querySelector('.reader-visual-dialog'));
    env.document.querySelector('.reader-visual-dialog-close').click();
    assert.equal(env.document.querySelector('.reader-visual-dialog'), null);
    caption.dispatch('pointerover'); assert.equal(scrolls.length, 0); assert.equal(caption.classList.contains('is-active'), true);
    caption.dispatch('pointerout', { relatedTarget: null }); assert.equal(figure.classList.contains('is-active'), false);
    caption.click(); assert.equal(scrolls.length, 2); assert.equal(sentences.at(-1), null);
    const region = env.readerOriginalPreview.querySelector('[data-reader-caption-id]');
    assert.equal(region.classList.contains('is-selected'), true);
    env.c.bindReaderVisualEvents(env.readerText);
    assert.equal(env.readerText.listeners.click.length, 1);
  });
  test('large view opens by clicking the image; unsafe URLs remove the image and the click target', () => {
    const env = setup(); env.content.visuals.v1.kind = 'figure'; env.content.visuals.v1.renderMode = 'image';
    env.content.visuals.v1.url = 'javascript:alert(1)';
    env.c.renderReaderContent(env.page, env.content);
    assert.equal(env.readerText.querySelector('img'), null);
    assert.equal(env.readerText.querySelector('.reader-visual-enlarge'), null);
    env.readerText.querySelector('.reader-visual').click(); assert.equal(env.document.querySelector('dialog'), null);
    env.content.visuals.v1.url = '/visual.png';
    env.c.renderReaderContent(env.page, env.content);
    assert.equal(env.readerText.querySelector('.reader-visual').classList.contains('is-zoomable'), true);
    env.readerText.querySelector('.reader-visual img').click();
    assert.ok(env.document.querySelector('.reader-visual-dialog'));
    env.document.querySelector('.reader-visual-dialog-close').click(); assert.equal(env.document.querySelector('dialog'), null);
    assert.equal(env.c.readerVisualSafeUrl('data:text/html,bad'), '');
    assert.equal(env.c.readerVisualSafeUrl('/crop.png'), 'https://reader.example/crop.png');
  });
  test('figure notes render inside the figure and keep full text coverage', () => {
    const env = setup();
    const text = 'A😀B\n\n注：示例\n\nC';
    env.page.text = text;
    const content = { version: 1, sourceRevision: 7, displayedText: text, textHash: digest(text), imageHash: env.page.imageHash,
      items: [
        { type: 'text', start: 0, end: 4 },
        { type: 'visual', visualId: 'v1' },
        { type: 'note', start: 4, end: 10, visualId: 'v1' },
        { type: 'text', start: 10, end: text.length },
      ],
      visuals: { v1: { id: 'v1', kind: 'figure', renderMode: 'image', url: '/visual.png',
        captions: [{ id: 'c1', text: '图1 标题', position: 'after' }] } }, warnings: [] };
    assert.equal(env.c.renderReaderContent(env.page, content), true);
    const figure = env.readerText.querySelector('.reader-visual');
    assert.equal(figure.querySelector('.reader-visual-note').textContent, '注：示例');
    assert.equal(figure.querySelector('.reader-visual-caption').textContent, '图1 标题');
    assert.equal(figure.children[figure.children.length - 1].className.includes('reader-visual-caption'), true);
    assert.equal(env.readerText.querySelectorAll('.reader-visual-note').length, 1);
    assert.equal(env.readerText.textContent.includes('注：示例'), true);
    assert.ok(env.readerText.textContent.endsWith('C'));
  });
  test('figure notes stay in the text-node map and link to their sentence', () => {
    const env = setup();
    const text = 'A😀B\n\n注：示例。\n\nC';
    env.page.text = text;
    const content = { version: 1, sourceRevision: 7, displayedText: text, textHash: digest(text), imageHash: env.page.imageHash,
      items: [
        { type: 'text', start: 0, end: 6 },
        { type: 'visual', visualId: 'v1' },
        { type: 'note', start: 6, end: 11, visualId: 'v1' },
        { type: 'text', start: 11, end: text.length },
      ],
      visuals: { v1: { id: 'v1', kind: 'figure', renderMode: 'image', url: '/visual.png',
        captions: [{ id: 'c1', text: '图1 标题', position: 'after' }] } }, warnings: [] };
    const index = { sourceRevision: 7, displayedText: text, sentences: [
      { id: 's1', start: 0, end: 6, text: 'A😀B\n\n' },
      { id: 's2', start: 6, end: 11, text: '注：示例。' },
      { id: 's3', start: 11, end: text.length, text: '\n\nC' }] };
    assert.equal(env.c.renderReaderContent(env.page, content, index), true);
    const note = env.readerText.querySelector('.reader-visual-note');
    assert.deepEqual(plain(note.querySelectorAll('[data-sentence-id]').map((node) => node.dataset.sentenceId)), ['s2']);
    assert.equal(note.querySelector('span').classList.contains('reader-sentence'), true);
    const nodes = env.c.getReaderTextNodes(env.readerText);
    assert.equal(nodes.map(({ node }) => node.nodeValue).join(''), text);
    const noteNodes = nodes.filter(({ node }) => note.contains(node));
    assert.deepEqual(plain(noteNodes.map(({ start, end }) => [start, end])), [[6, 11]]);
  });
  test('large view fits the viewport and caps upscaling of tiny images', () => {
    const { c } = setup();
    const viewport = { width: 1600, height: 900 };
    const small = c.readerVisualFitScale({ width: 100, height: 200 }, viewport);
    assert.ok(Math.abs(small - 3.54) < 0.01, String(small));
    const wide = c.readerVisualFitScale({ width: 2000, height: 1000 }, viewport);
    assert.ok(Math.abs(wide - 0.708) < 0.01, String(wide));
    assert.equal(c.readerVisualFitScale({ width: 200, height: 100 }, viewport), 4);
    assert.equal(c.readerVisualFitScale({ width: 0, height: 0 }, viewport), 1);
  });
  test('standalone caption titles render without an image or enlarge control', () => {
    const env = setup();
    env.c.renderReaderContent(env.page, env.content);
    assert.equal(env.readerText.querySelector('img').getAttribute('src'), 'https://reader.example/visual.png');
    env.content.visuals.v1 = { id: 'v1', kind: 'caption', renderMode: 'image', title: 'Unassigned title', captions: [] };
    env.c.renderReaderContent(env.page, env.content);
    assert.equal(env.readerText.querySelector('figcaption').textContent, 'Unassigned title');
    assert.equal(env.readerText.querySelector('img'), null);
    assert.equal(env.readerText.querySelector('.reader-visual-unavailable'), null);
    assert.equal(env.readerText.querySelector('button'), null);
  });
  test('clearing temporary hover preserves selection and full sentence clear removes visual state', () => {
    const env = setup(); env.c.renderReaderContent(env.page, env.content);
    // 父级在清除句子状态时也可以清除视觉状态。
    env.c.setReaderLinkActive = () => env.c.clearReaderVisualActive();
    env.c.setReaderVisualActive('v1');
    env.c.setReaderVisualActive('v1', { hover: true, captionId: 'cap' });
    env.c.clearReaderVisualHover();
    assert.equal(env.readerText.querySelector('.reader-visual').classList.contains('is-selected'), true);
    env.c.clearReaderVisualSelection();
    assert.equal(env.readerText.querySelector('.reader-visual').classList.contains('is-selected'), false);
  });

}
