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
    await fetchServiceJson(OCR_HEALTH_URL, "OCR health check failed");
    setServiceStatus(ocrServiceStatus, "已连接", "service-ok");
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

  versionUpdateButton.disabled = true;
  versionUpdateButton.textContent = "更新中";

  try {
    const result = await fetchServiceJson(VERSION_UPDATE_URL, "Project update failed", {
      method: "POST",
    });
    showVersionStatus(result.updating ? "更新中" : "最新", result.updating ? "service-warn" : "service-ok");
  } catch (error) {
    showVersionStatus("更新失败", "service-warn");
  }

  window.setTimeout(refreshVersionStatus, 2500);
}
