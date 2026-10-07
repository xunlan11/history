// 浏览器只负责归档和提交。封面、元数据、正文 OCR/LLM 均由后端推进。
async function runDocumentUploadPipeline(item, file) {
  if (!canEditDocument(item)) throw new Error("当前用户没有该文献的编辑权限，请重新登录后重试。");
  if (!file?.name) throw new Error("没有可上传的原件文件。");
  const documentId = item.id;
  beginDocumentUpload(item, file);
  try {
    await stashPendingUpload(documentId, file);
    setUploadStage(documentId, 0, "保存文献记录", 0);
    // 必须先有带所有者的真实记录，归档原件成功即由后端原子入队。
    await saveRegistrationCheckpoint(documentId);
    if (!getRegistrationDocument(documentId).fileUrl) {
      await archiveDocumentSource(getRegistrationDocument(documentId), file, (fraction) => {
        setUploadStage(documentId, 0, "上传原件", fraction);
      });
    }
    setUploadStage(documentId, 1, "已交给后端准备登记", 0);
    await submitBackendDocument(getRegistrationDocument(documentId));
    await dropPendingUpload(documentId);
    markDocumentUploadFinished(documentId);
    startProcessingPolling(getRegistrationDocument(documentId));
    renderAll();
    return true;
  } catch (error) {
    const current = getLiveDocument(documentId);
    if (current && !error.registrationCancelled) {
      // 若归档已成功，后端已在运行；客户端断线不能把任务改成失败。
      if (!current.processingTask?.backendManaged) {
        current.registration = current.registration || createRegistrationState();
        current.registration.status = "failed";
        current.registration.error = error?.message || "上传未完成";
        current.status = "登记未完成";
        persist();
      }
      markDocumentUploadFailed(documentId, error);
      renderAll();
    } else {
      markDocumentUploadFinished(documentId);
    }
    throw error;
  }
}

function getRegistrationDocument(documentId) {
  const item = getLiveDocument(documentId);
  if (!item || !canEditDocument(item)) {
    const error = new Error("文献已删除或编辑权限已失效，登记已停止。");
    error.registrationCancelled = true;
    throw error;
  }
  return item;
}

async function saveRegistrationCheckpoint(documentId) {
  getRegistrationDocument(documentId).updatedAt = new Date().toISOString();
  persist();
  await flushPendingSync();
  if (syncDirty) throw new Error("文献记录尚未同步到服务端，请稍后继续上传。");
  getRegistrationDocument(documentId);
}

function setUploadStage(documentId, stageIndex, stage, fraction) {
  const percent = Math.min(100, Math.max(0, ((stageIndex + (Number(fraction) || 0)) / 4) * 100));
  updateDocumentUploadState(documentId, { active: true, stageIndex, stage, percent });
}
