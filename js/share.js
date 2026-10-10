(() => {
  const segments = window.location.pathname.split("/").filter(Boolean);
  const siteId = segments[0] && segments[0].toLowerCase() !== "html" ? segments[0] : "history";
  const apiBase = `/${siteId}/api/data/api/conversation-shares`;
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";
  const title = document.querySelector("#shared-conversation-title");
  const status = document.querySelector("#shared-conversation-status");
  const turns = document.querySelector("#shared-conversation-turns");

  function appendText(parent, className, value) {
    const node = document.createElement("p");
    node.className = className;
    node.textContent = value || "";
    parent.append(node);
    return node;
  }

  function renderContent(parent, content) {
    if (content?.type === "search" || content?.type === "chronicle") {
      (content.items || []).forEach((item) => {
        const result = document.createElement("div");
        result.className = "conversation-share-page-result";
        if (item.title) appendText(result, "conversation-share-page-result-title", item.title);
        if (item.meta) appendText(result, "conversation-share-page-result-meta", item.meta);
        appendText(result, "conversation-share-page-result-text", item.text);
        parent.append(result);
      });
      if (!content.items?.length) appendText(parent, "conversation-share-page-empty", "此轮没有可展示的结果。");
      return;
    }
    appendText(parent, "conversation-share-page-answer", content?.text || "");
  }

  function render(payload) {
    title.textContent = payload.title || "分享的对话";
    status.textContent = "只读分享 · 内容按原对话顺序展示";
    turns.replaceChildren();
    (payload.turns || []).forEach((turn, index) => {
      const article = document.createElement("article");
      const number = document.createElement("span");
      const prompt = document.createElement("p");
      const answer = document.createElement("div");
      article.className = "conversation-share-page-turn";
      number.className = "conversation-share-page-number";
      number.textContent = `第 ${index + 1} 轮`;
      prompt.className = "conversation-share-page-prompt";
      prompt.textContent = turn.prompt || "";
      answer.className = "conversation-share-page-answer-wrap";
      article.append(number, prompt, answer);
      renderContent(answer, turn.content);
      turns.append(article);
    });
    if (!payload.turns?.length) {
      status.textContent = "分享内容为空。";
    }
  }

  async function load() {
    if (!token) {
      title.textContent = "分享链接无效";
      status.textContent = "缺少分享链接标识，无法读取内容。";
      return;
    }
    try {
      const response = await fetch(`${apiBase}/${encodeURIComponent(token)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "分享链接不存在或已失效。");
      render(payload);
    } catch (error) {
      title.textContent = "分享链接已失效";
      status.textContent = error.message || "无法读取分享内容。";
    }
  }

  load();
})();
