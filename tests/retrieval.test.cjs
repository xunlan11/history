const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.attributes = {}; this.classList = { add() {}, remove() {} }; }
  append(...children) { this.children.push(...children); }
  addEventListener(type, handler) { this.events[type] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  scrollIntoView(options) { this.scrolled = options; }
}

function setup(extra = {}) {
  const source = fs.readFileSync('js/conversations.js', 'utf8');
  const context = {
    console, URL, URLSearchParams, Map, Set, TextEncoder, structuredClone,
    documents: [], canEditDocument: () => false,
    document: { createElement: (tag) => new Element(tag), addEventListener() {} },
    window: { open() {} },
    endpoint: (path) => path,
    getSelectedConversation: () => null, setReaderCitationSentence() {},
    ...extra,
  };
  for (const match of source.matchAll(/^(\w+)\?\./gm)) context[match[1]] = null;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('js/retrieval.js', 'utf8'), context);
  vm.runInContext(source, context);
  return context;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function evidence(number, level = 'exact') {
  return { chunkId: `c${number}`, documentId: 'd', pageId: 'p', sourceType: 'document-page',
    sourceLayer: 'punctuatedText', sourceHash: 'hash', title: 'Document',
    text: 'army camp', start: 0, end: 9, matchStart: 0, matchEnd: 4, level, matchedBy: ['literal'] };
}

test('validation batches more than 200 hits and keeps all allowed matches', async () => {
  const batches = [];
  const context = setup({ fetch: async (path, options) => {
    const batch = JSON.parse(options.body).evidence;
    batches.push(batch.length);
    return { ok: true, json: async () => ({ allowedChunkIds: batch.filter((e) => e.chunkId !== 'c201').map((e) => e.chunkId), warnings: ['checked'] }) };
  } });
  const request = { body: { evidence: Array.from({ length: 450 }, (_, i) => evidence(i)) }, warnings: [] };
  const result = await context.validateFrozenEvidence(request);
  assert.deepEqual(batches, [200, 200, 50]);
  assert.equal(result.body.evidence.length, 449);
  assert.deepEqual(plain(result.warnings), ['checked']);
});

for (const mode of ['chat', 'search']) {
  test(`${mode} preserves all matches after the model uses only one`, async () => {
    const hits = Array.from({ length: 75 }, (_, i) => evidence(i));
    const turn = { id: 'turn', mode, prompt: 'army', request: {
      path: `/${mode}`, body: { evidence: hits, options: { history: [] } }, warnings: [], sourceDocumentIds: ['d'],
    } };
    const conversation = { id: 'conversation', turns: [turn] };
    const context = setup({ conversations: [conversation], persistConversations() {}, isLlmServiceConnected: () => true,
      requestLlmTask: async () => ({ ready: true, answer: 'Answer', sources: [], matches: [], usedEvidence: [hits[0]], usedHistory: [], warnings: [] }),
    });
    context.validateFrozenEvidence = async (request) => request;
    context.refreshConversationTurnView = () => {};
    await context.generateConversationTurn('conversation', 'turn');
    assert.equal(turn.status, 'completed');
    assert.equal(turn.request.body.evidence.length, 75);
    assert.equal(turn.result.payload.matches.length, 75);
    assert.equal(turn.request.usedEvidence.length, 1);
  });
}

test('all three groups render, including every result above the old limits', () => {
  const context = setup();
  const numbers = [];
  context.renderLlmSearchResults = (matches, warnings, query, target, firstNumber) => {
    numbers.push(firstNumber);
    target.append(...matches);
  };
  const hits = Array.from({ length: 75 }, (_, i) => ({ ...evidence(i), quote: 'army', level: i < 30 ? 'exact' : i < 60 ? 'partial' : 'semantic' }));
  const container = new Element('div');
  context.renderConversationRetrieval(hits, 'army', container, true);
  assert.equal(container.children[0].open, true);
  const groups = container.children[0].children.filter((node) => node.tag === 'details');
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.children[1].children.length), [30, 30, 15]);
  assert.deepEqual(numbers, [1, 31, 61]);
});

