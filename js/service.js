async function refreshOcrServiceStatus() {
  if (!ocrServiceStatus) {
    return;
  }

  try {
    const response = await fetch("http://127.0.0.1:8765/health", {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`OCR health check failed: ${response.status}`);
    }

    ocrServiceStatus.textContent = "已连接";
    ocrServiceStatus.className = "service-ok";
  } catch (error) {
    ocrServiceStatus.textContent = "未连接";
    ocrServiceStatus.className = "service-warn";
  }
}

async function refreshLlmServiceStatus() {
  if (!llmServiceStatus) {
    return;
  }

  try {
    const response = await fetch(LLM_HEALTH_URL, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`LLM health check failed: ${response.status}`);
    }

    const result = await response.json();
    llmServiceStatus.textContent = result.ready ? "已连接" : "待配置";
    llmServiceStatus.className = result.ready ? "service-ok" : "service-warn";
  } catch (error) {
    llmServiceStatus.textContent = "未连接";
    llmServiceStatus.className = "service-warn";
  }
}

function showVersionStatus(text, className = "service-warn") {
  if (!versionServiceStatus || !versionUpdateButton) {
    return;
  }

  versionServiceStatus.textContent = text;
  versionServiceStatus.className = className;
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
    const response = await fetch(VERSION_STATUS_URL, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Version check failed: ${response.status}`);
    }

    const result = await response.json();

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
    const response = await fetch(VERSION_UPDATE_URL, {
      method: "POST",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Project update failed: ${response.status}`);
    }

    const result = await response.json();
    showVersionStatus(result.updating ? "更新中" : "最新", result.updating ? "service-warn" : "service-ok");
  } catch (error) {
    showVersionStatus("更新失败", "service-warn");
  }

  window.setTimeout(refreshVersionStatus, 2500);
}
