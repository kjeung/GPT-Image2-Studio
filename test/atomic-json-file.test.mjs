import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  quarantineJsonFile,
  readJsonFileOrThrowMissing,
  readJsonFileSafe,
  writeJsonFileAtomic,
} from "../lib/atomic-json-file.mjs";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function corruptFilesIn(dir) {
  return (await readdirSafe(dir)).filter((name) => name.endsWith(".corrupt"));
}

async function readdirSafe(dir) {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function makeRoot(t, prefix) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test("damaged JSON is quarantined with a fixed suffix instead of throwing or being deleted", async (t) => {
  const rootDir = await makeRoot(t, "atomic-json-quarantine-");
  const filePath = join(rootDir, "state.json");
  await writeFile(filePath, '{not-json"', "utf8");

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const value = await readJsonFileSafe(filePath, { label: "state.json" });
    assert.equal(value, null);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(await pathExists(filePath), false, "the damaged file must be moved aside, not read in place");
  const corruptPath = `${filePath}.corrupt`;
  assert.equal(await pathExists(corruptPath), true, "the damaged bytes must stay diagnosable on disk");
  assert.equal(await readFile(corruptPath, "utf8"), '{not-json"');
  assert.match(warnings.join("\n"), /state\.json/u, "the caller-supplied label is what gets reported");

  const restarted = await readJsonFileSafe(filePath, { label: "state.json" });
  assert.equal(restarted, null, "a quarantined path reads as absent afterwards");
});

test("repeated corruption of the same path keeps exactly one .corrupt file", async (t) => {
  const rootDir = await makeRoot(t, "atomic-json-repeat-");
  const filePath = join(rootDir, "state.json");

  for (let round = 0; round < 3; round += 1) {
    await writeFile(filePath, `bad-${round}`, "utf8");
    assert.equal(await readJsonFileSafe(filePath, { quarantine: true }), null);
  }

  assert.deepEqual(await corruptFilesIn(rootDir), ["state.json.corrupt"]);
  assert.equal(await readFile(`${filePath}.corrupt`, "utf8"), "bad-2", "the newest damaged bytes win");
});

test("a missing file reads as null without being quarantined, and parse errors still propagate for other callers", async (t) => {
  const rootDir = await makeRoot(t, "atomic-json-missing-");
  const missingPath = join(rootDir, "never-written.json");

  assert.equal(await readJsonFileSafe(missingPath), null);
  assert.deepEqual(await corruptFilesIn(rootDir), [], "absence is not corruption");

  const filePath = join(rootDir, "state.json");
  await writeFile(filePath, "{}", "utf8");
  const onCorruptCalls = [];
  const value = await readJsonFileSafe(filePath, {
    quarantine: false,
    onCorrupt: (reported) => onCorruptCalls.push(reported),
  });
  assert.deepEqual(value, {});
  assert.equal(onCorruptCalls.length, 0, "a valid file never reports corruption");

  await writeFile(filePath, "damaged", "utf8");
  await readJsonFileSafe(filePath, { quarantine: false, onCorrupt: (reported) => onCorruptCalls.push(reported) });
  assert.equal(onCorruptCalls.length, 1);
  assert.equal(onCorruptCalls[0].filePath, filePath);
  assert.equal(await pathExists(filePath), true, "quarantine:false leaves the file for the caller to handle");
});

test("readJsonFileOrThrowMissing reports quarantined damage as ENOENT so existing fallbacks keep working", async (t) => {
  const rootDir = await makeRoot(t, "atomic-json-throw-");
  const filePath = join(rootDir, "manifest.json");
  await writeFile(filePath, "{broken", "utf8");

  await assert.rejects(
    () => readJsonFileOrThrowMissing(filePath, { label: "manifest.json" }),
    (error) => {
      assert.equal(error.code, "ENOENT");
      return true;
    },
  );
  assert.equal(await pathExists(`${filePath}.corrupt`), true, "the file is quarantined before the error leaves");

  await assert.rejects(() => readJsonFileOrThrowMissing(join(rootDir, "missing.json"), {}, ), (error) => {
    assert.equal(error.code, "ENOENT");
    return true;
  });
});

test("quarantineJsonFile replaces an older corrupt copy rather than accumulating", async (t) => {
  const rootDir = await makeRoot(t, "atomic-json-replace-");
  const filePath = join(rootDir, "state.json");
  await writeFile(`${filePath}.corrupt`, "older", "utf8");
  await writeFile(filePath, "newer", "utf8");

  assert.equal(await quarantineJsonFile(filePath), `${filePath}.corrupt`);
  assert.equal(await readFile(`${filePath}.corrupt`, "utf8"), "newer");
  assert.equal(await pathExists(filePath), false);

  assert.equal(await quarantineJsonFile(join(rootDir, "absent.json")), "");
});

test("valid JSON is parsed byte-for-byte identically to JSON.parse, including a BOM", async (t) => {
  const rootDir = await makeRoot(t, "atomic-json-valid-");
  const filePath = join(rootDir, "state.json");
  const payload = { version: 1, entries: [{ id: "a", createdAt: "2026-05-05T00:00:00.000Z" }] };

  await writeJsonFileAtomic(filePath, payload);
  assert.deepEqual(await readJsonFileSafe(filePath), payload);
  const onDisk = await readFile(filePath, "utf8");
  assert.equal(onDisk, `${JSON.stringify(payload, null, 2)}\n`, "the upstream write shape is unchanged");

  await writeFile(filePath, `\uFEFF${onDisk}`, "utf8");
  assert.deepEqual(await readJsonFileSafe(filePath), payload);
});

test("config store falls back to defaults when config.json is damaged, keeping the bytes aside", async (t) => {
  const rootDir = await makeRoot(t, "atomic-json-config-");
  await mkdir(join(rootDir, ".local"), { recursive: true });
  const configPath = join(rootDir, ".local", "config.json");
  await writeFile(configPath, "{ broken", "utf8");

  const { createConfigStore } = await import("../lib/config-store.mjs");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  let config;
  try {
    config = await createConfigStore({ rootDir }).readPublicConfig();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(config.apiKeyConfigured, false, "a damaged config reads as no saved config");
  assert.match(warnings.join("\n"), /config\.json/u);
  assert.equal(await pathExists(`${configPath}.corrupt`), true);

  const store = createConfigStore({ rootDir });
  await store.saveConfig({ apiKey: "sk-recovered" });
  assert.equal((await store.readPublicConfig()).apiKeyConfigured, true, "saving works again after quarantine");
  assert.equal(await pathExists(configPath), true);
});

test("gallery store quarantines a damaged index and still lists the images it can rebuild", async (t) => {
  const rootDir = await makeRoot(t, "atomic-json-gallery-");
  const outputDir = join(rootDir, "output");
  const indexPath = join(rootDir, ".local", "gallery-index.json");
  const { listGalleryItems, saveGeneratedAsset } = await import("../lib/gallery-store.mjs");

  await saveGeneratedAsset({
    outputDir,
    indexPath,
    filename: "kept.png",
    imageBuffer: Buffer.from("image"),
    metadata: { createdAt: "2026-05-05T09:00:00.000Z", prompt: "kept", format: "png" },
  });
  await writeFile(indexPath, "{ damaged", "utf8");

  const items = await listGalleryItems({ outputDir, indexPath });
  assert.equal(items.some((item) => item.filename === "kept.png"), true, "the derived index is rebuilt, not fatal");
  assert.equal(await pathExists(`${indexPath}.corrupt`), true);
  assert.equal(await pathExists(indexPath), true, "the rebuilt index is written back to the original path");
});

test("gallery store skips a damaged sidecar instead of failing the whole listing", async (t) => {
  const rootDir = await makeRoot(t, "atomic-json-sidecar-");
  const outputDir = join(rootDir, "output");
  const indexPath = join(rootDir, ".local", "gallery-index.json");
  const { listGalleryItems, saveGeneratedAsset } = await import("../lib/gallery-store.mjs");

  const saved = await saveGeneratedAsset({
    outputDir,
    indexPath,
    filename: "solo.png",
    imageBuffer: Buffer.from("image"),
    metadata: { createdAt: "2026-05-05T09:00:00.000Z", prompt: "solo", format: "png" },
  });
  const sidecarPath = join(outputDir, "json", ...saved.relativePath.split("/").slice(0, -1));
  const sidecarFile = join(sidecarPath, `${basename(saved.relativePath, ".png")}.json`);
  await writeFile(sidecarFile, "corrupted sidecar", "utf8");

  const items = await listGalleryItems({ outputDir, indexPath });
  const listed = items.find((item) => item.filename === "solo.png");
  assert.ok(listed, "the image still lists");
  assert.equal(listed.prompt, "solo", "the index supplies the fields the damaged sidecar would have");
  assert.equal(await pathExists(`${sidecarFile}.corrupt`), true);
});

test("portrait store lists the sets it can read and skips a quarantined manifest", async (t) => {
  const rootDir = await makeRoot(t, "atomic-json-portrait-");
  const outputDir = join(rootDir, "output");
  const { createPortraitSetStore } = await import("../lib/portrait-store.mjs");
  const store = createPortraitSetStore({ outputDir });

  await store.saveManifest({
    setId: "portrait-fine",
    subjectName: "Fine Set",
    createdAt: "2026-05-05T09:00:00.000Z",
  });
  await store.saveManifest({
    setId: "portrait-broken",
    subjectName: "Broken Set",
    createdAt: "2026-05-05T10:00:00.000Z",
  });
  await writeFile(store.manifestPath("portrait-broken"), "{ nope", "utf8");

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  let manifests;
  try {
    manifests = await store.listManifests();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(manifests.map((manifest) => manifest.setId), ["portrait-fine"]);
  assert.match(warnings.join("\n"), /portrait-broken\.json/u);
  assert.equal(await pathExists(`${store.manifestPath("portrait-broken")}.corrupt`), true);
});