test('editing a prompt sends the frozen attachments to the shared backend matcher', async () => {
  const context = setup();
  context.getConversationContextReport = () => ({ error: '', warnings: [], attachments: { ready: [] } });
  let captured;
  const attachment = { ...evidence(1), sourceType: 'conversation-file', documentId: 'a',
    attachmentId: 'a', matchStart: 9, matchEnd: 13 };
  context.fetchRetrievalEvidence = async (request) => {
    captured = request;
    return { hits: [attachment], warnings: [] };
  };
  const previous = { retrieval: { documentIds: [], textPolicy: 'primary' }, warnings: [],
    attachmentSources: [{ id: 'a', fileName: 'test.txt', extractedText: 'army and navy' }],
    body: { evidence: [] },
  };
  const request = await context.captureConversationTurnRequest({ turns: [] }, 'chat', 'navy', '', previous);
  assert.equal(captured.query, 'navy');
  assert.equal(captured.attachments[0].extractedText, 'army and navy');
  assert.equal(request.body.evidence.length, 1);
  assert.equal(request.body.evidence[0].matchStart, 9);
  assert.equal(request.body.evidence[0].level, 'exact');
  assert.deepEqual(Array.from(request.sourceDocumentIds), []);
});

test('table shows three columns, the complete sentence, and the exact highlighted match', () => {
  const opened = [];
  const context = setup({ escapeHtml: (text) => text.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    window: { open: (...args) => opened.push(args) }, getDocumentDisplayTitle: () => '史料',
  });
  context.resolveSearchMatch = () => ({ item: { id: 'd' }, page: { id: 'p', pageNumber: 7 } });
  const sentence = '😀The army moved.';
  const hit = { ...evidence(1), sentenceText: sentence, sentenceStart: 10, sentenceEnd: 26,
    matchStart: 15, matchEnd: 19, pageNumber: 7 };
  const match = context.conversationRetrievalMatches({ body: { evidence: [hit] } })[0];
  assert.equal(match.quote, sentence);
  assert.equal(match.start, 10);
  assert.equal(match.end, 26);
  assert.match(context.buildEvidenceHref(match), /start=10&end=26/);
  const container = new Element('div');
  context.renderLlmSearchResults([match], [], 'army', container, 6);
  const table = container.children[0];
  assert.equal(table.tag, 'table');
  assert.deepEqual(table.children[0].children[0].children.map((cell) => cell.textContent), ['序号', '匹配文本', '出处']);
  const row = table.children[1].children[0];
  assert.equal(row.children[0].textContent, '6');
  assert.equal(row.children[1].innerHTML, '😀The <mark>army</mark> moved.');
  assert.match(row.children[2].textContent, /史料.*第 7 页/);
  row.events.click({ target: { closest: () => null } });
  assert.equal(opened.length, 1);
  assert.match(opened[0][0], /document=d&page=p/);
  assert.deepEqual(opened[0].slice(1), ['_blank', 'noopener']);
  let prevented = false;
  row.events.keydown({ key: 'Enter', target: { closest: () => null }, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(opened.length, 2);
});

test('search without a generation model still returns every match', async () => {
  const turn = { id: 'turn', mode: 'search', prompt: 'army', request: {
    path: '/search', body: { evidence: Array.from({ length: 75 }, (_, i) => evidence(i)), options: { history: [] } },
    warnings: [], sourceDocumentIds: ['d'],
  } };
  const context = setup({ conversations: [{ id: 'conversation', turns: [turn] }],
    persistConversations() {}, isLlmServiceConnected: () => false,
  });
  context.validateFrozenEvidence = async (request) => request;
  context.refreshConversationTurnView = () => {};
  await context.generateConversationTurn('conversation', 'turn');
  assert.equal(turn.status, 'completed');
  assert.equal(turn.result.payload.matches.length, 75);
});

test('reader highlights the whole sentence in the main text and scrolls to it', async () => {
  const source = '😀前句。军队驻扎边境。后句。';
  const page = { id: 'p', punctuatedText: source };
  const readerText = new Element('div');
  readerText.textContent = source;
  const panels = [];
  readerText.before = (panel) => panels.push(panel);
  const context = setup({ readerText, readerEditing: false, getPagePrimaryText: () => source,
    getSelectedDocument: () => ({ id: 'd' }),
    getSelectedPage: () => page,
  });
  context.document.querySelector = () => null;
  const sourceHash = await context.hashEvidenceText(source);
  context.window.location = { href: 'http://localhost/reader.html?document=d&page=p&sourceLayer=punctuatedText&sourceHash=' + sourceHash + '&start=4&end=11' };
  const marks = [];
  const mark = new Element('mark');
  context.markEvidenceRange = (target, start, end) => { marks.push({ target, start, end }); return mark; };
  await context.showReaderEvidence(page);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].target, readerText);
  assert.equal(marks[0].start, 4);
  assert.equal(marks[0].end, 11);
  assert.equal(panels[0].children.length, 1);
  assert.equal(mark.scrolled.block, 'center');
});

