// 进度条渲染逻辑：离线整本处理与在线逐页整理共用两级进度条结构。
// 主进度条按页数推进，子进度条反映当前页的处理进程。

let onlineSubState = { pageId: null, percent: 0, text: "等待", active: false };
let offlineSubState = { pageNumber: null, text: "", percent: 0, active: false };

function setOfflineSubProgress(pageNumber, text, percent) {
  offlineSubState = {
    pageNumber,
    text,
    percent: clampPercent(percent),
    active: true,
  };
}

function clearOfflineSubProgress() {
  offlineSubState = { pageNumber: null, text: "", percent: 0, active: false };
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

function startOnlinePageStage(page, text, percent) {
  onlineSubState = {
    pageId: page?.id || null,
    percent: clampPercent(percent),
    text,
    active: true,
  };
}

function finishOnlinePageStage(page) {
  onlineSubState = {
    pageId: page?.id || null,
    percent: 100,
    text: "本页完成",
    active: false,
  };
}

function resetOnlineSubState() {
  onlineSubState = { pageId: null, percent: 0, text: "等待", active: false };
}

function renderOfflineProgress(item) {
  const task = item?.offlineTask;

  if (!task) {
    offlineProgress?.classList.add("hidden");
    return;
  }

  const total = task.totalPages || 0;
  const completed = task.completedPages || 0;
  const finished = task.status === "已完成" || task.status === "已回填";
  const failed = task.status === "处理失败" || task.status === "提交失败";

  const mainPercent = total > 0 ? (completed / total) * 100 : finished ? 100 : 0;
  const sub = offlineSubState.active
    ? {
        label: `第 ${offlineSubState.pageNumber} 页`,
        percent: offlineSubState.percent,
        text: offlineSubState.text,
      }
    : {
        label: `第 ${task.currentPage || 0} 页`,
        percent: task.currentPageProgress || 0,
        text: task.currentPageStage || (finished ? "已完成" : failed ? "失败" : "等待"),
      };

  offlineProgress?.classList.remove("hidden");
  setProgressRow(
    offlineMainLabel,
    offlineMainFill,
    offlineMainValue,
    "整本进度",
    mainPercent,
    `${completed} / ${total} 页`,
  );
  setProgressRow(
    offlineSubLabel,
    offlineSubFill,
    offlineSubValue,
    sub.label,
    sub.percent,
    sub.text,
  );
}

function getOnlineSubDisplay(page) {
  if (onlineSubState.active && onlineSubState.pageId === page?.id) {
    return onlineSubState;
  }

  if (page && (page.status === "已生成整理稿" || page.ocr?.recognizedAt || hasPageText(page))) {
    return { percent: 100, text: "本页已完成" };
  }

  return { percent: 0, text: "等待处理" };
}

function renderOnlineProgress(item) {
  if (!item || item.processMode !== "online") {
    onlineProgress?.classList.add("hidden");
    return;
  }

  const { processed, total } = getOnlinePageProgress(item);
  const mainPercent = total > 0 ? (processed / total) * 100 : 0;
  const page = getSelectedPage();
  const sub = getOnlineSubDisplay(page);

  onlineProgress?.classList.remove("hidden");
  setProgressRow(
    onlineMainLabel,
    onlineMainFill,
    onlineMainValue,
    "在线整理进度",
    mainPercent,
    `${processed} / ${total} 页`,
  );
  setProgressRow(
    onlineSubLabel,
    onlineSubFill,
    onlineSubValue,
    `第 ${page?.pageNumber || 0} 页`,
    sub.percent,
    sub.text,
  );
}
