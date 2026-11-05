import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  decodePromptKitSharePayload,
  encodePromptKitSharePayload,
  formatPromptKitShareCode,
  mergePromptKitShareData,
  movePromptTemplateInList,
  parsePromptKitShareCode,
  removePromptTemplatesFromLibrary,
} from "../lib/prompt-kit-share.mjs";

const sharedKit = {
  templates: [
    {
      id: "template-main",
      name: "亚马逊主图",
      prompt: "白色背景上的产品包装，保持标签文字清晰。",
      params: { ratio: "1:1", size: "2K", format: "png", reasoningEffort: "high" },
    },
    { id: "template-detail", name: "细节图", prompt: "展示产品包装细节。" },
  ],
  sets: [
    {
      id: "set-amazon",
      name: "亚马逊套图",
      templateIds: ["template-main", "template-detail"],
      updatedAt: "2026-07-16T12:00:00.000Z",
    },
  ],
  active: {
    selectedTemplateId: "template-main",
    selectedSetId: "set-amazon",
    prompt: "当前正在编辑的提示词",
    params: { ratio: "4:5", size: "1K", format: "webp", reasoningEffort: "medium" },
    promptEnhanceEnabled: true,
    promptEnhanceText: ", crisp details",
  },
};

test("prompt kit share payload round-trips templates, sets, prompt, and parameters", async () => {
  const payload = await encodePromptKitSharePayload(sharedKit);
  const decoded = await decodePromptKitSharePayload(payload);

  assert.ok(payload.startsWith("gz.") || payload.startsWith("b64."));
  assert.deepEqual(decoded, sharedKit);
});

test("prompt kit share code is independent from the website URL", () => {
  const code = formatPromptKitShareCode("gz.a-b_c");
  assert.equal(code, "PROMPT-KIT.V1.gz.a-b_c");
  assert.equal(parsePromptKitShareCode(`  ${code}\n`), "gz.a-b_c");
  assert.throws(() => parsePromptKitShareCode("https://studio.example.test/#studio"), /口令格式/);
});

test("shared prompt kit replaces matching ids and preserves unrelated recipient templates", () => {
  const merged = mergePromptKitShareData(
    [
      { id: "template-main", name: "旧主图", prompt: "旧内容" },
      { id: "recipient-only", name: "接收方自有", prompt: "不要删除" },
    ],
    [{ id: "recipient-set", name: "接收方套图", templateIds: ["recipient-only"] }],
    sharedKit,
  );

  assert.equal(merged.templates.find((item) => item.id === "template-main").name, "亚马逊主图");
  assert.equal(merged.templates.find((item) => item.id === "recipient-only").prompt, "不要删除");
  assert.deepEqual(merged.sets.map((item) => item.id), ["set-amazon", "recipient-set"]);
});

test("invalid shared payloads are rejected without producing empty configuration", async () => {
  await assert.rejects(() => decodePromptKitSharePayload("b64.invalid"), /损坏|格式/);
  await assert.rejects(() => encodePromptKitSharePayload({ templates: [] }), /没有可用/);
});

test("prompt templates can move up and down without changing their ids", () => {
  const templates = [
    { id: "a", name: "A", prompt: "A" },
    { id: "b", name: "B", prompt: "B" },
    { id: "c", name: "C", prompt: "C" },
  ];
  assert.deepEqual(movePromptTemplateInList(templates, "b", "up").map((item) => item.id), ["b", "a", "c"]);
  assert.deepEqual(movePromptTemplateInList(templates, "b", "down").map((item) => item.id), ["a", "c", "b"]);
  assert.deepEqual(movePromptTemplateInList(templates, "a", "up").map((item) => item.id), ["a", "b", "c"]);
});

test("batch deleting templates also removes their references from prompt sets", () => {
  const result = removePromptTemplatesFromLibrary(
    sharedKit.templates,
    sharedKit.sets,
    new Set(["template-main"]),
  );
  assert.deepEqual(result.templates.map((item) => item.id), ["template-detail"]);
  assert.deepEqual(result.sets[0].templateIds, ["template-detail"]);
});

test("prompt panel exposes separate share-code import, batch delete, and ordering controls", async () => {
  const [app, html] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="promptKitCodeInput"/);
  assert.match(html, /id="importPromptKitCodeButton"/);
  assert.match(html, /id="promptTemplateBatchDeleteButton"/);
  assert.match(app, /movePromptTemplateInList/);
  assert.doesNotMatch(app, /importPromptKitFromLocation|buildPromptKitShareHash/);
});

