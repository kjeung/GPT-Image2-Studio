function normalizeClipboardImageName(file, index) {
  const name = String(file?.name || "").trim();
  if (name) {
    return name;
  }

  const type = String(file?.type || "").toLowerCase();
  const extension = type === "image/jpeg" ? "jpg" : type.split("/")[1]?.replace(/[^a-z0-9.+-]/g, "") || "png";
  return `pasted-image-${index + 1}.${extension}`;
}

function getClipboardImageFailureMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "剪贴板图片读取失败。";
}

async function decodeWithRetry(file, decodeImageFile, retryDelayMs) {
  if (typeof decodeImageFile !== "function") {
    return;
  }

  try {
    await decodeImageFile(file);
  } catch (firstError) {
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    try {
      await decodeImageFile(file);
    } catch {
      throw firstError;
    }
  }
}

export async function snapshotClipboardImageFile(file, options = {}) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("剪贴板没有提供可读取的图片文件。");
  }

  const declaredType = String(file.type || "").trim().toLowerCase();
  if (!declaredType.startsWith("image/")) {
    throw new Error("剪贴板内容不是图片格式。");
  }

  const bytes = await file.arrayBuffer();
  if (!bytes || bytes.byteLength === 0) {
    throw new Error("剪贴板图片内容为空，请重新复制后再粘贴。");
  }

  const FileConstructor = options.FileConstructor || globalThis.File;
  if (typeof FileConstructor !== "function") {
    throw new Error("当前浏览器无法保存剪贴板图片快照。");
  }

  const snapshot = new FileConstructor([bytes], normalizeClipboardImageName(file, Number(options.index) || 0), {
    type: declaredType,
    lastModified: Number(file.lastModified) || Date.now(),
  });
  await decodeWithRetry(snapshot, options.decodeImageFile, Math.max(0, Number(options.retryDelayMs) || 0));
  return snapshot;
}

export async function prepareClipboardImageFiles(files, options = {}) {
  const acceptedFiles = [];
  const rejectedFiles = [];
  const candidates = [...(files || [])];

  for (let index = 0; index < candidates.length; index += 1) {
    const file = candidates[index];
    try {
      acceptedFiles.push(await snapshotClipboardImageFile(file, { ...options, index }));
    } catch (error) {
      rejectedFiles.push({
        file,
        message: getClipboardImageFailureMessage(error),
      });
    }
  }

  return { acceptedFiles, rejectedFiles };
}
