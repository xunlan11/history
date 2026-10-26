const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function element() {
  const classes = new Set();
  const selectors = new Map();
  const node = {
    value: '', textContent: '', disabled: false, children: [], parentNode: null,
    classList: {
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name),
    },
    querySelector(selector) { if (!selectors.has(selector)) selectors.set(selector, element()); return selectors.get(selector); },
    append(child) { child.remove(); this.children.push(child); child.parentNode = this; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((item) => item !== this); this.parentNode = null; },
    replaceChildren() { this.children.forEach((child) => { child.parentNode = null; }); this.children = []; },
  };
  return node;
}

function setup() {
  const nodes = new Map();
  const listeners = new Map();
  const requests = [];
  const calls = [];
  const find = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const context = vm.createContext({
    console, AbortController, DOMException, SITE_STORAGE_PREFIX: 'test',
    localStorage: { getItem: () => null },
    window: {
      setTimeout: (fn, delay) => setTimeout(fn, delay < 10000 ? 0 : delay), clearTimeout,
      addEventListener: (name, fn) => listeners.set(name, fn),
    },
    document: { querySelector: find, querySelectorAll: () => [], body: element() },
    endpoint: (path) => path, nextId: 0, newId: () => `upload-${++context.nextId}`,
    form: { reset() {} }, formSheet: { dataset: {} }, documents: [],
    normalizeDocuments: (items) => items, cacheCurrentState() {},
    normalizeProcessingMode: (value) => value || 'chunked', clampChunkSize: () => 3,
    textValue: () => '', getNextDocumentCoverVariant: () => 0,
    startProcessingPolling() {}, renderAll() {}, closeDocumentForm() { context.closed = true; },
    FormData: class { constructor() { this.values = new Map(); } append(k, v) { this.values.set(k, v); } get(k) { return this.values.get(k); } },
    XMLHttpRequest: class {
      constructor() { this.upload = {}; requests.push(this); }
      open(method, url) { this.url = url; }
      setRequestHeader() {}
      send() { this.sent = true; }
      abort() { this.aborted = true; this.onabort?.(); }
      complete(status = 200, payload = { status: 'ready' }) { this.status = status; this.responseText = JSON.stringify(payload); this.onload(); }
      progress(loaded, total) { this.upload.onprogress({ lengthComputable: true, loaded, total }); }
    },
    fetch: async (url, options = {}) => { calls.push({ url, ...options }); return { ok: true, json: async () => ({ status: 'uploading' }) }; },
  });
  vm.runInContext(fs.readFileSync('js/registration.js', 'utf8'), context);
  context.createUploadRow = () => element();
  return { c: context, find, requests, calls, listeners, batch: () => vm.runInContext('registrationBatch', context) };
}
const file = (name = 'book.pdf') => ({ name, size: 100, type: 'application/pdf' });
async function uploaded(s, files = [file()]) {
  const first = s.requests.length;
  const pending = s.c.startRegistrationUploads(files);
  await tick();
  s.requests.slice(first).forEach((request) => request.complete());
  await pending;
}
function documentResult(id) { return { document: { id, title: 'merged history', pages: [], processingTask: { backendManaged: true } } }; }

test('multiple files upload independently and all need server acknowledgement before registration', async () => {
  const s = setup();
  const pending = s.c.startRegistrationUploads([file('one.pdf'), file('two.pdf')]);
  await tick();
  assert.equal(s.requests.length, 2);
  const [one, two] = s.batch().files;
  s.requests[0].progress(50, 100);
  assert.equal(one.row.querySelector('progress').value, 50);
  assert.equal(two.row.querySelector('progress').value, 0);
  s.requests[0].progress(100, 100);
  assert.equal(one.row.querySelector('progress').value, 99);
  s.requests[0].complete();
  await tick();
  assert.equal(one.percent, 100);
  assert.equal(s.find('#register-document').disabled, true);
  s.requests[1].complete();
  await pending;
  assert.equal(s.find('#register-document').disabled, false);
  assert.equal(s.c.documents.length, 0);
  s.c.cancelRegistrationUpload();
});

test('selecting more files appends them without replacing or retransmitting existing uploads', async () => {
  const s = setup();
  await uploaded(s, [file('one.pdf')]);
  const first = s.batch().files[0];
  await uploaded(s, [file('two.pdf'), file('three.pdf')]);
  assert.deepEqual(Array.from(s.batch().files, (entry) => entry.file.name), ['one.pdf', 'two.pdf', 'three.pdf']);
  assert.equal(s.batch().files[0], first);
  assert.equal(s.requests.length, 3);
  assert.equal(s.find('#upload-file-list').children.length, 3);
  s.c.cancelRegistrationUpload();
});

