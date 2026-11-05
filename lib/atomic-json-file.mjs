import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const fileTransactions = new Map();

/**
 * Fixed, not timestamped: repeated corruption of the same path must not
 * accumulate ".corrupt" files without bound.
 */
const CORRUPT_SUFFIX = ".corrupt";

export function withFileTransaction(filePath, operation) {
  const key = resolve(filePath);
  const previous = fileTransactions.get(key) || Promise.resolve();
  const result = previous.then(operation);
  const tail = result.catch(() => {});
  fileTransactions.set(key, tail);
  tail.then(() => {
    if (fileTransactions.get(key) === tail) fileTransactions.delete(key);
  });
  return result;
}

export async function writeJsonFileAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tempPath, filePath);
        break;
      } catch (error) {
        // Windows readers can briefly prevent replacement of the previous file.
        if (process.platform !== "win32" || attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        await delay(10 * 2 ** attempt);
      }
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

/**
 * Move an unreadable file aside so it stays diagnosable. A fixed suffix rather
 * than a timestamped one: repeated corruption of the same path must not
 * accumulate files without bound.
 */
export async function quarantineJsonFile(filePath) {
  const corruptPath = `${filePath}${CORRUPT_SUFFIX}`;
  try {
    await rm(corruptPath, { force: true });
    await rename(filePath, corruptPath);
    return corruptPath;
  } catch {
    return "";
  }
}

/**
 * Read JSON, tolerating a file that is missing *or* damaged.
 *
 * Returns the parsed value, or `null` when the file is absent or unreadable.
 * A file that fails to parse is quarantined (unless `quarantine: false`) and
 * reported through `onCorrupt`, because silently discarding it would make this
 * class of bug invisible again.
 *
 * Errors unrelated to parsing — permissions, for instance — still propagate:
 * they mean something is wrong with the volume, not with the content.
 */
export async function readJsonFileSafe(filePath, { quarantine = true, onCorrupt, label = "" } = {}) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    return JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (error) {
    const described = label || filePath;
    if (typeof onCorrupt === "function") {
      onCorrupt({ filePath, message: error instanceof Error ? error.message : String(error) });
    } else {
      console.warn(`[json] ignoring unreadable JSON in ${described}: ${error instanceof Error ? error.message : error}`);
    }
    if (quarantine) {
      await quarantineJsonFile(filePath);
    }
    return null;
  }
}

/**
 * Same as readJsonFileSafe, but reports "absent" by throwing an error coded
 * ENOENT.
 *
 * This keeps every existing `catch (error) { if (error.code === "ENOENT") ... }`
 * branch working untouched, while a damaged file now takes that same
 * "treat as missing" path instead of escaping as a SyntaxError and failing the
 * whole request. The damaged file has already been quarantined by the time the
 * error is thrown, so it stays diagnosable and cannot recur.
 */
export async function readJsonFileOrThrowMissing(filePath, options = {}) {
  const value = await readJsonFileSafe(filePath, options);
  if (value === null) {
    const error = new Error(`JSON file is missing or was quarantined: ${filePath}`);
    error.code = "ENOENT";
    throw error;
  }
  return value;
}
