const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { setup: setupContent, digest } = require('./reader-content.test.cjs');

function setup() {
  const env = setupContent();
  const button = env.document.createElement('button');
  button.className = 'reader-sidebar-tab';
  button.dataset.readerSidebarTab = 'catalog';
  button.setAttribute('aria-expanded', 'false');
  const panel = env.document.createElement('section');
  panel.id = 'reader-visual-catalog';
  panel.className = 'reader-sidebar-card reader-visual-catalog';
  panel.hidden = true;
  env.document.body.append(button, panel);
  env.c.setReaderSidebarCardExpanded = (key, expanded) => {
    if (key !== 'catalog') return;
    panel.hidden = !expanded;
    button.setAttribute('aria-expanded', String(expanded));
  };
  const second = { ...env.page, id: 'p2', pageNumber: 9 };
  env.item.pages.push(second);
  env.catalog = { documentId: env.item.id, catalogRevision: 'c1', total: 2, indexedPages: 2, totalPages: 2, complete: true,
    items: [
      { pageId: second.id, pageNumber: second.pageNumber, visualId: 'v1', kind: 'table', renderMode: 'image', title: 'Second table', blockOrder: 0, sourceRevision: 7, status: 'ready' },
      { pageId: env.page.id, pageNumber: env.page.pageNumber, visualId: 'v1', kind: 'table', renderMode: 'image', title: 'First table', blockOrder: 0, sourceRevision: 7, status: 'ready' },
    ] };
  env.requests = []; env.renders = [];
  env.c.fetch = async (url) => { env.requests.push(url); return { ok: true, json: async () => env.catalog }; };
  env.c.renderReader = () => { env.renders.push(env.c.selectedPageId); };
  vm.runInContext(fs.readFileSync('js/reader-visual-catalog.js', 'utf8'), env.c);
  env.state = vm.runInContext('readerVisualCatalogState', env.c);
  env.button = button; env.panel = panel;
  return env;
}
async function open(env) {
  env.panel.hidden = false;
  env.button.setAttribute('aria-expanded', 'true');
  await env.c.syncReaderVisualCatalog(env.item);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('toolbar tab opens the catalogue card and keeps it open after exact page/visual navigation', async () => {
  const env = setup();
  await env.c.syncReaderVisualCatalog(env.item);
  assert.equal(env.requests.length, 0);
  await open(env); await env.c.syncReaderVisualCatalog(env.item);
  assert.equal(env.document.querySelectorAll('[data-reader-sidebar-tab="catalog"]').length, 1);
  assert.equal(env.requests.length, 1);
  assert.equal(env.button.getAttribute('aria-expanded'), 'true');
  const rows = env.state.panel.querySelectorAll('[data-catalog-page-id]');
  assert.deepEqual(rows.map((row) => row.dataset.catalogPageId), [env.page.id, 'p2']);
  env.c.loadReaderContent = async () => env.content;
  const calls = [];
  env.c.setReaderVisualActive = (id, options) => calls.push([id, options.scrollImage, options.scrollText]);
  assert.equal(await env.c.navigateReaderVisualCatalog('p2', 'v1'), true);
  assert.equal(env.c.selectedPageId, 'p2');
  assert.deepEqual(calls, [['v1', true, true]]);
  assert.equal(env.panel.hidden, false);
  assert.ok(env.renders.length >= 1);
});

test('Escape collapses the catalogue card and returns focus to its toolbar tab', async () => {
  const env = setup();
  await open(env);
  env.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(env.panel.hidden, true);
  assert.equal(env.button.getAttribute('aria-expanded'), 'false');
  assert.equal(env.document.activeElement, env.button);
});

test('catalogue reuses the static toolbar card and creates no floating controls', async () => {
  const env = setup();
  await env.c.syncReaderVisualCatalog(env.item);
  assert.equal(env.state.panel, env.panel);
  assert.equal(env.state.button, env.button);
  assert.equal(env.document.querySelectorAll('#reader-visual-catalog-toggle').length, 0);
  assert.equal(env.document.querySelectorAll('[data-reader-catalog-button]').length, 0);
});

test('catalogue rejects a previous document response and invalidates on per-page revisions', async () => {
  const env = setup(); const pending = [];
  env.c.fetch = () => new Promise((resolve) => pending.push(resolve));
  env.panel.hidden = false;
  const first = env.c.syncReaderVisualCatalog(env.item);
  const other = { ...env.item, id: 'other' };
  env.c.getSelectedDocument = () => other;
  const second = env.c.syncReaderVisualCatalog(other);
  pending[1]({ ok: true, json: async () => ({ ...env.catalog, documentId: 'other' }) }); await second;
  pending[0]({ ok: true, json: async () => env.catalog }); await first;
  assert.equal(env.state.catalog.documentId, 'other');
  other.pages[0].processingRevision++;
  env.c.fetch = async () => ({ ok: true, json: async () => ({ ...env.catalog, documentId: 'other', catalogRevision: 'c2' }) });
  await env.c.syncReaderVisualCatalog(other);
  assert.equal(env.state.catalog.catalogRevision, 'c2');
});

test('empty, partial, loading, malformed and error states are visible and retryable', async () => {
  const env = setup(); let resolve;
  env.c.fetch = () => new Promise((done) => { resolve = done; }); env.panel.hidden = false;
  const pending = env.c.syncReaderVisualCatalog(env.item);
  assert.match(env.state.panel.textContent, /正在加载/);
  resolve({ ok: false }); await pending;
  assert.match(env.state.panel.textContent, /加载失败/);
  env.c.fetch = async () => ({ ok: true, json: async () => ({ ...env.catalog, total: 0, items: [], indexedPages: 1, complete: false }) });
  await env.c.syncReaderVisualCatalog(env.item);
  assert.match(env.state.panel.textContent, /目录仍在生成/);
  vm.runInContext('readerVisualCatalogCache.clear()', env.c);
  env.c.fetch = async () => ({ ok: true, json: async () => ({ ...env.catalog, total: 0, items: [] }) });
  await env.c.syncReaderVisualCatalog(env.item);
  assert.match(env.state.panel.textContent, /暂无图表/);
  vm.runInContext('readerVisualCatalogCache.clear()', env.c);
  env.c.fetch = async () => ({ ok: true, json: async () => ({ ...env.catalog, documentId: 'wrong' }) });
  await env.c.syncReaderVisualCatalog(env.item);
  assert.match(env.state.panel.textContent, /数据无效/);
});

test('catalogue saves through the existing edit button and awaits synchronization before changing pages', async () => {
  const env = setup(); await open(env);
  env.c.readerEditing = true; env.readerText.innerText = 'edited text';
  const button = env.document.createElement('button'); button.id = 'edit-document'; env.document.body.append(button);
  env.c.editDocumentButton = button;
  button.addEventListener('click', () => {
    env.page.text = env.readerText.innerText.trim(); env.c.readerEditing = false;
    env.item.updatedAt = 'new'; env.c.syncReaderVisualCatalog(env.item);
  });
  let finishSave;
  env.c.flushPendingSync = () => new Promise((resolve) => { finishSave = resolve; });
  env.c.loadReaderContent = async () => ({ ...env.content, displayedText: env.page.text, textHash: digest(env.page.text),
    items: [{ type: 'text', start: 0, end: env.page.text.length }, { type: 'visual', visualId: 'v1' }] });
  env.item.pages[1].text = 'edited text';
  const navigation = env.c.navigateReaderVisualCatalog('p2', 'v1'); await tick();
  assert.equal(env.c.selectedPageId, env.page.id);
  assert.equal(env.page.text, 'edited text');
  finishSave(true);
  assert.equal(await navigation, true);
  assert.equal(env.c.selectedPageId, 'p2');
});

test('asynchronous local saving defers navigation and a failed sync preserves the current page', async () => {
  const env = setup(); await open(env);
  env.c.readerEditing = true; env.readerText.innerText = 'pending';
  const button = env.document.createElement('button'); button.id = 'edit-document'; env.document.body.append(button);
  env.c.editDocumentButton = button;
  let save;
  button.addEventListener('click', () => { save = () => { env.page.text = 'pending'; env.c.readerEditing = false; }; });
  env.c.syncDirty = true; env.c.flushPendingSync = async () => false;
  const navigation = env.c.navigateReaderVisualCatalog('p2', 'v1'); await tick();
  assert.equal(env.c.selectedPageId, env.page.id);
  save(); assert.equal(await navigation, false);
  assert.equal(env.c.selectedPageId, env.page.id);
  assert.match(env.state.panel.textContent, /请先保存/);
});

test('rapid navigation and changed text discard late content before selecting a visual', async () => {
  const env = setup(); await open(env); const pending = [], selected = [];
  env.c.loadReaderContent = () => new Promise((resolve) => pending.push(resolve));
  env.c.setReaderVisualActive = (id) => selected.push(id);
  const first = env.c.navigateReaderVisualCatalog('p2', 'v1'); await tick();
  const second = env.c.navigateReaderVisualCatalog(env.page.id, 'v1'); await tick();
  pending[1](env.content); assert.equal(await second, true);
  pending[0](env.content); assert.equal(await first, false);
  assert.deepEqual(selected, ['v1']);
  const third = env.c.navigateReaderVisualCatalog('p2', 'v1'); await tick();
  env.item.pages[1].text = 'changed during request';
  pending[2](env.content); assert.equal(await third, false);
  assert.equal(selected.length, 1);
});

test('stale catalogue revisions and missing visuals fail without selecting a different target', async () => {
  const env = setup(); await open(env); const selected = [];
  env.c.setReaderVisualActive = (id) => selected.push(id);
  env.item.pages[1].processingRevision++;
  assert.equal(await env.c.navigateReaderVisualCatalog('p2', 'v1'), false);
  assert.equal(env.c.selectedPageId, env.page.id);
  env.item.pages[1].processingRevision--;
  env.c.loadReaderContent = async () => ({ ...env.content, visuals: {} });
  assert.equal(await env.c.navigateReaderVisualCatalog('p2', 'v1'), false);
  assert.equal(selected.length, 0);
});

test('catalogue selection notification updates the current row', async () => {
  const env = setup(); env.c.canEditDocument = () => true;
  await open(env);
  assert.equal(env.state.panel.querySelector('.reader-visual-backfill'), null);
  env.c.setReaderVisualActive('v1');
  assert.equal(env.state.panel.querySelector('[aria-current="true"]').dataset.catalogPageId, env.page.id);
  const row = env.state.panel.querySelector('[aria-current="true"]'); row.focus();
  env.c.notifyReaderVisualSelected('v1');
  assert.equal(env.document.activeElement.dataset.catalogPageId, env.page.id);
  env.c.clearReaderVisualActive();
  assert.equal(env.state.panel.querySelectorAll('[aria-current="true"]').length, 0);
});

test('late catalogue content cannot rebuild an edit started while the target page is loading', async () => {
  const env = setup(); await open(env);
  let finish;
  env.c.loadReaderContent = () => new Promise((resolve) => { finish = resolve; });
  const navigation = env.c.navigateReaderVisualCatalog('p2', 'v1'); await tick();
  const renderedBeforeEdit = env.renders.length;
  env.c.readerEditing = true;
  env.readerText.textContent = 'UNSAVED DRAFT';
  finish(env.content);
  assert.equal(await navigation, false);
  assert.equal(env.renders.length, renderedBeforeEdit);
  assert.equal(env.readerText.textContent, 'UNSAVED DRAFT');
});

test('catalogue navigation synchronizes the route before displaying the target page', async () => {
  const env = setup(); await open(env);
  const routes = [];
  env.c.syncSelectionToUrl = () => routes.push(env.c.selectedPageId);
  env.c.loadReaderContent = async () => env.content;
  assert.equal(await env.c.navigateReaderVisualCatalog('p2', 'v1'), true);
  assert.deepEqual(routes, ['p2']);
});
