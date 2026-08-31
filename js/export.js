function exportPdf() {
  const item = getSelectedDocument();

  if (!item) {
    alert("请先在文献库打开一项文献，再导出 PDF。");
    return;
  }

  openPrintWindow(item);
}

function openPrintWindow(item) {
  const printWindow = window.open("", "_blank");

  if (!printWindow) {
    alert("浏览器拦截了导出窗口。请允许弹出窗口后再试一次。");
    return;
  }

  printWindow.document.open();
  printWindow.document.write(buildPrintHtml(item));
  printWindow.document.close();
  printWindow.focus();
}

function buildPrintHtml(item) {
  const sortedPages = item.pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
  const metadata = [
    ["文献名", item.title || "未录"],
    ["著者", item.author || "未录"],
    ["年份", item.year || "未录"],
    ["出版社", item.publisher || "未录"],
    ["主题标签", item.tags || "未录"],
    ["原始文件", item.fileName || "未录"],
    ["导出时间", formatDateTime(new Date())],
  ];

  const metadataHtml = metadata
    .map(([label, value]) => `<div class="meta-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");

  const pagesHtml = sortedPages
    .map((page) => {
      const imageHtml = page.imageDataUrl
        ? `<figure><img src="${page.imageDataUrl}" alt="第 ${page.pageNumber} 页原始资料" /><figcaption>原始资料：${escapeHtml(page.imageName || `第 ${page.pageNumber} 页`)}</figcaption></figure>`
        : page.imageUrl
          ? `<figure><img src="${escapeHtml(page.imageUrl)}" alt="第 ${page.pageNumber} 页原始资料" /><figcaption>原始资料：${escapeHtml(page.imageName || `第 ${page.pageNumber} 页`)}</figcaption></figure>`
          : `<p class="no-image">本页未放入原始资料图片。</p>`;
      const notesHtml = page.notes
        ? `<h3>页备注</h3><div class="notes">${escapeHtml(page.notes)}</div>`
        : "";
      const layers = [
        ["OCR 原始录文", page.ocrText],
        ["忠实整理文本", page.cleanText],
        ["简体标点文本", page.punctuatedText],
      ];
      const layerHtml = layers
        .map(([label, value]) => `
          <section class="text-layer">
            <h3>${escapeHtml(label)}</h3>
            <div class="transcription">${escapeHtml(value || "（本层尚未整理文字）")}</div>
          </section>
        `)
        .join("");

      return `
        <section class="page-section">
          <h2>第 ${page.pageNumber} 页</h2>
          <div class="page-meta">整理状态：${escapeHtml(page.status || "待整理")}</div>
          <div class="page-grid">
            <div>
              <h3>原始资料</h3>
              ${imageHtml}
            </div>
            <div>
              ${layerHtml}
              ${notesHtml}
            </div>
          </div>
        </section>
      `;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(item.title || "未命名文献")} 整理稿</title>
    <style>
      @page { size: A4; margin: 18mm 16mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #1f2723; font-family: "Microsoft YaHei", "SimSun", serif; line-height: 1.75; }
      .print-actions { position: sticky; top: 0; display: flex; justify-content: flex-end; gap: 10px; padding: 12px; background: #eef3f0; border-bottom: 1px solid #d9e0dc; }
      button { min-height: 36px; border: 1px solid #b9c7c0; border-radius: 6px; background: #ffffff; color: #1f2723; padding: 6px 14px; font: inherit; cursor: pointer; }
      main { max-width: 980px; margin: 0 auto; padding: 28px 22px 56px; }
      h1 { margin: 0 0 8px; text-align: center; font-size: 26px; line-height: 1.35; }
      .subtitle { margin: 0 0 24px; text-align: center; color: #66736d; }
      .meta-block { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; margin-bottom: 28px; border-top: 2px solid #2f6f5e; border-bottom: 1px solid #d9e0dc; padding: 12px 0; }
      .meta-row { display: grid; grid-template-columns: 88px 1fr; gap: 8px; border-bottom: 1px solid #edf1ef; padding: 7px 0; }
      dt { color: #66736d; font-weight: 700; }
      dd { margin: 0; }
      .page-section { break-inside: avoid; border-top: 1px solid #cfd8d3; padding-top: 18px; margin-top: 24px; }
      .page-section h2 { margin: 0; font-size: 20px; }
      .page-meta { margin: 2px 0 12px; color: #66736d; font-size: 13px; }
      .page-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
      h3 { margin: 0 0 8px; font-size: 15px; }
      figure { margin: 0; }
      img { max-width: 100%; height: auto; border: 1px solid #d9e0dc; }
      figcaption, .no-image { margin: 6px 0 0; color: #66736d; font-size: 12px; }
      .text-layer { margin-bottom: 14px; }
      .transcription { min-height: 88px; white-space: pre-wrap; border: 1px solid #d9e0dc; padding: 12px; background: #fbfcfb; }
      .notes { margin-top: 8px; white-space: pre-wrap; border-left: 3px solid #8f4a3d; padding: 8px 10px; background: #f8f4ef; }
      @media print { .print-actions { display: none; } main { padding: 0; } }
    </style>
  </head>
  <body>
    <div class="print-actions">
      <button type="button" onclick="window.print()">保存为 PDF</button>
      <button type="button" onclick="window.close()">关闭</button>
    </div>
    <main>
      <h1>${escapeHtml(item.title || "未命名文献")} 整理稿</h1>
      <p class="subtitle">近代军史数智平台</p>
      <dl class="meta-block">${metadataHtml}</dl>
      ${pagesHtml}
    </main>
    <script>
      window.addEventListener("load", function () {
        setTimeout(function () {
          window.print();
        }, 300);
      });
    </script>
  </body>
</html>`;
}