test('semantic rows show complete sentences and highlight the retrieved passage', () => {
  const context = setup();
  const hit = { ...evidence(1, 'semantic'), text: '驻防', start: 5, end: 7,
    matchStart: undefined, matchEnd: undefined, matchedBy: ['semantic'],
    sentenceStart: 4, sentenceEnd: 10, sentenceText: '军驻防于边境' };
  const match = context.conversationRetrievalMatches({ body: { evidence: [hit] } })[0];
  assert.equal(match.quote, '军驻防于边境');
  assert.equal(match.contextStart, 4);
  assert.equal(match.matchStart, 5);
  assert.equal(match.matchEnd, 7);
  assert.equal(match.start, 4);
  assert.equal(match.end, 10);
});

test('reader keeps source-layer fallback when the hit differs from the visible body', async () => {
  const source = 'OCR军队。';
  const page = { id: 'p', ocrText: source, punctuatedText: '整理后的正文。' };
  const readerText = new Element('div');
  readerText.textContent = page.punctuatedText;
  const panels = [];
  readerText.before = (panel) => panels.push(panel);
  const context = setup({ readerText, readerEditing: false, getPagePrimaryText: () => page.punctuatedText,
    getSelectedPage: () => page,
    getSelectedDocument: () => ({ id: 'd' }) });
  context.document.querySelector = () => null;
  const hash = await context.hashEvidenceText(source);
  context.window.location = { href: 'http://localhost/reader.html?document=d&page=p&sourceLayer=ocrText&sourceHash=' + hash + '&start=0&end=6' };
  const marks = [];
  context.markEvidenceRange = (target, start, end) => { marks.push({ target, start, end }); return new Element('mark'); };
  await context.showReaderEvidence(page);
  assert.equal(marks[0].target.className, 'reader-evidence-text');
  assert.equal(marks[0].target.textContent, source);
  assert.equal(panels[0].children.length, 2);
});

test('reader rejects a stale sentence location instead of highlighting changed content', async () => {
  const readerText = new Element('div');
  const panels = [];
  readerText.before = (panel) => panels.push(panel);
  const context = setup({ readerText, readerEditing: false, getSelectedDocument: () => ({ id: 'd' }),
    getSelectedPage: () => ({ id: 'p', punctuatedText: '新的正文。' }) });
  context.document.querySelector = () => null;
  context.window.location = { href: 'http://localhost/reader.html?document=d&page=p&sourceLayer=punctuatedText&sourceHash=old&start=0&end=2' };
  let marked = false;
  context.markEvidenceRange = () => { marked = true; };
  await context.showReaderEvidence({ id: 'p', punctuatedText: '新的正文。' });
  assert.equal(marked, false);
  assert.match(panels[0].textContent, /已更新/);
});