test('one file exhausting three attempts does not interrupt another completed file', async () => {
  const s = setup();
  const pending = s.c.startRegistrationUploads([file('good.pdf'), file('bad.pdf')]);
  await tick();
  s.requests[0].complete();
  for (let index = 1; index <= 3; index++) {
    while (s.requests.length <= index) await tick();
    s.requests[index].onerror();
  }
  await pending;
  const [good, bad] = s.batch().files;
  assert.equal(good.status, 'ready');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.row.querySelector('.file-upload-meter').classList.contains('hidden'), true);
  assert.equal(bad.row.querySelector('.file-upload-failed').classList.contains('hidden'), false);
  assert.equal(s.find('#register-document').disabled, true);
  s.c.removeRegistrationUpload(bad.id);
  assert.equal(s.find('#register-document').disabled, false);
  assert.equal(s.batch().files[0], good);
  s.c.cancelRegistrationUpload();
});

test('same file name added again in one registration is skipped with a prompt', async () => {
  const s = setup();
  await uploaded(s, [file('one.pdf'), file('two.pdf')]);
  const existing = Array.from(s.batch().files, (entry) => entry.id);
  const before = s.requests.length;
  const pending = s.c.startRegistrationUploads([file('one.pdf'), file('three.pdf')]);
  await tick();
  // 重复的 one.pdf 不再上传，只给 three.pdf 建请求。
  assert.equal(s.requests.length, before + 1);
  s.requests[before].complete();
  await pending;
  assert.deepEqual(Array.from(s.batch().files, (entry) => entry.file.name), ['one.pdf', 'two.pdf', 'three.pdf']);
  assert.deepEqual(Array.from(s.batch().files.slice(0, 2), (entry) => entry.id), existing);
  assert.equal(s.find('#upload-file-list').children.length, 3);
  assert.match(s.find('#registration-error').textContent, /「one\.pdf」已上传，取消重复操作/);
  assert.equal(s.find('#register-document').disabled, false);
  s.c.cancelRegistrationUpload();
});

test('a selection of only duplicates uploads nothing and the name can be re-added after removal', async () => {
  const s = setup();
  await uploaded(s, [file('Book.pdf')]);
  const before = s.requests.length;
  await s.c.startRegistrationUploads([file(' book.PDF '), file('BOOK.pdf')]);
  assert.equal(s.requests.length, before);
  assert.equal(s.batch().files.length, 1);
  assert.match(s.find('#registration-error').textContent, /已上传，取消重复操作/);
  // 删掉原来那个之后，同名文件可以重新加入。
  s.c.removeRegistrationUpload(s.batch()?.files[0]?.id || '');
  await uploaded(s, [file('book.pdf')]);
  assert.deepEqual(Array.from(s.batch().files, (entry) => entry.file.name), ['book.pdf']);
  s.c.cancelRegistrationUpload();
});

test('deleting a file cancels only its request and discards its late success', async () => {
  const s = setup();
  const pending = s.c.startRegistrationUploads([file('one.pdf'), file('two.pdf')]);
  await tick();
  const removed = s.batch().files[0];
  s.c.removeRegistrationUpload(removed.id);
  assert.equal(s.requests[0].aborted, true);
  assert.equal(s.requests[1].aborted, undefined);
  s.requests[0].complete();
  s.requests[1].complete();
  await pending;
  assert.equal(s.batch().files.length, 1);
  assert.equal(s.batch().files[0].file.name, 'two.pdf');
  assert.equal(s.find('#upload-file-list').children.length, 1);
  assert.equal(s.c.documents.length, 0);
  s.c.removeRegistrationUpload(s.batch().files[0].id);
  assert.equal(s.batch(), null);
  assert.equal(s.find('#register-document').disabled, true);
});

test('cancel during retry delay prevents another request', async () => {
  const s = setup();
  const pending = s.c.startRegistrationUploads([file()]);
  await tick();
  const id = s.batch().files[0].id;
  s.requests[0].onerror();
  await Promise.resolve();
  s.c.removeRegistrationUpload(id);
  await pending;
  assert.equal(s.requests.length, 1);
  assert.equal(s.calls.at(-1).method, 'DELETE');
  assert.equal(s.calls.at(-1).keepalive, true);
});

