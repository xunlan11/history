let versionUpdateRequested = false;

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
  if (!versionServiceStatus || !versionUpdateButton) {
    return;
  }

  try {
    const result = await fetchServiceJson(VERSION_STATUS_URL, "Version check failed");

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
      window.location.reload();
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
