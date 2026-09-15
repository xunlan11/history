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

async function refreshOcrServiceStatus() {
  if (!ocrServiceStatus) {
    return;
  }

  try {
    const result = await fetchServiceJson(OCR_HEALTH_URL, "OCR health check failed");
    const upstream = result.upstream || {};
    if (result.ready) {
      setServiceStatus(ocrServiceStatus, "已连接", "service-ok");
    } else if (!upstream.configured) {
      // 数据端不再加载识别模型，识别能力在数据处理服务器上
      setServiceStatus(ocrServiceStatus, "识别未部署", "service-warn");
    } else {
      setServiceStatus(ocrServiceStatus, "服务端不可达", "service-warn");
    }
  } catch (error) {
    setServiceStatus(ocrServiceStatus, "未连接", "service-warn");
  }
}

async function refreshLlmServiceStatus() {
  if (!llmServiceStatus) {
    return;
  }

  try {
    const result = await fetchServiceJson(LLM_HEALTH_URL, "LLM health check failed");
    setServiceStatus(
      llmServiceStatus,
      result.ready ? "已连接" : "待配置",
      result.ready ? "service-ok" : "service-warn",
    );
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
