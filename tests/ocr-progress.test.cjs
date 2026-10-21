const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function functionsFrom(path, first, last) {
  const source = fs.readFileSync(path, 'utf8');
  return source.slice(source.indexOf(first), source.indexOf(last, source.indexOf(first)));
}

function context() {
  const ctx = vm.createContext({});
  vm.runInContext(functionsFrom('js/core.js', 'function normalizeOcrProgressDetail', 'function normalizeProcessingTask'), ctx);
  vm.runInContext(functionsFrom('js/registration.js', 'const BACKEND_REGISTRATION_STAGES', 'function describeDocumentUploadState'), ctx);
  vm.runInContext(functionsFrom('js/processing.js', 'function isStagePageTerminal', 'function renderStreamProgress'), ctx);
  return ctx;
}

const observed = {stage:'文字识别', completed:8, total:32, unit:'文字区域',
  basis:'pipeline_steps', status:'running', pageNumber:2, pageTotal:3};

test('body progress retains observed details through normalization', () => {
  const ctx = context();
  const normalized = ctx.normalizeStagePages({ocr:{pageNumber:4,percent:65,detail:observed}});
  assert.equal(normalized.ocr.pageNumber,4);
  assert.equal(normalized.ocr.percent,65);
  assert.equal(normalized.ocr.detail.completed,8);
  assert.equal(normalized.ocr.detail.total,32);
  assert.equal(ctx.describeOcrProgressDetail(normalized.ocr.detail),'文字识别 · 8/32 个文字区域');
});

test('registration presents aggregated OCR percentage and actual candidate counts', () => {
  const ctx = context();
  const live = ctx.normalizeRegistrationProgress({stage:'metadata_candidate',percent:50,detail:observed});
  const label = ctx.describeBackendRegistration({processingTask:{registrationProgress:live}});
  assert.match(label, /登记中 35%/);
  assert.match(label, /候选 OCR 50%/);
  assert.match(label, /候选页 2\/3/);
  assert.match(label, /8\/32 个文字区域/);
});

test('registration without measured OCR stays at stage start', () => {
  const ctx = context();
  assert.equal(ctx.describeBackendRegistration({processingTask:{currentPageStage:'metadata_candidate'}}),'登记中 20%');
  assert.equal(ctx.describeBackendRegistration({processingTask:{currentPageStage:'metadata'}}),'登记中 50%');
});

test('LLM registration and page progress keep their prior percentage contract', () => {
  const ctx = context();
  const live = ctx.normalizeRegistrationProgress({stage:'metadata',percent:40});
  assert.equal(ctx.describeBackendRegistration({processingTask:{registrationProgress:live}}),'登记中 70%');
  assert.equal(ctx.normalizeStagePages({punctuation:{pageNumber:3,percent:52}}).punctuation.percent,52);
});

test('active ring uses current page rather than completed-page count', () => {
  const ctx = context();
  const state = ctx.stagePageState({pages:[]},{activeStages:{ocr:{pageNumber:4}}},'ocr',3,10);
  assert.equal(state.pageNumber,4);
  assert.equal(state.active,true);
});

function renderContext() {
  const ctx = context();
  const detail = {textContent:'',classList:{toggle(){}},title:''};
  const root = {title:'',classList:{toggle(name, value){this[name]=value;}}};
  const ring = {};
  Object.assign(ctx, {streamProgress:{classList:{add(){},remove(){}}},
    progressTotalNode:null,progressModeNode:null,progressOcrDetailNode:detail,
    progressStageNodes:new Map([['ocr',{root,ring,pages:{}}]]),
    progressStageFills:new Map(),
    PROCESSING_STAGE_CONFIG:[{key:'ocr',label:'文字识别'}],
    clampPercent:(value)=>Math.max(0,Math.min(100,value)),
    renderFailedProcessingPages(){},setRingProgress(node,percent){node.percent=percent;}});
  vm.runInContext(fs.readFileSync('js/processing.js','utf8').slice(
    fs.readFileSync('js/processing.js','utf8').indexOf('function renderStreamProgress')),ctx);
  return {ctx,detail,root,ring};
}

test('observed zero progress renders zero instead of fabricated rotating arc', () => {
  const {ctx,detail,root,ring} = renderContext();
  ctx.renderStreamProgress({pages:[],processingTask:{totalPages:5,status:'处理中',
    activeStages:{ocr:{pageNumber:2}}, stagePages:{ocr:{pageNumber:2,percent:0,detail:observed}}}});
  assert.equal(ring.percent,0);
  assert.equal(root.classList['is-active'],false);
  assert.match(detail.textContent,/第 2 页 · 文字识别 · 8\/32/);
});

test('selected registration document displays live candidate OCR details', () => {
  const {ctx,detail} = renderContext();
  ctx.renderStreamProgress({pages:[],processingTask:{totalPages:0,status:'登记中',
    registrationProgress:{stage:'metadata_candidate',percent:50,detail:observed}}});
  assert.equal(detail.textContent,'登记 OCR 50% · 候选页 2/3 · 文字识别 · 8/32 个文字区域');
});

test('old-page details cannot label a newly active page', () => {
  const {ctx,detail,root} = renderContext();
  ctx.renderStreamProgress({pages:[],processingTask:{totalPages:5,status:'处理中',
    activeStages:{ocr:{pageNumber:3}}, stagePages:{ocr:{pageNumber:2,percent:65,detail:observed}}}});
  assert.equal(detail.textContent,'');
  assert.doesNotMatch(root.title,/8\/32/);
  assert.equal(root.classList['is-active'],true);
});
