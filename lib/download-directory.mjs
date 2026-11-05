import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";

const WINDOWS_RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function normalizeDownloadDirectory(value) {
  return String(value || "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
}

export function validateDownloadDirectory(value) {
  const directory = normalizeDownloadDirectory(value);
  if (!directory) {
    return "";
  }
  if (!isAbsolute(directory)) {
    throw new Error("图片下载目录必须填写完整的绝对路径，例如 D:\\图片下载。");
  }
  return directory;
}

export async function ensureDownloadDirectory(value) {
  const directory = validateDownloadDirectory(value);
  if (!directory) {
    return "";
  }
  await mkdir(directory, { recursive: true });
  const details = await stat(directory);
  if (!details.isDirectory()) {
    throw new Error("图片下载路径不是文件夹，请重新选择。");
  }
  return directory;
}

export function sanitizeDownloadFilename(value, fallback = "image.png") {
  const source = String(value || "").split(/[\\/]/).pop() || fallback;
  let filename = source
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!filename) {
    filename = fallback;
  }
  if (WINDOWS_RESERVED_FILENAME.test(filename)) {
    filename = `_${filename}`;
  }

  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length) || "image";
  const maxStemLength = Math.max(1, 180 - extension.length);
  return `${stem.slice(0, maxStemLength)}${extension}`;
}

export async function saveDownloadFile({ directory, filename, data }) {
  const targetDirectory = await ensureDownloadDirectory(directory);
  if (!targetDirectory) {
    throw new Error("尚未配置图片下载目录。");
  }
  const safeFilename = sanitizeDownloadFilename(filename);
  const extension = extname(safeFilename);
  const stem = safeFilename.slice(0, safeFilename.length - extension.length) || "image";
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);

  for (let index = 0; index < 10000; index += 1) {
    const candidate = index === 0 ? safeFilename : `${stem} (${index})${extension}`;
    const absolutePath = join(targetDirectory, candidate);
    try {
      await writeFile(absolutePath, bytes, { flag: "wx" });
      return {
        directory: targetDirectory,
        filename: candidate,
        absolutePath,
      };
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "EEXIST")) {
        throw error;
      }
    }
  }

  throw new Error("目标目录中同名文件过多，请清理后重试。");
}