test('homepage keeps all backend library and attachment hits and interleaves model context', async () => {
  const context = setup();
  context.getConversationContextReport = () => ({ error: '', warnings: [], attachments: { ready: [] } });
  const library = Array.from({ length: 75 }, (_, i) => evidence(i));
  const attachments = Array.from({ length: 75 }, (_, i) => ({ ...evidence(i + 75),
    sourceType: 'conversation-file', documentId: 'a', attachmentId: 'a' }));
  context.fetchRetrievalEvidence = async () => ({ hits: [...library, ...attachments], warnings: [] });
  const request = await context.captureConversationTurnRequest({ turns: [] }, 'chat', 'army', '', {
    retrieval: { documentIds: ['d'], textPolicy: 'primary' }, attachmentSources: [], warnings: [], body: { evidence: [] },
  });
  assert.equal(request.body.evidence.length, 150);
  assert.deepEqual(Array.from(request.sourceDocumentIds), ['d']);
  assert.deepEqual(Array.from(request.body.evidence.slice(0, 4), (hit) => hit.sourceType),
    ['document-page', 'conversation-file', 'document-page', 'conversation-file']);
});


function visualLayer(kind, visualId, itemId) {
  const encode = (id) => encodeURIComponent(id).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}:${encode(visualId)}:${encode(itemId)}`;
}

function visualPage() {
  return { id: 'p', punctuatedText: 'body', visuals: [{ id: "figure:图/%!'()*", kind: 'table',
    captions: [{ id: 'caption:😀/%', text: '😀军队图注。' }] }] };
}

test('visual source lookup decodes canonical Python URL quoting', () => {
  const context = setup(), page = visualPage(), visual = page.visuals[0], item = visual.captions[0];
  assert.deepEqual(plain(context.getReaderVisualSource(page, visualLayer('visual_caption', visual.id, item.id))),
    { text: item.text, visualId: visual.id, captionId: item.id });
  for (const layer of ['cleanText', 'visual_caption:a:b:c', 'visual_caption::x', 'table_cell:a:%',
    'visual_caption:a%3ab:c', 'table_cell:v:未编码', 'visual_caption:a:%FF']) {
    assert.equal(context.getReaderVisualSource(page, layer), null);
  }
  assert.equal(context.getReaderVisualSource(page, visualLayer('visual_caption', 'missing', item.id)), null);
});

test('visual source lookup supports reader-content maps without resurrecting removed page visuals', () => {
  const page = visualPage(), visual = page.visuals[0];
  const context = setup({ getSelectedDocument: () => ({ id: 'd' }),
    getCachedReaderContent: () => ({ visuals: { [visual.id]: visual } }) });
  const layer = visualLayer('visual_caption', visual.id, visual.captions[0].id);
  assert.equal(context.getReaderVisualSource({ id: 'p' }, layer).text, visual.captions[0].text);
  assert.equal(context.getReaderVisualSource({ id: 'p', visuals: [] }, layer), null);
});

test('visual evidence resolves source-local hashes and rejects stale or out-of-source offsets', async () => {
  const context = setup(), page = visualPage(), visual = page.visuals[0], item = visual.captions[0];
  const layer = visualLayer('visual_caption', visual.id, item.id), hash = await context.hashEvidenceText(item.text);
  const locator = { sourceLayer: layer, sourceHash: hash, start: 1, end: 3 };
  assert.deepEqual(plain(await context.resolveEvidenceAnchor(page, locator)),
    { status: 'ready', sourceLayer: layer, start: 1, end: 3, text: item.text, visualId: visual.id, captionId: item.id });
  assert.equal((await context.resolveEvidenceAnchor(page, { ...locator, sourceHash: 'old' })).status, 'stale');
  assert.equal((await context.resolveEvidenceAnchor(page, { ...locator, end: 100 })).status, 'missing');
});

test('visual caption evidence waits for content and selects its visual without body highlighting', async () => {
    const page = visualPage(), visual = page.visuals[0];
    const item = visual.captions[0];
    const readerText = new Element('div'), panels = [], calls = [];
    readerText.before = (panel) => panels.push(panel);
    let finish;
    const context = setup({ readerText, readerEditing: false, getSelectedDocument: () => ({ id: 'd' }),
      getSelectedPage: () => page, getPagePrimaryText: () => { throw new Error('visual used body'); },
      loadReaderContent: () => new Promise((resolve) => { finish = resolve; }),
      setReaderVisualActive: (id, options) => calls.push({ id, ...options }),
      setReaderCitationSentence: (id) => assert.equal(id, ''),
    });
    context.document.querySelector = () => null;
    context.markEvidenceRange = () => { throw new Error('visual offsets used as body'); };
    const params = new URLSearchParams({ document: 'd', page: 'p', sourceLayer: visualLayer('visual_caption', visual.id, item.id),
      sourceHash: await context.hashEvidenceText(item.text), start: '1', end: '3' });
    context.window.location = { href: `http://localhost/reader.html?${params}` };
    const pending = context.showReaderEvidence(page, { sentences: [{ start: 0, end: 4 }] });
    await Promise.resolve();
    assert.equal(calls.length, 0);
    finish({});
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, visual.id);
    assert.equal(calls[0].scrollText, true);
    assert.equal(calls[0].scrollImage, true);
    assert.equal(calls[0].captionId, item.id);
    assert.equal(panels.length, 1);
});

