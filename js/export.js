const publicDocumentDownloads = new Map();

function openPublicDocumentPreview(item, options = {}) {
  const previewWindow = window.open("", "_blank");
  if (!previewWindow) {
    alert("浏览器拦截了预览窗口，请允许弹出窗口后再试一次。");
    return;
  }
  return openPrintWindow(item, previewWindow, { ...options, preview: true });
}

async function downloadPublicDocument(documentId, { folderId = "" } = {}) {
  if (publicDocumentDownloads.has(documentId)) return publicDocumentDownloads.get(documentId);
  const request = (async () => {
    const response = await fetch(`${DATA_PROCESSING_URL}/${encodeURIComponent(documentId)}/download`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || "下载失败，请稍后重试。");
    const item = normalizeDocuments([payload.document])[0];
    if (!item || !canEditDocument(item)) throw new Error("下载结果无效，请刷新文献库后重试。");
    // Merge only the new document, so pending edits in this page remain intact.
    if (!documents.some((entry) => entry.id === item.id)) documents.push(item);
    persist();
    if (folderId && getShelfState().folders.some((folder) => folder.id === folderId)) {
      moveShelfDocument(item.id, folderId);
    }
    renderDocumentList();
    return item;
  })();
  publicDocumentDownloads.set(documentId, request);
  try {
    return await request;
  } finally {
    publicDocumentDownloads.delete(documentId);
  }
}

function exportPdf() {
  const item = getSelectedDocument();

  if (!item) {
    alert("请先在文献库打开一项文献，再导出 PDF。");
    return;
  }

  // 先同步开窗，避免转换请求（异步）之后被浏览器当成弹窗拦截
  const printWindow = window.open("", "_blank");

  if (!printWindow) {
    alert("浏览器拦截了导出窗口。请允许弹出窗口后再试一次。");
    return;
  }

  openPrintWindow(item, printWindow);
}

async function openPrintWindow(item, printWindow, options = {}) {
  let html;

  try {
    html = await buildPrintHtml(item, options);
  } catch (error) {
    console.error(error);
    if (!printWindow.closed) printWindow.close();
    alert("导出内容生成失败，请刷新后重试。");
    return;
  }

  if (printWindow.closed) return;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  if (options.preview) {
    const button = printWindow.document.querySelector("#download-public-document");
    const status = printWindow.document.querySelector("#public-download-status");
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "正在下载…";
      status.textContent = "正在将文献保存到你的文献库…";
      try {
        await downloadPublicDocument(item.id, options);
        button.textContent = "已下载到我的文献库";
        status.textContent = "副本默认私密，可在你的文献库中完整编辑。";
      } catch (error) {
        button.disabled = false;
        button.textContent = "重试下载到我的文献库";
        status.textContent = error.message || "下载失败，请稍后重试。";
      }
    });
  }
  printWindow.focus();
}

// 首页信息（标题 / 品牌名 / 信息表）随「设置」里选择的简繁体显示；转换失败时保留原文
async function convertExportInfo(texts) {
  if (typeof window.convertVariantTexts !== "function") return texts;
  try {
    return await window.convertVariantTexts(texts);
  } catch (error) {
    console.warn("导出简繁体转换失败，保留原文", error);
    return texts;
  }
}

