(() => {
  // 修改（续传）弹窗复用首次登记的片段与脚本，所以片段必须先于 core.js 注入。
  const scripts = [
    "../js/core.js",
    "../js/auth.js",
    "../js/variant.js",
    "../js/retrieval.js",
    "../js/reader.js",
    "../js/reader-content.js",
    "../js/reader-visual-catalog.js",
    "../js/reader-outline.js",
    "../js/reader-search.js",
    "../js/shelf.js",
    "../js/documents.js",
    "../js/processing.js",
    "../js/registration.js",
    "../js/revise.js",
    "../js/service.js",
    "../js/export.js",
    "../js/main.js",
  ];

  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL(path, document.baseURI).href;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`应用脚本加载失败：${path}`));
      document.body.append(script);
    });
  }

  async function start() {
    const slot = document.querySelector("#registration-fragment-slot");
    if (!slot) throw new Error("页面缺少登记片段插槽");
    const url = new URL("partials/registration.html", document.baseURI);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`公共片段加载失败：${url.pathname}（${response.status}）`);
    slot.innerHTML = await response.text();
    for (const path of scripts) {
      await loadScript(path);
    }
  }

  start().catch((error) => {
    console.error(error);
    const node = document.createElement("p");
    node.className = "startup-error";
    node.textContent = "页面组件加载失败，请刷新后重试。";
    document.body.append(node);
  });
})();
