// 单一逐页流式处理进度：主进度按已生成整理稿页数推进，
// 子进度显示当前正在 OCR 或由大模型整理的页面。

let streamSubState = { pageNumber: null, text: "", percent: 0, active: false };

function setStreamSubProgress(pageNumber, text, percent) {
  streamSubState = {
    pageNumber,
    text,
    percent: clampPercent(percent),
    active: true,
  };
}

function clearStreamSubProgress() {
  streamSubState = { pageNumber: null, text: "", percent: 0, active: false };
}

function startPageStage(page, text, percent) {
  setStreamSubProgress(page?.pageNumber || 0, text, percent);
}

function finishPageStage(page) {
  streamSubState = {
    pageNumber: page?.pageNumber || 0,
    percent: 100,
    text: "本页完成",
    active: false,
  };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(100, Math.max(0, number));
}

function setProgressRow(labelNode, fillNode, valueNode, label, percent, valueText) {
  if (labelNode) {
    labelNode.textContent = label;
  }

  if (fillNode) {
    fillNode.style.width = `${clampPercent(percent)}%`;
  }

  if (valueNode) {
    valueNode.textContent = valueText;
  }
}

function renderStreamProgress(item) {
  const task = item?.processingTask;

  if (!item || !task) {
    streamProgress?.classList.add("hidden");
    return;
  }

  const total = task.totalPages || item.pages.length || 0;
  const finalized = countFinalizedPages(item);
  const finished = task.status === "已完成" || task.status === "已回填";
  const failed = task.status === "处理失败" || task.status === "提交失败";
  const mainPercent = total > 0 ? (finalized / total) * 100 : finished ? 100 : 0;
  const sub = streamSubState.active
    ? {
        label: `第 ${streamSubState.pageNumber} 页`,
        percent: streamSubState.percent,
        text: streamSubState.text,
      }
    : {
        label: `第 ${task.currentPage || streamSubState.pageNumber || 0} 页`,
        percent: task.currentPageProgress || streamSubState.percent || 0,
        text: task.currentPageStage || streamSubState.text || (finished ? "已完成" : failed ? "失败" : "等待"),
      };

  streamProgress?.classList.remove("hidden");
  setProgressRow(
    streamMainLabel,
    streamMainFill,
    streamMainValue,
    "逐页整理进度",
    mainPercent,
    `${finalized} / ${total} 页`,
  );
  setProgressRow(
    streamSubLabel,
    streamSubFill,
    streamSubValue,
    sub.label,
    sub.percent,
    sub.text,
  );
}
