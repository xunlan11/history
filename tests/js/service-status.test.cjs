const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function load(fetch) {
  const context = vm.createContext({
    fetch,
    OCR_HEALTH_URL: "/ocr/health",
    EMBEDDING_HEALTH_URL: "/data/api/embedding/health",
    LLM_HEALTH_URL: "/llm/health",
    ocrServiceStatus: {}, embeddingServiceStatus: {}, llmServiceStatus: {},
  });
  vm.runInContext(fs.readFileSync("js/service.js", "utf8"), context);
  return context;
}

for (const [response, label, className] of [
  [{ ready: true, healthState: "connected" }, "已连接", "service-ok"],
  [{ ready: false, healthState: "not_ready" }, "未就绪", "service-warn"],
  [{ ready: false, healthState: "unreachable" }, "不可达", "service-warn"],
  [{}, "未连接", "service-warn"],
]) {
  test(`embedding and generation use the same wording: ${label}`, async () => {
    const context = load(async () => ({ ok: true, json: async () => response }));
    await context.refreshEmbeddingServiceStatus();
    await context.refreshLlmServiceStatus();
    for (const node of [context.embeddingServiceStatus, context.llmServiceStatus]) {
      assert.equal(node.textContent, label);
      assert.equal(node.className, className);
    }
  });
}

test("embedding health failure leaves recognition and generation connected", async () => {
  const urls = [];
  const context = load(async (url) => {
    urls.push(url);
    if (url === "/data/api/embedding/health") throw Error("offline");
    return { ok: true, json: async () => ({ ready: true }) };
  });
  await Promise.all([
    context.refreshOcrServiceStatus(),
    context.refreshEmbeddingServiceStatus(),
    context.refreshLlmServiceStatus(),
  ]);
  assert.equal(context.ocrServiceStatus.textContent, "已连接");
  assert.equal(context.embeddingServiceStatus.textContent, "未连接");
  assert.equal(context.llmServiceStatus.textContent, "已连接");
  assert.deepEqual(urls, ["/ocr/health", "/data/api/embedding/health", "/llm/health"]);
});

test("embedding status is independent of a disconnected generation service", async () => {
  const context = load(async (url) => {
    if (url === "/llm/health") return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ ready: true }) };
  });
  await Promise.all([context.refreshEmbeddingServiceStatus(), context.refreshLlmServiceStatus()]);
  assert.equal(context.embeddingServiceStatus.textContent, "已连接");
  assert.equal(context.llmServiceStatus.textContent, "未连接");
});