test('a pending visual citation cannot activate after navigation changes', async () => {
  const page = visualPage(), visual = page.visuals[0], caption = visual.captions[0];
  const readerText = new Element('div');
  readerText.before = () => { throw new Error('stale panel rendered'); };
  let finish, calls = 0;
  const context = setup({ readerText, readerEditing: false, getSelectedDocument: () => ({ id: 'd' }),
    loadReaderContent: () => new Promise((resolve) => { finish = resolve; }),
    setReaderVisualActive: () => calls++,
  });
  context.document.querySelector = () => null;
  const params = new URLSearchParams({ document: 'd', page: 'p', sourceLayer: visualLayer('visual_caption', visual.id, caption.id),
    sourceHash: await context.hashEvidenceText(caption.text), start: '1', end: '3' });
  context.window.location = { href: `http://localhost/reader.html?${params}` };
  const pending = context.showReaderEvidence(page);
  await Promise.resolve();
  context.window.location.href = 'http://localhost/reader.html?document=d&page=other';
  finish({});
  await pending;
  assert.equal(calls, 0);
});

class EvidenceTextNode {
  constructor(text) { this.nodeType = 3; this.nodeValue = text; }
  get textContent() { return this.nodeValue; }
  splitText(offset) {
    const tail = new EvidenceTextNode(this.nodeValue.slice(offset));
    this.nodeValue = this.nodeValue.slice(0, offset);
    this.lastTail = tail;
    return tail;
  }
  replaceWith(mark) { this.mark = mark; }
}

for (const useHelper of [true, false]) {
  test(`evidence offsets preserve emoji across nodes with reader helper=${useHelper}`, () => {
    const first = new EvidenceTextNode('😀前'), second = new EvidenceTextNode('军队后');
    const auxiliary = { nodeType: 1, hasAttribute: (name) => name === 'data-reader-auxiliary',
      childNodes: [new EvidenceTextNode('CAPTION MUST NOT COUNT')] };
    const container = { nodeType: 1, childNodes: useHelper ? [first, auxiliary, second] : [first, second] };
    const context = setup({ readerText: container, NodeFilter: { SHOW_TEXT: 4 } });
    if (useHelper) {
      const readerSource = fs.readFileSync('js/reader.js', 'utf8');
      const start = readerSource.indexOf('/* reader-text-dom:start */');
      const end = readerSource.indexOf('/* reader-text-dom:end */');
      if (start < 0 || end < start) throw new Error('reader.js missing reader-text-dom block');
      vm.runInContext(readerSource.slice(start, end), context);
      context.document.createTreeWalker = () => { throw new Error('reader helper bypassed'); };
    } else {
      let index = -1;
      context.document.createTreeWalker = () => ({ nextNode() { this.currentNode = [first, second][++index]; return !!this.currentNode; } });
    }
    const mark = context.markEvidenceRange(container, 1, 4);
    assert.equal(mark.children[0].textContent, '前');
    assert.equal(second.lastTail.mark.children[0].textContent, '军队');
    assert.equal(first.textContent, '😀');
  });
}