async function buildPrintHtml(item, { preview = false } = {}) {
  const sortedPages = item.pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
  const metadataPairs = [
    ["文献名", item.title || "未录"],
    ["著者", item.author || "未录"],
    ["出版时间", item.year || "未录"],
    ["出版社", item.publisher || "未录"],
    ["创建者", item.creator?.username || "创建者信息不可用"],
    ...(item.modifier?.username ? [["修改者", item.modifier.username]] : []),
    ["主题标签", item.tags || "未录"],
    ["原始文件", item.fileName || "未录"],
    [preview ? "预览时间" : "导出时间", formatDateTime(new Date())],
  ];

  // 前两项是标题与品牌名，其余按「标签 / 值」交替排列
  const converted = await convertExportInfo([
    item.title || "未命名文献",
    SITE_TITLE,
    ...metadataPairs.flat(),
  ]);
  const heading = converted[0];
  const brand = converted[1];
  const metadataTexts = converted.slice(2);
  const metadataHtml = metadataPairs
    .map((_, index) => {
      const label = metadataTexts[index * 2];
      const value = metadataTexts[index * 2 + 1];
      if (metadataPairs[index][0] === "修改者") return "";
      const modifierIndex = metadataPairs[index][0] === "创建者" && item.modifier?.username ? index + 1 : -1;
      const modifier = modifierIndex >= 0
        ? `<dt>${escapeHtml(metadataTexts[modifierIndex * 2])}</dt><dd>${escapeHtml(metadataTexts[modifierIndex * 2 + 1])}</dd>` : "";
      return `<div class="meta-row${modifier ? " attribution-row" : ""}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>${modifier}</div>`;
    })
    .join("");

  const pagesHtml = sortedPages
    .map((page) => {
      const imageSource = getPageImageSource(page);
      const imageHtml = imageSource
        ? `<figure><img src="${escapeHtml(imageSource)}" alt="第 ${page.pageNumber} 页原始资料" /></figure>`
        : `<p class="no-image">本页未放入原始资料图片。</p>`;
      return `
        <section class="page-section">
          <h2>第 ${page.pageNumber} 页</h2>
          <div class="page-grid">
            <div>
              <h3>原始资料</h3>
              ${imageHtml}
            </div>
            <div>
              <section class="text-layer">
                <h3>整理文本</h3>
                <div class="transcription">${escapeHtml(page.punctuatedText || "（尚未整理文字）")}</div>
              </section>
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
    <title>${escapeHtml(heading)}</title>
    <style>
      @page { size: A4; margin: 18mm 16mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #1f2723; font-family: "Microsoft YaHei", "SimSun", serif; line-height: 1.75; }
      .print-header { position: sticky; top: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 22px; background: #eef3f0; border-bottom: 1px solid #d9e0dc; }
      .print-brand { flex: 1; margin: 0; font-size: 22px; font-weight: 700; }
      .print-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-left: auto; }
      button { min-height: 36px; border: 1px solid #b9c7c0; border-radius: 6px; background: #ffffff; color: #1f2723; padding: 6px 14px; font: inherit; cursor: pointer; }
      main { max-width: 980px; margin: 0 auto; padding: 28px 22px 56px; }
      h1 { margin: 0 0 24px; text-align: center; font-size: 26px; line-height: 1.35; }
      .meta-block { display: grid; grid-template-columns: 1fr; margin-bottom: 28px; border-top: 2px solid #2f6f5e; border-bottom: 1px solid #d9e0dc; padding: 12px 0; }
      .meta-row { display: grid; grid-template-columns: 88px 1fr; gap: 8px; border-bottom: 1px solid #edf1ef; padding: 7px 0; }
      .attribution-row { grid-template-columns: 88px minmax(0, 1fr) 88px minmax(0, 1fr); }
      #public-download-status { flex-basis: 100%; margin: 0; font-size: 14px; }
      button:disabled { cursor: default; opacity: .65; }
      dt { color: #66736d; font-weight: 700; }
      dd { margin: 0; }
      .page-section { break-inside: avoid; border-top: 1px solid #cfd8d3; padding-top: 18px; margin-top: 24px; }
      .page-section h2 { margin: 0 0 12px; font-size: 20px; }
      .page-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
      h3 { margin: 0 0 8px; font-size: 15px; }
      figure { margin: 0; }
      img { max-width: 100%; height: auto; border: 1px solid #d9e0dc; }
      .no-image { margin: 6px 0 0; color: #66736d; font-size: 12px; }
      .text-layer { margin-bottom: 14px; }
      .transcription { min-height: 88px; white-space: pre-wrap; border: 1px solid #d9e0dc; padding: 12px; background: #fbfcfb; }
      @media print { #public-download-status { display: none; } .print-header { position: static; margin-bottom: 24px; } .print-actions { display: none; } main { padding: 0; } }
    </style>
  </head>
  <body>
    <header class="print-header">
      <p class="print-brand">${escapeHtml(brand)}</p>
      <div class="print-actions">
        ${preview ? '<button type="button" id="download-public-document">下载到我的文献库</button>' : ""}
        <button type="button" onclick="window.print()">保存为 PDF</button>
        <button type="button" onclick="window.close()">关闭</button>
      </div>
      ${preview ? '<p id="public-download-status" role="status">下载后将生成默认私密、可编辑的个人副本。</p>' : ""}
    </header>
    <main>
      <h1>${escapeHtml(heading)}</h1>
      <dl class="meta-block">${metadataHtml}</dl>
      ${pagesHtml}
    </main>
    ${preview ? "" : `<script>
      window.addEventListener("load", function () {
        setTimeout(function () {
          window.print();
        }, 300);
      });
    </script>`}
  </body>
</html>`;
}
