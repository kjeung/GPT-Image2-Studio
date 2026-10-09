#!/usr/bin/env node
/**
 * Count-based retention GC for GPT-Image2-Studio.
 *
 * The application has no retention feature of its own, so this runs beside it
 * (see docker/entrypoint.sh) and enforces two independent caps:
 *
 *   MAX_IMAGES  standalone generated images   (unit: one image file)
 *   MAX_SETS    asset sets: creation / portrait / article-illustration / ppt
 *                                             (unit: one whole set)
 *
 * A set is evicted whole — its image directory, its metadata twin directory
 * and its manifest — because the manifest references individual image
 * filenames (items / listingDrafts / skuSubjects[].filenames). Trimming inside
 * a set would leave the UI listing files that no longer exist.
 *
 * Standalone images are evicted per file, together with their sidecar
 * metadata, so the metadata tree cannot grow without bound.
 *
 * Everything here mirrors the application's own deletion rules
 * (lib/creation-store.mjs resolveDedicatedCreationDirectory /
 * removeVerifiedCreationDirectory and lib/ppt-deck-store.mjs
 * getPptDedicatedRelativeDir) rather than inventing new semantics.
 *
 * Run with --daemon to loop, or once for a single pass. Supports --dry-run.
 */
import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const METADATA_DIRNAME = "json";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SET_MARKER_RE = /^\d{4}-\d{2}-\d{2}-(creation|portrait|article|ppt)$/u;
const PPT_MARKER_RE = /^\d{4}-\d{2}-\d{2}-ppt$/u;
const SET_MANIFEST_DIRS = ["creation-sets", "portrait-sets", "article-illustration-sets", "ppt-decks"];
const CORRUPT_SUFFIX = ".corrupt";

const args = new Set(process.argv.slice(2));

function envInt(name, fallback) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  // The retention floor is 1: "keep nothing" is not a supported configuration,
  // it would silently turn the studio into a black hole.
  if (!Number.isFinite(value) || value < 1) {
    console.warn(`[retention] ${name}="${raw}" is not a positive integer; using ${fallback}.`);
    return fallback;
  }
  return value;
}

const OUTPUT_DIR = resolve(String(process.env.IMAGE_STUDIO_OUTPUT_DIR || "/data/output").trim() || "/data/output");
const MAX_IMAGES = envInt("STUDIO_RETENTION_MAX_IMAGES", 500);
const MAX_SETS = envInt("STUDIO_RETENTION_MAX_SETS", 50);
const INTERVAL_SEC = envInt("STUDIO_RETENTION_INTERVAL_SEC", 300);
const GRACE_SEC = envInt("STUDIO_RETENTION_GRACE_SEC", 600);
const ENABLED = String(process.env.STUDIO_RETENTION_ENABLED ?? "1").trim() !== "0";
const DRY_RUN = args.has("--dry-run") || String(process.env.STUDIO_RETENTION_DRY_RUN ?? "").trim() === "1";

const GRACE_MS = GRACE_SEC * 1000;

function log(message) {
  console.log(`[retention] ${message}`);
}

/**
 * Containment guard, mirroring removeVerifiedCreationDirectory: a target is only
 * ever touched when it resolves to a path strictly inside the given root.
 */
function isInside(root, target) {
  const pathOffset = relative(root, target);
  if (!pathOffset) return false;
  if (pathOffset === ".." || pathOffset.startsWith("../") || pathOffset.startsWith("..\\")) return false;
  return !isAbsolute(pathOffset);
}

/**
 * The manifest area is exactly json/{creation-sets,portrait-sets,...} — NOT the
 * whole json/ tree, which also holds the per-image sidecars that must be
 * deletable. Getting this wrong makes every set look unremovable.
 */
const MANIFEST_ROOTS = SET_MANIFEST_DIRS.map((name) => resolve(OUTPUT_DIR, METADATA_DIRNAME, name));

function isManifestArea(target) {
  return MANIFEST_ROOTS.some((root) => isInside(root, target));
}

/** Quarantine instead of deleting: a broken manifest is the only record of its set. */
async function quarantine(filePath, reason) {
  if (DRY_RUN) return;
  const target = `${filePath}${CORRUPT_SUFFIX}-${Date.now()}`;
  try {
    await rename(filePath, target);
    log(`quarantined unreadable JSON (${reason}): ${relative(OUTPUT_DIR, filePath)} -> ${relative(OUTPUT_DIR, target)}`);
  } catch (error) {
    log(`failed to quarantine ${relative(OUTPUT_DIR, filePath)}: ${error?.message || error}`);
  }
}

