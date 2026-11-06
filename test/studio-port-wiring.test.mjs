import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appPath = new URL("../public/app.js", import.meta.url);
const htmlPath = new URL("../public/index.html", import.meta.url);
const syncScriptPath = new URL("../scripts/sync-public-lib.mjs", import.meta.url);

async function readApp() {
  return readFile(appPath, "utf8");
}

test("clipboard hardening runs before every paste route", async () => {
  const app = await readApp();

  // Each scoped handler must read the bytes at paste time and then apply through
  // the shared hardening step; handing the raw ClipboardEvent files straight to
  // apply* is the bug that made pastes intermittently read as empty.
  for (const handler of [
    "handlePromptAgentImagePaste",
    "handleStudioImagePaste",
    "handleCreationReferenceImagePaste",
  ]) {
    const body = new RegExp(`function ${handler}\\(event\\) \\{[\\s\\S]*?hardenClipboardImagePaste\\(imageFiles`);
    assert.match(app, body, `${handler} must apply clipboard images through hardenClipboardImagePaste`);
  }

  assert.match(
    app,
    /async function hardenClipboardImagePaste\(imageFiles, apply\) \{[\s\S]*prepareClipboardImageFiles\(imageFiles, \{[\s\S]*decodeImageFile: decodeClipboardImageFile,[\s\S]*retryDelayMs: 60,/,
  );
});

test("the global paste fallback defers to the scoped handlers", async () => {
  const app = await readApp();

  // Registered after the scoped handlers and guarded by defaultPrevented so a
  // paste is never consumed twice.
  assert.match(app, /document\.addEventListener\("paste", handleGlobalImagePaste\);/);
  assert.match(
    app,
    /function handleGlobalImagePaste\(event\) \{[\s\S]*if \(event\.defaultPrevented\) \{[\s\S]*return;[\s\S]*getClipboardImageFiles\(event\.clipboardData\)/,
  );
});

test("the global paste fallback covers the views that have no scoped handler", async () => {
  const app = await readApp();

  // Upstream has no paste handler for these three views; dropping them would be
  // a regression against the fork.
  for (const view of ["reference-analysis", "image-decomposition", "portrait"]) {
    assert.match(app, new RegExp(`if \\(view === "${view}"\\)`));
  }
  assert.match(app, /if \(view === "studio"\) \{[\s\S]*applyReferenceFiles\(imageFiles\);/);
  assert.match(app, /if \(view === "creation"\) \{[\s\S]*applyCreationReferenceFiles\(imageFiles\);/);
});

test("gallery selection drives download and delete as two distinct actions", async () => {
  const app = await readApp();
  const html = await readFile(htmlPath, "utf8");

  // The upstream delete actions must survive the port untouched.
  assert.match(app, /refs\.galleryDeleteSelectedButton\.addEventListener\("click", \(\) => requestAssetRecordDelete\("gallery", "selected"\)\);/);
  assert.match(app, /refs\.galleryDeleteCurrentButton\.addEventListener\("click", \(\) => requestAssetRecordDelete\("gallery", "current"\)\);/);

  // Downloading must never clear or mutate the shared checked set.
  assert.match(app, /async function batchDownloadSelectedGalleryItems\(\) \{[\s\S]*selectGalleryItemsByFilenames\(state\.gallery, \[\.\.\.state\.galleryCheckedFilenames\]\)/);
  assert.doesNotMatch(
    app,
    /async function batchDownloadSelectedGalleryItems\(\) \{[\s\S]{0,2000}?galleryCheckedFilenames = \[\]/,
  );
});

test("the gallery download control cannot be mistaken for a delete control", async () => {
  const html = await readFile(htmlPath, "utf8");
  const downloadButton = html.match(/<button[^>]*id="galleryDownloadSelectedButton"[^>]*>/);

  assert.ok(downloadButton, "the gallery must expose a download-selected control");
  const tag = downloadButton[0];
  assert.doesNotMatch(tag, /\bdanger\b/, "the download control must not borrow the destructive styling");
  assert.match(tag, /aria-label="[^"]*下载[^"]*"/, "the download control needs its own accessible name");
  assert.doesNotMatch(tag, /删除/, "the download control must not be labelled as a delete");
});

test("prompt template normalization keeps shared params and the title toggle", async () => {
  const app = await readApp();

  // Dropping these two fields is the silent data loss the research notes warned
  // about: a shared template would import without its params or analyzeTitle.
  assert.match(
    app,
    /function normalizePromptTemplate\(template, index = 0\) \{[\s\S]*params: normalizePromptTemplateParams\(template\?\.params\),[\s\S]*analyzeTitle: template\?\.analyzeTitle === true,/,
  );
});

test("prompt set generation is not reachable through native form validation", async () => {
  const html = await readFile(htmlPath, "utf8");

  // The product title is a fork-only field. Marking it required inside
  // #generateForm would let HTML5 constraint validation block every prompt-mode
  // submit before app.js ever sees the event.
  const form = html.match(/<form id="generateForm"[\s\S]*?<\/form>/);
  assert.ok(form, "the studio must keep its generate form");
  if (/id="productTitleInput"/.test(form[0])) {
    assert.doesNotMatch(
      form[0].match(/<textarea[^>]*id="productTitleInput"[^>]*>/)[0],
      /\brequired\b/,
      "the fork-only product title must not gate the shared generate form",
    );
  }
});

test("every module the browser loads is on the public-lib sync list", async () => {
  const script = await readFile(syncScriptPath, "utf8");

  // A module missing from this list still works until the next sync, then the
  // browser silently keeps loading a stale public/lib copy. sync --check cannot
  // catch it because it only compares files that are listed.
  for (const moduleName of [
    "clipboard-image-files.mjs",
    "prompt-kit-share.mjs",
    "studio-enhancements.mjs",
    "site-branding.mjs",
  ]) {
    assert.match(
      script,
      new RegExp(`"${moduleName.replace(/\./g, "\\.")}"`),
      `${moduleName} must be listed in PUBLIC_LIB_SYNC_TARGETS`,
    );
  }
});
