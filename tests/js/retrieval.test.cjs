const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function load() {
  const conversation = {id:'v', turns:[]};
  const context = vm.createContext({ console, URL, URLSearchParams, TextEncoder, Uint8Array, crypto:webcrypto,
    endpoint: (s) => s, conversation, conversations:[conversation], selectedConversationId:'v',
    searchInput:{value:'经费'}, chronicleTopic:{value:''}, selectedSmartMode:'search',
    getSelectedConversation: () => conversation, upsertConversationFromPrompt: () => conversation,
    getConversationContextReport: () => ({error:'',warnings:[]}),
    getSmartScopeDocuments: () => [{id:'original'}], isReferenceScopeActive: () => false,
    getConversationTurnHistory: () => [], attachmentEvidence: () => [],
    refreshConversationTurnView: () => {}, persistConversations: () => {}, showUploadToast: (e) => {throw Error(e);},
    newId: () => 'turn', isLlmServiceConnected: () => true,
    requestLlmTask: async () => ({ready:true,matches:[],warnings:[]}),
    validateFrozenEvidence: async (r) => r,
    getConversationTurn: (id,tid) => ({conversation,turn:conversation.turns.find((t) => t.id===tid)}),
  });
  vm.runInContext(fs.readFileSync('js/retrieval.js','utf8'), context);
  vm.runInContext('const conversationTurnRequests = new Map(); let conversationPromptEditor = null;', context);
  const all = fs.readFileSync('js/conversations.js','utf8');
  for (const name of ['captureConversationTurnRequest','sendConversationTurn','literalConversationTurnResult','generateConversationTurn','saveConversationPromptEdit']) {
    const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(all);
    assert.ok(match, name);
    const rest = all.slice(match.index);
    const next = /\n(?:async )?function \w+\(/.exec(rest);
    vm.runInContext(next ? rest.slice(0,next.index) : rest, context);
  }
  context.attachmentEvidence = () => [];
  context.validateFrozenEvidence = async (r) => r;
  return context;
}

const response = () => ({hits:[{chunkId:'c',documentId:'original',sourceType:'document-page',text:'原文'}],warnings:[],coverage:{}});

test('freeze scope and history before awaiting retrieval', async () => {
  const c = load();
  let finish, sent;
  c.fetchRetrievalEvidence = (r) => {sent=r; return new Promise((resolve) => {finish=resolve;});};
  const pending = c.captureConversationTurnRequest(c.conversation,'search','经费');
  c.getSmartScopeDocuments = () => [{id:'changed'}];
  finish(response());
  const request = await pending;
  assert.deepEqual(Array.from(sent.documentIds), ['original']);
  assert.deepEqual(Array.from(request.retrieval.documentIds), ['original']);
});

test('retry reuses frozen evidence without retrieving again', async () => {
  const c = load();
  const evidence = [{chunkId:'saved',text:'先前材料',sourceType:'document-page',documentId:'original'}];
  c.conversation.turns.push({id:'turn',mode:'search',prompt:'经费',request:{path:'/search',body:{query:'经费',evidence,options:{}},warnings:[],sourceDocumentIds:['original']}});
  c.fetchRetrievalEvidence = () => {throw Error('must not retrieve');};
  let used;
  c.requestLlmTask = async (path, body) => {used=body.evidence; return {ready:true,matches:[]};};
  await c.generateConversationTurn('v','turn');
  assert.equal(used[0].chunkId,'saved');
  assert.equal(c.conversation.turns[0].status,'completed');
});

test('edited prompt retrieves within original scope', async () => {
  const c = load();
  let sent;
  c.fetchRetrievalEvidence = async (r) => {sent=r; return response();};
  c.getSmartScopeDocuments = () => [{id:'changed'}];
  await c.captureConversationTurnRequest(c.conversation,'search','新问题','turn',{retrieval:{documentIds:['original'],textPolicy:'processed'},body:{evidence:[]},warnings:[]});
  assert.deepEqual(Array.from(sent.documentIds),['original']);
  assert.equal(sent.textPolicy,'processed');
});

test('double submit creates one turn', async () => {
  const c = load();
  let finish, calls=0;
  c.fetchRetrievalEvidence = () => {calls++; return new Promise((resolve) => {finish=resolve;});};
  const first = c.sendConversationTurn('search');
  await c.sendConversationTurn('search');
  assert.equal(calls,1);
  finish(response());
  await first;
  assert.equal(c.conversation.turns.length,1);
});

test('attachments are frozen before retrieval resolves', async () => {
  const c = load();
  c.attachmentEvidence = () => [{chunkId:'a',sourceType:'conversation-file',attachmentId:'attachment',text:'附件'}];
  let finish;
  c.fetchRetrievalEvidence = () => new Promise((resolve) => {finish=resolve;});
  const pending = c.captureConversationTurnRequest(c.conversation,'chat','经费');
  c.attachmentEvidence = () => [];
  finish(response());
  const request = await pending;
  assert.ok(request.body.evidence.some((e) => e.attachmentId === 'attachment'));
});

test('generation persists the actual budgeted evidence and chat citations', async () => {
  const c = load();
  const saved = {chunkId:'sent',documentId:'original',sourceType:'document-page',text:'原文'};
  c.conversation.turns.push({id:'turn',mode:'chat',prompt:'经费',request:{path:'/chat',body:{prompt:'经费',evidence:[saved,{chunkId:'trimmed'}],options:{}},warnings:[],sourceDocumentIds:['original']}});
  c.requestLlmTask = async () => ({ready:true,answer:'回答[1]',sources:[saved],usedEvidence:[saved],usedHistory:[],warnings:[]});
  await c.generateConversationTurn('v','turn');
  const turn=c.conversation.turns[0];
  assert.equal(turn.request.body.evidence.length,1);
  assert.equal(turn.result.payload.sources[0].chunkId,'sent');
});