test('body citation compares only reader text nodes when captions are interleaved', async () => {
  const source = '😀军队。', page = { id: 'p', punctuatedText: source }, readerText = new Element('div');
  readerText.textContent = source + '图注与按钮';
  readerText.before = () => {};
  const marks = [];
  const context = setup({ readerText, readerEditing: false, getSelectedDocument: () => ({ id: 'd' }),
    getSelectedPage: () => page,
    getPagePrimaryText: () => source,
    getReaderTextNodes: () => [{ node: { textContent: source }, start: 0, end: source.length }],
    setReaderCitationSentence() {},
  });
  context.document.querySelector = () => null;
  const params = new URLSearchParams({ document: 'd', page: 'p', sourceLayer: 'punctuatedText',
    sourceHash: await context.hashEvidenceText(source), start: '1', end: '3' });
  context.window.location = { href: `http://localhost/reader.html?${params}` };
  context.markEvidenceRange = (target) => { marks.push(target); return new Element('mark'); };
  await context.showReaderEvidence(page);
  assert.deepEqual(marks, [readerText]);
});


test('homepage visual matches retain source identity and encode the complete citation URL', async () => {
  const context = setup(), page = visualPage(), visual = page.visuals[0], caption = visual.captions[0];
  const layer = visualLayer('visual_caption', visual.id, caption.id);
  const source = { ...evidence(1), sourceLayer: layer, visualId: visual.id, captionId: caption.id,
    sourceHash: await context.hashEvidenceText(caption.text), text: caption.text, start: 0,
    end: Array.from(caption.text).length, matchStart: 1, matchEnd: 3 };
  const [match] = context.conversationRetrievalMatches({ body: { evidence: [source] } });
  const href = new URL(context.buildEvidenceHref(match), 'http://localhost/');
  assert.equal(href.searchParams.get('sourceLayer'), layer);
  assert.equal(href.searchParams.get('sourceHash'), source.sourceHash);
  assert.equal(match.visualId, visual.id);
  assert.equal(match.captionId, caption.id);
  const anchor = await context.resolveEvidenceAnchor(page, Object.fromEntries(href.searchParams));
  assert.equal(anchor.status, 'ready');
  assert.equal(anchor.captionId, caption.id);
});


test('visual citation reports unavailable content without activating stale DOM', async () => {
  const page = visualPage(), visual = page.visuals[0], caption = visual.captions[0], panels = [];
  const readerText = new Element('div');
  readerText.before = (panel) => panels.push(panel);
  const context = setup({ readerText, readerEditing: false, getSelectedDocument: () => ({ id: 'd' }),
    getSelectedPage: () => page, loadReaderContent: async () => null,
    setReaderVisualActive: () => assert.fail('unavailable visual activated'),
  });
  context.document.querySelector = () => null;
  const params = new URLSearchParams({ document: 'd', page: 'p', sourceLayer: visualLayer('visual_caption', visual.id, caption.id),
    sourceHash: await context.hashEvidenceText(caption.text), start: '1', end: '3' });
  context.window.location = { href: `http://localhost/reader.html?${params}` };
  await context.showReaderEvidence(page);
  assert.match(panels[0].textContent, /无法定位/);
});

test('visual citation revalidates a replaced page object after loading', async () => {
  const page = visualPage(), visual = page.visuals[0], caption = visual.captions[0], panels = [];
  let selectedPage = page;
  const readerText = new Element('div');
  readerText.before = (panel) => panels.push(panel);
  const context = setup({ readerText, readerEditing: false, getSelectedDocument: () => ({ id: 'd' }),
    getSelectedPage: () => selectedPage,
    loadReaderContent: async () => {
      selectedPage = structuredClone(page);
      selectedPage.visuals[0].captions[0].text = 'changed';
      return {};
    }, setReaderVisualActive: () => assert.fail('old page object used'),
  });
  context.document.querySelector = () => null;
  const params = new URLSearchParams({ document: 'd', page: 'p', sourceLayer: visualLayer('visual_caption', visual.id, caption.id),
    sourceHash: await context.hashEvidenceText(caption.text), start: '1', end: '3' });
  context.window.location = { href: `http://localhost/reader.html?${params}` };
  await context.showReaderEvidence(page);
  assert.match(panels[0].textContent, /已更新/);
});