test('drag ordering changes only merge order and progress updates keep rows in place', async () => {
  const s = setup();
  const pending = s.c.startRegistrationUploads([file('one.pdf'), file('two.pdf'), file('three.pdf')]);
  await tick();
  const [one, two, three] = s.batch().files;
  s.c.moveRegistrationUpload(three.id, one.id);
  s.requests[0].progress(40, 100);
  assert.deepEqual(Array.from(s.batch().files, (entry) => entry.file.name), ['three.pdf', 'one.pdf', 'two.pdf']);
  assert.deepEqual(s.find('#upload-file-list').children, [three.row, one.row, two.row]);
  assert.equal(s.requests.length, 3);
  s.requests.forEach((request) => request.complete());
  await pending;
  let body;
  s.c.fetch = async (url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => documentResult(s.batch().id) }; };
  await s.c.registerSelectedUploads();
  assert.deepEqual(body.uploadIds, [three.id, one.id, two.id]);
  assert.equal(s.c.documents.length, 1);
  assert.equal(s.batch(), null);
});

test('registration locks append, delete, reorder and duplicate submission until one card is confirmed', async () => {
  const s = setup();
  await uploaded(s, [file('one.pdf'), file('two.pdf')]);
  const batch = s.batch();
  const ids = Array.from(batch.files, (entry) => entry.id);
  let respond, calls = 0;
  s.c.fetch = () => { calls++; return new Promise((resolve) => { respond = resolve; }); };
  const pending = s.c.registerSelectedUploads();
  s.c.startRegistrationUploads([file('three.pdf')]);
  s.c.removeRegistrationUpload(ids[0]);
  s.c.moveRegistrationUpload(ids[1], ids[0]);
  await s.c.registerSelectedUploads();
  assert.deepEqual(Array.from(batch.files, (entry) => entry.id), ids);
  assert.equal(s.find('#file-input').disabled, true);
  assert.equal(s.find('#close-document-form').disabled, true);
  assert.equal(batch.files[0].row.querySelector('.file-upload-remove').disabled, true);
  assert.equal(s.c.documents.length, 0);
  assert.equal(calls, 1);
  respond({ ok: true, json: async () => documentResult(batch.id) });
  await pending;
  assert.equal(s.c.documents.length, 1);
  assert.equal(s.c.documents[0].id, batch.id);
  assert.equal(s.find('#upload-file-list').children.length, 0);
  assert.equal(s.c.closed, true);
});

test('pagehide cancels the whole unregistered list without beforeunload or cards', async () => {
  const s = setup();
  const pending = s.c.startRegistrationUploads([file('one.pdf'), file('two.pdf')]);
  await tick();
  assert.equal(s.listeners.has('beforeunload'), false);
  s.listeners.get('pagehide')();
  await pending;
  assert.equal(s.batch(), null);
  assert.equal(s.find('#upload-file-list').children.length, 0);
  assert.equal(s.calls.filter((call) => call.method === 'DELETE').length, 2);
  assert.equal(s.c.documents.length, 0);
});

test('lost registration response checks the batch result once', async () => {
  const s = setup();
  await uploaded(s, [file('one.pdf'), file('two.pdf')]);
  const id = s.batch().id;
  let checks = 0;
  s.c.fetch = async (url) => {
    if (url.endsWith('/register')) throw new Error('response lost');
    assert(url.endsWith('/registrations/' + id)); checks++;
    return { ok: true, json: async () => ({ status: 'registered', ...documentResult(id) }) };
  };
  await s.c.registerSelectedUploads();
  assert.equal(checks, 1);
  assert.equal(s.c.documents.length, 1);
});

test('merge failure preserves every completed file and order for correction', async () => {
  const s = setup();
  await uploaded(s, [file('one.pdf'), file('two.pdf')]);
  const batch = s.batch();
  s.c.fetch = async (url) => ({ ok: !url.endsWith('/register'), status: 422,
    json: async () => url.endsWith('/register') ? { detail: 'bad.pdf is invalid' } : { status: 'pending' } });
  await s.c.registerSelectedUploads();
  assert.equal(s.batch(), batch);
  assert.equal(batch.status, 'editing');
  assert.equal(batch.files.length, 2);
  assert(batch.files.every((entry) => entry.percent === 100));
  assert.equal(s.find('#register-document').disabled, false);
  assert.match(s.find('#registration-error').textContent, /bad.pdf/);
  assert.equal(s.c.documents.length, 0);
  assert.equal(s.requests.length, 2);
  s.c.cancelRegistrationUpload();
});

test('lost upload response uses confirmed server state without retransmitting', async () => {
  const s = setup();
  let starts = 0;
  s.c.fetch = async () => ({ ok: true, json: async () => ({ status: ++starts === 1 ? 'uploading' : 'ready' }) });
  const pending = s.c.startRegistrationUploads([file()]);
  await tick();
  s.requests[0].onerror();
  await pending;
  assert.equal(s.requests.length, 1);
  assert.equal(s.batch().files[0].status, 'ready');
  assert.equal(s.find('#register-document').disabled, false);
  s.c.cancelRegistrationUpload();
});