test("TXT content tolerates BOM, wrapping, and Markdown escapes", async () => {
  const payload = await encodePromptKitSharePayload(sharedKit);
  const code = formatPromptKitShareCode(payload);
  const forwarded = '\uFEFF```txt\n' + code.replace(/[_-]/g, '\\$&').replace(/(.{70})/g, '$1\n') + '\n```';
  assert.deepEqual(await decodePromptKitSharePayload(parsePromptKitShareCode(forwarded)), sharedKit);
});

test("damaged and truncated codes report actionable Chinese errors", async () => {
  await assert.rejects(decodePromptKitSharePayload("gz.abc...def"), /截断.*TXT/);
  await assert.rejects(decodePromptKitSharePayload("gz.abc$def"), /编码不正确.*TXT/);
  await assert.rejects(decodePromptKitSharePayload("gz.a"), /编码不正确.*TXT/);
  await assert.rejects(decodePromptKitSharePayload("gz.YWJj"), /损坏或不完整.*TXT/);
});

test("uncompressed legacy payloads still import", async () => {
  const compact = { v: 1, t: [["old", "旧模板", "中文提示词", null]], s: [], a: [] };
  const payload = "b64." + Buffer.from(JSON.stringify(compact)).toString("base64url");
  const decoded = await decodePromptKitSharePayload(payload);
  assert.equal(decoded.templates[0].prompt, "中文提示词");
});

test("share button produces a complete downloadable TXT that can be decoded", async () => {
  const { runInNewContext } = await import("node:vm");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("async function sharePromptKit()"), app.indexOf("function setPromptKitCodeFeedback("));
  let saved;
  const button = { textContent: "导出分享 TXT", disabled: false };
  await runInNewContext(source + "\nsharePromptKit()", {
    refs: { sharePromptKitButton: button },
    buildCurrentPromptKitShareData: () => sharedKit,
    encodePromptKitSharePayload, formatPromptKitShareCode, Blob, Date,
    triggerBrowserImageDownload: (blob, filename) => { saved = { blob, filename }; },
    setPromptKitCodeFeedback: () => {},
  });
  assert.match(saved.filename, /\.txt$/);
  assert.equal(saved.blob.type, "text/plain;charset=utf-8");
  assert.deepEqual(await decodePromptKitSharePayload(parsePromptKitShareCode(await saved.blob.text())), sharedKit);
  assert.equal(button.disabled, false);
});

test("TXT file selection reads content, imports, and resets the picker", async () => {
  const { runInNewContext } = await import("node:vm");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("async function importPromptKitFile()"), app.indexOf("async function importPromptKitShareCode()"));
  const code = formatPromptKitShareCode(await encodePromptKitSharePayload(sharedKit));
  const refs = {
    promptKitFileInput: { files: [new Blob([code])], value: "selected.txt" },
    importPromptKitFileButton: { disabled: false },
    promptKitCodeInput: { value: "" },
  };
  let imported;
  const context = {
    refs, parsePromptKitShareCode,
    importPromptKitShareCode: async () => { imported = await decodePromptKitSharePayload(parsePromptKitShareCode(refs.promptKitCodeInput.value)); },
    setPromptKitCodeFeedback: () => {},
  };
  await runInNewContext(source + "\nimportPromptKitFile()", context);
  assert.deepEqual(imported, sharedKit);
  assert.equal(refs.promptKitFileInput.value, "");
  assert.equal(refs.importPromptKitFileButton.disabled, false);
  imported = null;
  refs.promptKitFileInput.files = [{ size: 1_000_001, text() { throw new Error("must not read"); } }];
  await runInNewContext(source + "\nimportPromptKitFile()", context);
  assert.equal(imported, null);
});

test("title analysis preference survives sharing and import", async () => {
  const kit = structuredClone(sharedKit);
  kit.templates[0].analyzeTitle = true;
  kit.templates[1].analyzeTitle = false;
  const decoded = await decodePromptKitSharePayload(await encodePromptKitSharePayload(kit));
  assert.equal(decoded.templates[0].analyzeTitle, true);
  assert.ok(!decoded.templates[1].analyzeTitle);
});