async function statOrNull(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

async function renameAwayThenRemove(target, recursive) {
  const trash = `${target}.gc-${process.pid}-${Date.now()}`;
  try {
    await rename(target, trash);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    log(`rename failed for ${relative(OUTPUT_DIR, target)}: ${error?.message || error}`);
    return false;
  }
  try {
    await rm(trash, { recursive, force: true });
  } catch (error) {
    log(`cleanup failed for ${relative(OUTPUT_DIR, trash)}: ${error?.message || error}`);
    return false;
  }
  return true;
}

/**
 * Atomic-ish removal: rename the target out of the way first (atomic within the
 * same filesystem), then delete the copy. A concurrent reader therefore sees
 * either the complete path or nothing at all, never a half-deleted tree.
 */
async function removeVerifiedDirectory(target) {
  if (!target) return false;
  const info = await statOrNull(target);
  if (!info) return true;
  if (!isInside(OUTPUT_DIR, target) || isManifestArea(target)) {
    log(`refusing to delete directory outside the asset tree: ${relative(OUTPUT_DIR, target)}`);
    return false;
  }
  if (DRY_RUN) return true;
  return renameAwayThenRemove(target, true);
}

/** Sidecars and other asset files: anywhere under OUTPUT_DIR except the manifest area. */
async function removeVerifiedFile(target) {
  if (!target) return false;
  if (!isInside(OUTPUT_DIR, target) || isManifestArea(target)) {
    log(`refusing to delete file outside the asset tree: ${target}`);
    return false;
  }
  if (DRY_RUN) return true;
  try {
    await rm(target, { force: true });
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    log(`unlink failed for ${relative(OUTPUT_DIR, target)}: ${error?.message || error}`);
    return false;
  }
  return true;
}

/** A manifest lives *inside* the manifest area, so it needs its own guard. */
async function removeManifestFile(target) {
  if (!target || !isManifestArea(target)) {
    log(`refusing to delete manifest outside the manifest area: ${target}`);
    return false;
  }
  if (DRY_RUN) return true;
  try {
    await rm(target, { force: true });
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    log(`unlink failed for ${relative(OUTPUT_DIR, target)}: ${error?.message || error}`);
    return false;
  }
  return true;
}

function normalizeRelative(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

/** Mirrors lib/creation-store.mjs resolveDedicatedCreationDirectory. */
function resolveSetDirectory(relativeDir, { metadata = false } = {}) {
  const raw = normalizeRelative(relativeDir);
  if (!raw) return null;
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const markerIndex = segments.findIndex((segment) => SET_MARKER_RE.test(segment));
  if (markerIndex < 0 || markerIndex >= segments.length - 1) return null;
  const target = resolve(OUTPUT_DIR, ...(metadata ? [METADATA_DIRNAME] : []), ...segments);
  if (!isInside(OUTPUT_DIR, target) || isManifestArea(target)) return null;
  return target;
}

/** Mirrors lib/ppt-deck-store.mjs getPptDedicatedRelativeDir. */
function getPptRelativeDir(record) {
  const candidates = [
    record?.pptxRelativePath,
    record?.editablePptxRelativePath,
    ...(Array.isArray(record?.slides) ? record.slides.map((slide) => slide?.relativePath) : []),
  ];
  for (const value of candidates) {
    const segments = normalizeRelative(value).split("/").filter(Boolean);
    const markerIndex = segments.findIndex((segment) => PPT_MARKER_RE.test(segment));
    if (markerIndex >= 0 && markerIndex < segments.length - 2) {
      return segments.slice(0, markerIndex + 2).join("/");
    }
  }
  return "";
}

async function readManifest(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    log(`cannot read manifest ${relative(OUTPUT_DIR, filePath)}: ${error?.message || error}`);
    return null;
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (error) {
    // Never delete the set here: without the manifest the images lose their
    // product name, items and listing drafts permanently.
    await quarantine(filePath, error?.message || "invalid JSON");
    return null;
  }
}

async function collectSets() {
  const sets = [];
  for (const dirName of SET_MANIFEST_DIRS) {
    const dir = join(OUTPUT_DIR, METADATA_DIRNAME, dirName);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      log(`cannot list ${dirName}: ${error?.message || error}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== ".json") continue;
      const manifestPath = join(dir, entry.name);
      const manifest = await readManifest(manifestPath);
      if (!manifest) continue;

      const relativeDir = dirName === "ppt-decks"
        ? getPptRelativeDir(manifest)
        : normalizeRelative(manifest.relativeDir);
      const declaredId = String(manifest.setId || manifest.deckId || manifest.id || "").trim();
      if (!declaredId) {
        // Not a set manifest we recognise; leave it alone.
        continue;
      }
      // A record we cannot resolve to a safe, removable directory must not be
      // counted either: counting it without being able to evict it would push
      // the GC into over-deleting the sets it *can* remove.
      const imageDir = resolveSetDirectory(relativeDir);
      if (!imageDir) {
        log(`skipping set with unresolvable directory: ${relativeDir || "(empty)"}`);
        continue;
      }

      const manifestStat = await statOrNull(manifestPath);
      const createdAt = Date.parse(String(manifest.createdAt || ""));
      const imageDirStat = await statOrNull(imageDir);
      // Grace: a set created long ago may still be generating right now, so also
      // consider when its image directory was last touched.
      const lastTouched = Math.max(
        Number.isFinite(createdAt) ? createdAt : 0,
        manifestStat?.mtimeMs || 0,
        imageDirStat?.mtimeMs || 0,
      );
      sets.push({
        manifestPath,
        relativeDir,
        sortKey: Number.isFinite(createdAt) ? createdAt : manifestStat?.mtimeMs || 0,
        lastTouched,
      });
    }
  }
  sets.sort((left, right) => left.sortKey - right.sortKey);
  return sets;
}

async function evictSets(sets, now) {
  if (sets.length <= MAX_SETS) return 0;
  let removed = 0;
  for (const set of sets) {
    if (sets.length - removed <= MAX_SETS) break;
    if (now - set.lastTouched < GRACE_MS) continue;
    const imageDir = resolveSetDirectory(set.relativeDir);
    const metadataDir = resolveSetDirectory(set.relativeDir, { metadata: true });
    const imageRemoved = await removeVerifiedDirectory(imageDir);
    const metadataRemoved = await removeVerifiedDirectory(metadataDir);
    if (!imageRemoved || !metadataRemoved) {
      log(`skipped set ${set.relativeDir} (unsafe or locked path)`);
      continue;
    }
    await removeManifestFile(set.manifestPath);
    removed += 1;
  }
  return removed;
}

/** Standalone images: skip the whole metadata tree and every set subtree. */
async function collectSingles(dir = OUTPUT_DIR, relativeDir = "", depth = 0) {
  if (depth > 8) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    log(`cannot list ${relativeDir || "."}: ${error?.message || error}`);
    return [];
  }

  const singles = [];
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (depth === 0 && entry.name === METADATA_DIRNAME) continue;
      if (SET_MARKER_RE.test(entry.name)) continue;
      singles.push(...(await collectSingles(join(dir, entry.name), relativePath, depth + 1)));
      continue;
    }
    if (!entry.isFile() || !IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const info = await statOrNull(join(dir, entry.name));
    if (!info) continue;
    singles.push({ absolutePath: join(dir, entry.name), relativePath, mtimeMs: info.mtimeMs });
  }
  return singles;
}

/** Sidecar path mirrors the image path under the metadata root. */
function sidecarPathFor(relativePath) {
  const segments = relativePath.split("/");
  const filename = segments.pop() || "";
  const stem = filename.replace(/\.[^.]+$/u, "");
  return resolve(OUTPUT_DIR, METADATA_DIRNAME, ...segments, `${stem}.json`);
}

// Atomic writes stage into "<name>.tmp" and swap it in with rename(). A process
// killed between the two leaves the temp file behind, and the older index
// writer did the same. Interrupted deletions leave ".gc-<pid>-<ts>" husks.
// Neither is harmful, but both would accumulate forever on a persistent volume.
const TEMP_FILE_RE = /\.tmp$/u;
const TRASH_HUSK_RE = /\.gc-\d+-\d+$/u;

async function sweepStaleArtifacts(root, dir, now, depth = 0) {
  if (depth > 8) return 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    log(`cannot list ${relative(OUTPUT_DIR, dir) || "."}: ${error?.message || error}`);
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    const info = await statOrNull(absolutePath);
    if (!info) continue;
    if (now - info.mtimeMs < GRACE_MS) continue;
    if (!isInside(root, absolutePath)) continue;

    if (entry.isDirectory()) {
      if (TRASH_HUSK_RE.test(entry.name)) {
        if (DRY_RUN) { removed += 1; continue; }
        try {
          await rm(absolutePath, { recursive: true, force: true });
          removed += 1;
        } catch (error) {
          log(`failed to remove leftover ${relative(OUTPUT_DIR, absolutePath)}: ${error?.message || error}`);
        }
        continue;
      }
      // Temp files sit next to whatever they were staging, so this has to walk
      // the whole tree — a top-level-only scan misses every one of them.
      removed += await sweepStaleArtifacts(root, absolutePath, now, depth + 1);
      continue;
    }
    if (!TEMP_FILE_RE.test(entry.name)) continue;
    if (DRY_RUN) { removed += 1; continue; }
    try {
      await rm(absolutePath, { force: true });
      removed += 1;
    } catch (error) {
      log(`failed to remove leftover ${relative(OUTPUT_DIR, absolutePath)}: ${error?.message || error}`);
    }
  }
  return removed;
}

async function sweepAllStaleArtifacts(now) {
  // The gallery index lives in dirname(OUTPUT_DIR)/.local, i.e. outside the
  // asset tree, so it needs its own sweep root.
  const roots = [OUTPUT_DIR, resolve(OUTPUT_DIR, "..", ".local")];
  let removed = 0;
  for (const root of roots) {
    const info = await statOrNull(root);
    if (!info?.isDirectory()) continue;
    removed += await sweepStaleArtifacts(root, root, now);
  }
  return removed;
}

async function evictSingles(singles, now) {
  if (singles.length <= MAX_IMAGES) return 0;
  singles.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let removed = 0;
  for (const single of singles) {
    if (singles.length - removed <= MAX_IMAGES) break;
    if (now - single.mtimeMs < GRACE_MS) continue;
    const imageRemoved = await removeVerifiedFile(single.absolutePath);
    if (!imageRemoved) continue;
    await removeVerifiedFile(sidecarPathFor(single.relativePath));
    removed += 1;
  }
  return removed;
}

async function runOnce() {
  if (!ENABLED) return;
  const startedAt = Date.now();
  const info = await statOrNull(OUTPUT_DIR);
  if (!info?.isDirectory()) {
    log(`output directory not ready: ${OUTPUT_DIR}`);
    return;
  }

  const sets = await collectSets();
  const removedSets = await evictSets(sets, startedAt);
  const singles = await collectSingles();
  const removedImages = await evictSingles(singles, startedAt);
  // Last, so that touching a directory cannot influence the grace decisions above.
  const removedLeftovers = await sweepAllStaleArtifacts(startedAt);

  const keptSets = sets.length - removedSets;
  const keptImages = singles.length - removedImages;
  const overSets = keptSets > MAX_SETS;
  const overImages = keptImages > MAX_IMAGES;
  const suffix = DRY_RUN ? " (dry-run, nothing deleted)" : "";
  if (removedSets || removedImages || removedLeftovers || overSets || overImages) {
    const held = overSets || overImages ? ", some entries held back by the grace period" : "";
    const leftovers = removedLeftovers ? `, cleaned ${removedLeftovers} leftover temp file(s)` : "";
    log(`removed ${removedImages} image(s) and ${removedSets} set(s); kept ${keptImages}/${MAX_IMAGES} images, ${keptSets}/${MAX_SETS} sets${leftovers}${held}${suffix}`);
  }
}

async function main() {
  if (!ENABLED) {
    log("disabled (STUDIO_RETENTION_ENABLED=0)");
    return;
  }
  log(
    `watching ${OUTPUT_DIR} — keep ${MAX_IMAGES} images / ${MAX_SETS} sets, ` +
      `every ${INTERVAL_SEC}s, ${GRACE_SEC}s grace${DRY_RUN ? ", DRY RUN" : ""}`,
  );
  if (!args.has("--daemon")) {
    await runOnce();
    return;
  }
  for (;;) {
    try {
      await runOnce();
    } catch (error) {
      // A failed pass must never kill the loop.
      log(`pass failed: ${error?.stack || error?.message || error}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, INTERVAL_SEC * 1000));
  }
}

main().catch((error) => {
  console.error(`[retention] fatal: ${error?.stack || error?.message || error}`);
  process.exitCode = 1;
});
