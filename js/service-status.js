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
