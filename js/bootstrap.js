(() => {
  const fragmentDefinitions = [
    { slot: "#delete-fragment-slot", path: "partials/delete.html" },
    { slot: "#registration-fragment-slot", path: "partials/registration.html" },
    { slot: "#document-shelf-slot", path: "partials/shelf.html" },
  ];

  const commonScripts = [
    "../js/core.js",
    "../js/auth.js",
  ];
  const documentScripts = [
    "../js/documents.js",
    "../js/processing.js",
    "../js/registration.js",
    "../js/service.js",
    "../js/main.js",
  ];

  function loadFragment(definition) {
    const slot = document.querySelector(definition.slot);
    if (!slot) {
      throw new Error(`页面缺少片段插槽：${definition.slot}`);
    }
    const url = new URL(definition.path, document.baseURI);
    return fetch(url, { cache: "no-store" }).then((response) => {
      if (!response.ok) {
        throw new Error(`公共片段加载失败：${url.pathname}（${response.status}）`);
      }
      return response.text();
    }).then((html) => {
      slot.innerHTML = html;
      return slot;
    });
  }

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

  function configureDocumentShelf() {
    const slot = document.querySelector("#document-shelf-slot");
    const stage = slot?.querySelector("[data-shelf-stage]");
    const list = slot?.querySelector("[data-shelf-list]");
    if (!slot || !stage || !list) {
      throw new Error("书架片段缺少容器或列表元素");
    }

    stage.className = slot.dataset.stageClass || "shelf-stage";
    list.id = slot.dataset.listId || "document-list";
    slot.replaceWith(stage);
  }

  function setDeleteDialogTitle() {
    const slot = document.querySelector("#delete-fragment-slot");
    const title = slot?.dataset.title || "删除内容";
    const titleNode = document.querySelector("#delete-conversation-title");
    if (!titleNode) {
      throw new Error("删除确认弹窗片段缺少标题元素");
    }
    titleNode.textContent = title;
  }

  function showStartupError(error) {
    console.error(error);
    const node = document.createElement("p");
    node.className = "startup-error";
    node.textContent = "页面组件加载失败，请刷新后重试。";
    document.body.append(node);
  }

  async function startApplication() {
    const fragments = [...fragmentDefinitions];
    if (document.body.dataset.page === "library") {
      fragments.push(
        { slot: "#settings-fragment-slot", path: "partials/settings.html" },
        { slot: "#reference-documents-fragment-slot", path: "partials/reference.html" },
      );
    }
    await Promise.all(fragments.map(loadFragment));
    configureDocumentShelf();
    setDeleteDialogTitle();

    const scripts = [...commonScripts];
    if (document.body.dataset.page === "library") {
      scripts.push("../js/accounts.js", "../js/conversations.js");
    }
    scripts.push(...documentScripts);
    for (const path of scripts) {
      await loadScript(path);
    }
  }

  startApplication().catch(showStartupError);
})();