const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const context = vm.createContext({URLSearchParams, TextEncoder, Uint8Array, crypto:webcrypto});
vm.runInContext(fs.readFileSync('js/retrieval.js','utf8'),context);

test('Unicode offsets use code points and preserve duplicate quotes', async () => {
  const text='𠀀甲。甲。';
  const hash=await context.hashEvidenceText(text);
  const anchor=await context.resolveEvidenceAnchor({punctuatedText:text},{sourceLayer:'punctuatedText',sourceHash:hash,start:'3',end:'5'});
  assert.equal(anchor.status,'ready');
  assert.equal(Array.from(text).slice(anchor.start,anchor.end).join(''),'甲。');
});

test('changed source cannot highlight old offsets', async () => {
  const hash=await context.hashEvidenceText('旧原文');
  assert.equal((await context.resolveEvidenceAnchor({cleanText:'新原文'},{sourceLayer:'cleanText',sourceHash:hash,start:0,end:2})).status,'stale');
});

test('link carries source layer and offsets without private text', () => {
  const href=context.buildEvidenceHref({documentId:'d',pageId:'p',sourceLayer:'ocrText',sourceHash:'hash',start:2,end:5,text:'私有全文'});
  assert.ok(href.includes('sourceLayer=ocrText'));
  assert.ok(!href.includes('私有'));
});

test('invalid or out of bounds locations degrade to page view', async () => {
  const hash=await context.hashEvidenceText('原文');
  assert.equal((await context.resolveEvidenceAnchor({ocrText:'原文'},{sourceLayer:'ocrText',sourceHash:hash,start:0,end:99})).status,'missing');
});

test('plain HTTP fallback matches SHA-256 for Unicode and block boundaries', async () => {
  const fallback=vm.createContext({URLSearchParams,TextEncoder,Uint8Array});
  vm.runInContext(fs.readFileSync('js/retrieval.js','utf8'),fallback);
  for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '𠀀軍餉\n'.repeat(300)]) {
    assert.equal(await fallback.hashEvidenceText(text),await context.hashEvidenceText(text));
  }
});
