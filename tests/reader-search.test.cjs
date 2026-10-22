const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(item, extra = {}) {
  const context = vm.createContext({
    console, TextEncoder, URLSearchParams, URL, currentUser: { id: 'u' }, readerEditing: false,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    getSelectedDocument: () => item, loadReaderContent: async () => {}, ...extra,
  });
  vm.runInContext(fs.readFileSync('js/retrieval.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('js/reader-search.js', 'utf8'), context);
  context.originalRenderReaderSearchPanel = context.renderReaderSearchPanel;
  context.renderReaderSearchPanel = () => {};
  context.refreshReaderSearchText = () => {};
  context.state = vm.runInContext('readerSearchState', context);
  return context;
}

async function hit(context, item, level, start, end) {
  const page = item.pages[0], text = page.punctuatedText;
  const points = Array.from(text);
  return { documentId: item.id, pageId: page.id, sourceLayer: 'punctuatedText',
    sourceHash: await context.hashEvidenceText(text), level,
    start: level === 'semantic' ? start : 0, end: level === 'semantic' ? end : points.length,
    text: level === 'semantic' ? points.slice(start, end).join('') : text,
    ...(level === 'semantic' ? {} : { matchStart: start, matchEnd: end }),
  };
}

function documentItem() {
  return { id: 'd', pages: [{ id: 'p', pageNumber: 7, punctuatedText: '😀军队。军 队。驻防。' }] };
}

test('reader consumes all backend levels and converts code points to UTF-16', async () => {
  const item = documentItem(), context = setup(item);
  const hits = await Promise.all([hit(context, item, 'exact', 1, 3), hit(context, item, 'partial', 4, 7), hit(context, item, 'semantic', 8, 11)]);
  const matches = await context.resolveReaderMatches(item, hits);
  assert.deepEqual(JSON.parse(JSON.stringify(matches.map(({ level, start, end }) => ({ level, start, end })))), [
    { level: 'exact', start: 2, end: 4 }, { level: 'partial', start: 5, end: 8 }, { level: 'semantic', start: 9, end: 12 },
  ]);
  assert.equal(matches[0].pageNumber, 7);
});

test('reader rejects stale, wrong-scope and invalid evidence', async () => {
  const item = documentItem(), context = setup(item);
  const valid = await hit(context, item, 'exact', 1, 3);
  const matches = await context.resolveReaderMatches(item, [valid, valid,
    { ...valid, sourceHash: 'stale' }, { ...valid, documentId: 'other' },
    { ...valid, sourceLayer: 'cleanText' }, { ...valid, matchStart: -1 },
    { ...valid, matchEnd: 500 }, { ...valid, text: 'changed' }, { ...valid, level: 'unknown' },
  ]);
  assert.equal(matches.length, 1);
});

test('reader makes one retrieval request for every match level', async () => {
  const item = documentItem(), context = setup(item);
  const hits = [await hit(context, item, 'exact', 1, 3)];
  const requests = [];
  context.fetchRetrievalEvidence = async (request) => { requests.push(request); return { hits, warnings: [], semanticError: '' }; };
  await context.runReaderSearch('军队');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, 'reader');
  assert.deepEqual(Array.from(requests[0].documentIds), ['d']);
  assert.equal(context.state.matches[0].level, 'exact');
});

test('reader ignores a previous query that completes after a newer one', async () => {
  const item = documentItem(), context = setup(item);
  const exact = await hit(context, item, 'exact', 1, 3), semantic = await hit(context, item, 'semantic', 8, 11);
  const pending = [];
  context.fetchRetrievalEvidence = () => new Promise((resolve) => pending.push(resolve));
  const first = context.runReaderSearch('军队');
  const second = context.runReaderSearch('驻防');
  pending[1]({ hits: [semantic], warnings: [] });
  await second;
  pending[0]({ hits: [exact], warnings: [] });
  await first;
  assert.equal(context.state.query, '驻防');
  assert.equal(context.state.matches[0].level, 'semantic');
});

test('reader preserves literal hits when only embedding fails', async () => {
  const item = documentItem(), context = setup(item);
  const exact = await hit(context, item, 'exact', 1, 3);
  context.fetchRetrievalEvidence = async () => ({ hits: [exact], warnings: ['embedding offline'], semanticError: 'offline' });
  await context.runReaderSearch('军队');
  assert.equal(context.state.matches.length, 1);
  assert.equal(context.state.semanticError, 'offline');
});

test('reader exposes retrieval failures for all levels', async () => {
  const context = setup(documentItem());
  context.fetchRetrievalEvidence = async () => { throw new Error('request failed'); };
  await context.runReaderSearch('军队');
  assert.equal(context.state.searchError, 'request failed');
  assert.equal(context.state.loading, false);
  assert.equal(context.state.matches.length, 0);
});

test('reader ignores removed text layer when final text is blank', async () => {
  const item = { id: 'd', pages: [{ id: 'p', pageNumber: 1, punctuatedText: '  ', cleanText: '军队驻扎。' }] };
  const context = setup(item), text = item.pages[0].cleanText;
  const hits = [{ documentId: 'd', pageId: 'p', level: 'exact', sourceLayer: 'cleanText',
    sourceHash: await context.hashEvidenceText(text), start: 0, end: Array.from(text).length,
    text, matchStart: 0, matchEnd: 2 }];
  const matches = await context.resolveReaderMatches(item, hits);
  assert.equal(matches.length, 0);
  assert.equal(context.getReaderSearchText(item.pages[0]), '');
});


function visualItem() {
  return { id: 'd', pages: [{ id: 'p', pageNumber: 1, visuals: [{ id: 'visual:图/%',
    captions: [{ id: 'c:1', text: '😀军队。' }, { id: 'c:2', text: '😀军队。' }],
    tableModel: { cells: [{ id: 'cell:1', text: '😀军队。' }] } }] }] };
}

async function visualHit(context, item, kind = 'visual_caption', index = 0) {
  const visual = item.pages[0].visuals[0], entry = kind === 'table_cell' ? visual.tableModel.cells[index] : visual.captions[index];
  const encode = (id) => encodeURIComponent(id).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return { documentId: item.id, pageId: item.pages[0].id, sourceLayer: `${kind}:${encode(visual.id)}:${encode(entry.id)}`,
    sourceHash: await context.hashEvidenceText(entry.text), level: 'exact', start: 0,
    end: Array.from(entry.text).length, text: entry.text, matchStart: 1, matchEnd: 3 };
}

test('reader resolves duplicate captions and table cells independently without body text', async () => {
  const item = visualItem(), context = setup(item);
  const hits = await Promise.all([visualHit(context, item), visualHit(context, item, 'visual_caption', 1), visualHit(context, item, 'table_cell')]);
  const matches = await context.resolveReaderMatches(item, [...hits, hits[0]]);
  assert.equal(matches.length, 3);
  assert.equal(new Set(matches.map((match) => match.id)).size, 3);
  for (const match of matches) {
    assert.equal(match.text, '😀军队。');
    assert.equal(match.text.slice(match.start, match.end), '军队');
    assert.equal(match.visualId, item.pages[0].visuals[0].id);
    assert.equal(match.sourceHash, hits[0].sourceHash);
    assert.ok(match.captionId || match.cellId);
  }
  const stale = await context.resolveReaderMatches(item, [
    { ...hits[0], sourceHash: 'old' }, { ...hits[0], text: 'changed' },
    { ...hits[0], sourceLayer: 'visual_caption:bad:%' }, { ...hits[0], documentId: 'other' },
    { ...hits[0], matchEnd: 99 },
  ]);
  assert.equal(stale.length, 0);
});

test('table-only reader search still requests and displays backend matches', async () => {
  const item = visualItem(), context = setup(item), requests = [];
  const expected = await visualHit(context, item, 'table_cell');
  context.fetchRetrievalEvidence = async (request) => { requests.push(request); return { hits: [expected] }; };
  await context.runReaderSearch('军队');
  assert.equal(requests.length, 1);
  assert.equal(context.state.matches.length, 1);
  assert.equal(context.state.matches[0].text.slice(context.state.matches[0].start, context.state.matches[0].end), '军队');
});

test('visual hit resolution loads uncached reader content for metadata-only pages', async () => {
  const full = visualItem(), sparse = { id: 'd', pages: [{ id: 'p', pageNumber: 1 }] };
  let cached = null, loads = 0;
  const context = setup(sparse, { getCachedReaderContent: () => cached,
    loadReaderContent: async () => { loads++; return cached = { visuals: { [full.pages[0].visuals[0].id]: full.pages[0].visuals[0] } }; } });
  const matches = await context.resolveReaderMatches(sparse, [await visualHit(context, full)]);
  assert.equal(loads, 1);
  assert.equal(matches.length, 1);
});

test('reader snapshot changes when caption or cell text changes', () => {
  const item = visualItem(), context = setup(item), original = context.readerSearchSnapshot(item);
  item.pages[0].visuals[0].captions[0].text = 'changed';
  const captionChanged = context.readerSearchSnapshot(item);
  assert.notEqual(captionChanged, original);
  item.pages[0].visuals[0].tableModel.cells[0].text = 'changed too';
  assert.notEqual(context.readerSearchSnapshot(item), captionChanged);
});

for (const kind of ['visual_caption', 'table_cell']) {
  test(`${kind} search navigation waits for content then renders and activates the visual`, async () => {
    const item = visualItem(), calls = [];
    let finish;
    const context = setup(item, {
      window: { location: { href: 'http://localhost/reader.html?document=d&page=old&sourceHash=old&start=0&end=2&sourceLayer=punctuatedText' },
        history: { replaceState(_a, _b, href) { this.href = href; } } },
      selectedPageId: 'old', renderAll: () => calls.push('all'), renderReader: () => calls.push('reader'),
      loadReaderContent: (_item, page) => { assert.equal(context.selectedPageId, page.id); calls.push('load'); return new Promise((resolve) => { finish = resolve; }); },
      setReaderVisualActive: (id, options) => calls.push({ id, ...options }),
    });
    context.state.documentId = item.id;
    context.state.matches = await context.resolveReaderMatches(item, [await visualHit(context, item, kind)]);
    const pending = context.openReaderSearchMatch(context.state.matches[0].id);
    await Promise.resolve();
    assert.equal(calls.includes('reader'), false);
    assert.equal(typeof finish, 'function');
    finish({});
    await pending;
    assert.deepEqual(calls.slice(0, 3), ['all', 'load', 'reader']);
    assert.equal(calls[3].id, item.pages[0].visuals[0].id);
    assert.equal(calls[3].scrollText, true);
    assert.equal(calls[3].scrollImage, true);
    if (kind === 'visual_caption') assert.equal(calls[3].captionId, 'c:1');
    assert.equal(context.state.scrollPending, false);
    assert.equal(new URL(context.window.history.href).searchParams.has('sourceHash'), false);
  });
}

test('pending visual navigation cannot select a visual after page navigation', async () => {
  const item = visualItem(), calls = [];
  let finish;
  const context = setup(item, {
    window: { location: { href: 'http://localhost/reader.html?document=d&page=p' }, history: { replaceState() {} } },
    selectedPageId: 'p', renderAll() {}, renderReader: () => calls.push('reader'),
    loadReaderContent: () => new Promise((resolve) => { finish = resolve; }), setReaderVisualActive: () => calls.push('visual'),
  });
  context.state.documentId = item.id;
  context.state.matches = await context.resolveReaderMatches(item, [await visualHit(context, item)]);
  const pending = context.openReaderSearchMatch(context.state.matches[0].id);
  await Promise.resolve();
  context.selectedPageId = 'other';
  finish({});
  await pending;
  assert.deepEqual(calls, []);
});

test('visual search ranges never enter body highlighting even when text is identical', async () => {
  const item = visualItem(), page = item.pages[0];
  page.punctuatedText = page.visuals[0].captions[0].text;
  const form = { addEventListener() {} };
  const context = setup(item, { readerText: {}, document: {
    querySelector: (selector) => selector === '#reader-search-form' ? form : null, querySelectorAll: () => [],
    createTreeWalker() { throw new Error('visual range entered body'); },
  }, getReaderTextNodes() { throw new Error('visual range entered body'); } });
  context.state.documentId = item.id;
  context.state.markAll = true;
  context.state.matches = await context.resolveReaderMatches(item, [await visualHit(context, item)]);
  context.applyReaderSearchHighlights(page);
});


class SearchElement {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.classList = { toggle() {} }; }
  addEventListener() {}
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...nodes) { for (const node of nodes) this.children.push(...(node.tag === '#fragment' ? node.children : [node])); }
  replaceChildren() { this.children = []; }
}

