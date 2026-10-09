import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Crash-safe JSON persistence helpers.
 *
 * Why this module exists
 * ---------------------
 * Every store used to persist JSON with a plain `writeFile()` and read it back
 * with a `JSON.parse()` that only tolerated ENOENT. If the process died
 * mid-write — a container stop, an OOM kill, a full disk — the target file was
 * left truncated. From then on the reader threw on *every* request, so the
 * gallery, the set lists or the whole settings page stayed broken until someone
 * deleted the file by hand.
 *
 * Two halves fix that, and both are needed:
 *
 *   writeJsonFileAtomic — write to a temporary file in the same directory, then
 *     `rename()` it over the target. rename() within one filesystem is atomic,
 *     so a reader sees either the previous complete file or the new complete
 *     one, never a half-written one. Interrupted writes leave only an orphan
 *     `.tmp` file, which docker/retention-gc.mjs sweeps up.
 *
 *   readJsonFileSafe — treat "present but unparseable" as absent instead of
 *     throwing, and quarantine the bad file so it stays diagnosable.
 *
 * Note on fsync: durable-against-power-loss would also need an fsync of the
 * file and of its directory. That is deliberately not the default here — it
 * costs a disk flush per metadata write, and the failure this project actually
 * hit was a killed process, which temp+rename already survives. Pass
 * `{ fsync: true }` for the stronger guarantee.
 */

const CORRUPT_SUFFIX = ".corrupt";

/** Unique enough to survive concurrent writers in the same directory. */
function tempPathFor(filePath) {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return join(dirname(filePath), `.${unique}-${filePath.split(/[\\/]/u).pop()}.tmp`);
}

/**
 * Write JSON so that readers never observe a partial file.
 */
export async function writeJsonFileAtomic(filePath, value, { spacing = 2, fsync = false } = {}) {
  const payload = `${JSON.stringify(value, null, spacing)}\n`;
  const tempPath = tempPathFor(filePath);
  let handle;
  try {
    handle = await open(tempPath, "w");
    await handle.writeFile(payload, "utf8");
    if (fsync) await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Move an unreadable file aside. The suffix is fixed rather than timestamped so
 * repeated corruption of the same path cannot accumulate files without bound.
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
