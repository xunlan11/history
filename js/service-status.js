async function refreshOcrServiceStatus() {
  if (!ocrServiceStatus) {
    return;
  }

  ocrServiceStatus.textContent = "检测中";
  ocrServiceStatus.className = "";

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