test('reader result panel renders caption and cell match text on a table-only page', async () => {
  const item = visualItem(), form = new SearchElement('form'), results = new SearchElement('ol'), status = new SearchElement('p');
  const context = setup(item, { document: {
    querySelector(selector) {
      if (selector === '#reader-search-form') return form;
      if (selector === '#reader-search-results') return results;
      if (selector === '#reader-search-status') return status;
      if (selector === '#reader-search-input') return new SearchElement('input');
      if (selector === '#reader-search-submit') return new SearchElement('button');
      return selector.startsWith('[data-reader-search-count=') ? new SearchElement('span') : null;
    }, querySelectorAll: () => [], createElement: (tag) => new SearchElement(tag),
    createDocumentFragment: () => new SearchElement('#fragment'),
  } });
  context.state.documentId = item.id;
  context.state.query = '军队';
  context.state.matches = await context.resolveReaderMatches(item, [await visualHit(context, item), await visualHit(context, item, 'table_cell')]);
  context.originalRenderReaderSearchPanel();
  assert.equal(results.children.length, 3);
  for (const row of results.children.slice(1)) assert.equal(row.children[0].children[1].textContent, '军队');
  assert.equal(status.textContent, '');
});

for (const changed of ['source', 'query', 'editing']) {
  test(`visual search navigation cannot activate after ${changed} changes during loading`, async () => {
    const item = visualItem(), calls = [];
    let finish;
    const context = setup(item, { window: { location: { href: 'http://localhost/reader.html?document=d&page=p' },
      history: { replaceState() {} } }, selectedPageId: 'p', renderAll() {},
      renderReader: () => calls.push('reader'), setReaderVisualActive: () => calls.push('visual'),
      loadReaderContent: () => new Promise((resolve) => { finish = resolve; }),
    });
    context.state.documentId = item.id;
    context.state.matches = await context.resolveReaderMatches(item, [await visualHit(context, item)]);
    const pending = context.openReaderSearchMatch(context.state.matches[0].id);
    await Promise.resolve();
    if (changed === 'source') item.pages[0].visuals[0].captions[0].text = 'changed';
    if (changed === 'query') context.state.revision++;
    if (changed === 'editing') context.readerEditing = true;
    finish({});
    await pending;
    assert.deepEqual(calls, []);
  });
}


test('visual search revalidates replacement page objects and handles unavailable content', async () => {
  for (const mode of ['replace', 'unavailable']) {
    const item = visualItem(), calls = [];
    const context = setup(item, { window: { location: { href: 'http://localhost/reader.html?document=d&page=p' },
      history: { replaceState() {} } }, selectedPageId: 'p', renderAll() {}, renderReader: () => calls.push('reader'),
      setReaderVisualActive: () => calls.push('visual'),
      loadReaderContent: async () => {
        if (mode === 'unavailable') return null;
        item.pages = structuredClone(item.pages);
        item.pages[0].visuals[0].captions[0].text = 'changed';
        return {};
      },
    });
    context.state.documentId = item.id;
    context.state.matches = await context.resolveReaderMatches(item, [await visualHit(context, item)]);
    await context.openReaderSearchMatch(context.state.matches[0].id);
    assert.deepEqual(calls, []);
    if (mode === 'unavailable') assert.match(context.state.searchError, /重试/);
  }
});
