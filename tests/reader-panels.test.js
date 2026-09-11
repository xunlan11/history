const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function createClassList() {
  const values = new Set();
  return {
    toggle(name, force) {
      if (force) values.add(name);
      else values.delete(name);
    },
    contains(name) {
      return values.has(name);
    },
  };
}

function createButton() {
  const listeners = new Map();
  const attributes = new Map();
  return {
    listeners,
    attributes,
    title: "",
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  };
}

const storage = new Map();
global.localStorage = {
  getItem(key) {
    return storage.get(key) ?? null;
  },
  setItem(key, value) {
    storage.set(key, value);
  },
};
global.SITE_STORAGE_PREFIX = "test";
global.readerCompare = { classList: createClassList() };
global.readerOriginalPanel = { classList: createClassList() };
global.readerAnnotationPanel = { classList: createClassList() };
global.readerOriginalToggle = createButton();
global.readerAnnotationToggle = createButton();

const source = fs.readFileSync("js/reader-panels.js", "utf8");
vm.runInThisContext(source, { filename: "js/reader-panels.js" });

assert.equal(readerCompare.classList.contains("is-original-collapsed"), false);
assert.equal(readerCompare.classList.contains("is-annotation-collapsed"), false);

readerOriginalToggle.listeners.get("click")();
assert.equal(readerCompare.classList.contains("is-original-collapsed"), true);
assert.equal(readerOriginalPanel.classList.contains("reader-panel-collapsed"), true);
assert.equal(readerOriginalToggle.attributes.get("aria-expanded"), "false");
assert.equal(readerOriginalToggle.title, "展开原始资料");

readerAnnotationToggle.listeners.get("click")();
assert.equal(readerCompare.classList.contains("is-original-collapsed"), true);
assert.equal(readerCompare.classList.contains("is-annotation-collapsed"), true);
assert.equal(readerAnnotationPanel.classList.contains("reader-panel-collapsed"), true);
assert.equal(readerAnnotationToggle.attributes.get("aria-expanded"), "false");
assert.deepEqual(JSON.parse(storage.get("test.readerPanels")), {
  originalCollapsed: true,
  annotationCollapsed: true,
});

readerOriginalToggle.listeners.get("click")();
assert.equal(readerCompare.classList.contains("is-original-collapsed"), false);
assert.equal(readerCompare.classList.contains("is-annotation-collapsed"), true);
assert.equal(readerOriginalToggle.attributes.get("aria-expanded"), "true");
