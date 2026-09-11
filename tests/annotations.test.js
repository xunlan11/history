const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const listeners = new Map();
global.readerAnnotation = {
  dataset: {},
  value: "",
  disabled: false,
  addEventListener(type, callback) {
    listeners.set(type, callback);
  },
};
global.readerAnnotationStatus = { textContent: "" };
global.DOCUMENT_ANNOTATION_API_URL = "/api/documents";
global.window = global;
global.window.addEventListener = () => {};

const requests = [];
global.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (!options.method) {
    return {
      ok: true,
      json: async () => ({ content: "已有笺注" }),
    };
  }
  const body = JSON.parse(options.body);
  return {
    ok: true,
    json: async () => ({ status: "ok", content: body.content }),
  };
};

const source = fs.readFileSync("js/annotations.js", "utf8");
vm.runInThisContext(source, { filename: "js/annotations.js" });

(async () => {
  await renderReaderAnnotation({ id: "document 1" }, { id: "page/1" });
  assert.equal(readerAnnotation.value, "已有笺注");
  assert.equal(readerAnnotation.disabled, false);
  assert.equal(readerAnnotationStatus.textContent, "已保存");
  assert.equal(requests[0].url, "/api/documents/document%201/pages/page%2F1/annotation");

  readerAnnotation.value = "当前用户的新笺注";
  listeners.get("input")();
  const key = readerAnnotation.dataset.annotationKey;
  await flushReaderAnnotationSave(key);

  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[1].options.body), { content: "当前用户的新笺注" });
  assert.equal(readerAnnotationStatus.textContent, "已保存");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
