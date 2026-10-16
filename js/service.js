let versionUpdateRequested = false;
// 本页加载时线上发布的提交；轮询发现它变了，说明别人（或别的浏览器）发布了新版本
let loadedCommit = "";
let versionRefreshPending = false;

// 有未保存的整理文本编辑 / 进行中的上传时不能强刷，否则会丢内容。
// （上传还有 registration.js 的 beforeunload 兜底，但这里直接跳过更干净。）
function versionRefreshBlocked() {
  if (typeof readerEditing !== "undefined" && readerEditing) {
    return true;
  }
  return typeof hasActiveDocumentUpload === "function" && hasActiveDocumentUpload();
}

function refreshPageWithFreshAssets() {
  if (typeof reloadWithFreshAssets === "function") {
    reloadWithFreshAssets();
    return;
  }
  window.location.reload();
}

// 发布版本变了：先广播给同一浏览器的其它页面，再刷新本页。
// 本页后台标签页、或没有未保存内容时立即刷新；可见且正在编辑则挂起，
// 等编辑结束（下次轮询，≤30s）或页面转到后台时再刷。
function applyVersionRefresh() {
  if (!versionRefreshPending) {
    return;
  }
  if (document.visibilityState !== "hidden" && versionRefreshBlocked()) {
    return;
  }
  refreshPageWithFreshAssets();
}

function requestVersionRefresh() {
  if (!versionRefreshPending) {
    versionRefreshPending = true;
    if (typeof broadcastPlatformReload === "function") {
      broadcastPlatformReload();
    }
  }
  applyVersionRefresh();
}

document.addEventListener("visibilitychange", applyVersionRefresh);

function setServiceStatus(node, text, className) {
  if (!node) {
    return;
  }

  node.textContent = text;
  node.className = className;
}

async function fetchServiceJson(url, errorMessage, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
  });

  if (!response.ok) {
    throw new Error(`${errorMessage}: ${response.status}`);
  }

  return response.json();
}

// 状态由数据端分类；未连接仅用于浏览器无法正常取得健康检查结果。
function renderModelServiceStatus(node, result) {
  if (!result || typeof result.ready !== "boolean") {
    throw new Error("Invalid service health response");
  }
  const upstream = result.upstream || {};
  // 只有明确报告 reachable=false 时，才将已配置但暂时无法访问的服务标为不可达。
  const state = result.ready ? "connected" : (result.healthState ||
    (upstream.configured && upstream.reachable === false ? "unreachable" : "not_ready"));
  const label = result.ready ? "已连接" : state === "unreachable" ? "不可达" : "未就绪";
  setServiceStatus(node, label, result.ready ? "service-ok" : "service-warn");
}

async function refreshOcrServiceStatus() {
  if (!ocrServiceStatus) return;
  try {
    const result = await fetchServiceJson(OCR_HEALTH_URL, "OCR health check failed");
    renderModelServiceStatus(ocrServiceStatus, result);
  } catch (error) {
    setServiceStatus(ocrServiceStatus, "未连接", "service-warn");
  }
}

async function refreshEmbeddingServiceStatus() {
  if (!embeddingServiceStatus) return;
  try {
    const result = await fetchServiceJson(EMBEDDING_HEALTH_URL, "Embedding health check failed");
    renderModelServiceStatus(embeddingServiceStatus, result);
  } catch (error) {
    setServiceStatus(embeddingServiceStatus, "未连接", "service-warn");
  }
}

async function refreshLlmServiceStatus() {
  if (!llmServiceStatus) return;
  try {
    const result = await fetchServiceJson(LLM_HEALTH_URL, "LLM health check failed");
    renderModelServiceStatus(llmServiceStatus, result);
  } catch (error) {
    setServiceStatus(llmServiceStatus, "未连接", "service-warn");
  }
}

function showVersionStatus(text, className = "service-warn") {
  if (!versionServiceStatus || !versionUpdateButton) {
    return;
  }

  setServiceStatus(versionServiceStatus, text, className);
  versionServiceStatus.classList.remove("hidden");
  versionUpdateButton.classList.add("hidden");
  versionUpdateButton.disabled = false;
  versionUpdateButton.textContent = "更新";
}

function showVersionUpdateButton() {
  if (!versionServiceStatus || !versionUpdateButton) {
    return;
  }

  versionServiceStatus.classList.add("hidden");
  versionUpdateButton.classList.remove("hidden");
  versionUpdateButton.disabled = false;
  versionUpdateButton.textContent = "更新";
}

async function refreshVersionStatus() {
  try {
    const result = await fetchServiceJson(VERSION_STATUS_URL, "Version check failed");

    // 别人发布了新版本（currentCommit 变了）→ 全站自动跟上，无需手工强刷。
    // 这段不依赖版本状态节点，所以阅读页等没有该节点的页面也照样自动刷新。
    // 本页自己的「更新」流程走下面的 versionUpdateRequested 分支，不在这里处理。
    if (!versionUpdateRequested) {
      if (!loadedCommit) {
        loadedCommit = result.currentCommit || "";
      } else if (result.currentCommit && result.currentCommit !== loadedCommit) {
        requestVersionRefresh();
        return;
      }
    }

    if (!versionServiceStatus || !versionUpdateButton) {
      return;
    }

    if (result.updating) {
      showVersionStatus("更新中", "service-warn");
      if (versionUpdateRequested) {
        window.setTimeout(refreshVersionStatus, 1000);
      }
      return;
    }

    if (versionUpdateRequested) {
      versionUpdateRequested = false;
      if (result.lastError) {
        showVersionStatus("更新失败", "service-warn");
        return;
      }
      // 先通知其它已打开的页面刷新，再刷新本页
      if (typeof broadcastPlatformReload === "function") {
        broadcastPlatformReload();
      }
      refreshPageWithFreshAssets();
      return;
    }

    if (result.updateAvailable) {
      showVersionUpdateButton();
      return;
    }

    showVersionStatus(result.configured === false ? "待配置" : "最新", result.configured === false ? "service-warn" : "service-ok");
  } catch (error) {
    showVersionStatus("未连接", "service-warn");
  }
}

async function requestProjectUpdate() {
  if (!versionServiceStatus || !versionUpdateButton) {
    return;
  }

  versionUpdateRequested = true;
  versionUpdateButton.disabled = true;
  versionUpdateButton.textContent = "更新中";

  try {
    const result = await fetchServiceJson(VERSION_UPDATE_URL, "Project update failed", {
      method: "POST",
    });
    showVersionStatus(result.updating ? "更新中" : "最新", result.updating ? "service-warn" : "service-ok");
  } catch (error) {
    versionUpdateRequested = false;
    showVersionStatus("更新失败", "service-warn");
  }

  window.setTimeout(refreshVersionStatus, 2500);
}
