function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDateTime(date) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
  const time = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ].join(":");

  return `${parts.join("-")} ${time}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return map[char];
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emptyState(message) {
  const node = document.createElement("div");
  node.className = "empty-state";
  node.textContent = message;
  return node;
}

function renderResultState(container, message) {
  container.innerHTML = "";
  container.classList.add("empty-result-list");
  const empty = emptyState(message);
  empty.classList.add("result-empty");
  container.append(empty);
}

function formatWarnings(warnings) {
  const node = document.createElement("p");
  node.className = "meta-line";
  node.textContent = `提示：${warnings.join("；")}`;
  return node;
}

function readImageFile(file, callback) {
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    callback({
      dataUrl: reader.result,
      name: file.name,
    });
  });
  reader.readAsDataURL(file);
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(",");
  const mimeMatch = header.match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : "image/png";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mime });
}

function buildSnippet(text, query) {
  const haystack = text || "";
  const index = haystack.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) {
    return "";
  }

  const start = Math.max(0, index - 36);
  const end = Math.min(haystack.length, index + query.length + 72);
  return `${start > 0 ? "..." : ""}${haystack.slice(start, end)}${end < haystack.length ? "..." : ""}`;
}

function highlight(text, query) {
  const escaped = escapeRegExp(query);
  return escapeHtml(text).replace(new RegExp(escaped, "gi"), (match) => `<mark>${match}</mark>`);
}
