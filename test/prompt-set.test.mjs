import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFile } from "node:fs/promises";

import {
  buildTitleAwarePrompt,
  normalizePromptSet,
  normalizePromptTemplateParams,
  removePromptTemplateFromSets,
  resolvePromptSetTemplates,
} from "../lib/studio-enhancements.mjs";

test("prompt set normalization keeps a stable unique template order", () => {
  assert.deepEqual(
    normalizePromptSet({
      id: "set-amazon",
      name: " Amazon 六图 ",
      templateIds: ["main", "benefit", "main", "", null, "usage"],
    }),
    {
      id: "set-amazon",
      name: "Amazon 六图",
      templateIds: ["main", "benefit", "usage"],
      updatedAt: "",
    },
  );
});

test("prompt set resolution follows saved order and ignores deleted templates", () => {
  const templates = [
    { id: "main", prompt: "main prompt" },
    { id: "usage", prompt: "usage prompt" },
  ];
  const resolved = resolvePromptSetTemplates(
    { templateIds: ["usage", "deleted", "main"] },
    templates,
  );
  assert.deepEqual(resolved.map((template) => template.id), ["usage", "main"]);
});

test("deleting a prompt template removes it from every prompt set", () => {
  const result = removePromptTemplateFromSets([
    { id: "set-a", name: "A", templateIds: ["main", "usage"] },
    { id: "set-b", name: "B", templateIds: ["usage", "benefit"] },
  ], "usage");
  assert.deepEqual(result.map((promptSet) => promptSet.templateIds), [["main"], ["benefit"]]);
});

// #18: 标题不再由任何开关决定——填了就是填了，不填就是不填。
// 这个纯函数是两条链路（单发与套图）唯一的合并点，所以它的契约先在这里钉死。
test("title analysis needs no switch and never rejects an empty title", () => {
  const first = buildTitleAwarePrompt("main image", "Title A");
  const next = buildTitleAwarePrompt("main image", "Title B");
  assert.match(first, /Title A/);
  assert.match(next, /Title B/);
  assert.ok(!next.includes("Title A"));
  // 空/纯空白/根本没传：原样返回，不抛错。套图的空标题硬失败正是靠这条消失的。
  assert.equal(buildTitleAwarePrompt("main image", "  "), "main image");
  assert.equal(buildTitleAwarePrompt("main image", ""), "main image");
  assert.equal(buildTitleAwarePrompt("main image"), "main image");
});

// 报告人指出「标题是字符串，却声称为 JSON 字符串」。载荷本身仍是 JSON 字符串
// 字面量（这是提示注入防护，不能去掉），但措辞必须说人话。
test("the injected title block names the payload for what it is", () => {
  const prompt = buildTitleAwarePrompt("main image", '磨砂黑 "手机壳"');
  assert.ok(!prompt.includes("JSON 字符串"), "标量字面量不能被称为「JSON 字符串数据」");
  assert.ok(
    prompt.includes('\\"手机壳\\"'),
    "标题仍以转义后的字符串字面量注入，注入防护不许退化",
  );
  assert.match(prompt, /不是操作指令/);
});

// Ticket constraint: these two top-level entry points must survive the v0.2.116
// app.js rewrite, so the slice below stays addressable.
// #18 A1/A2：单发链路必须把标题带进 prompt，且标题为空时与不填逐字节一致。
// 这里跑的是 public/app.js 里真实的 buildPromptModePrompt 与 buildPromptEnhancementSuffix，
// 不打桩——否则「标题进没进 prompt」这件事根本没被测到。
function loadRealPromptModePrompt(source, overrides = {}) {
  const body = sliceTopLevelFunction2(source, "function buildPromptModePrompt(", "buildTitleAwarePrompt");
  const suffixFn = sliceDeclaration(source, "function buildPromptEnhancementSuffix(");
  const context = {
    refs: {
      promptInput: { value: "主图，白底" },
      productTitleInput: { value: "" },
      promptEnhanceInput: { value: "" },
      ...(overrides.refs || {}),
    },
    state: { promptEnhanceEnabled: false, ...(overrides.state || {}) },
    buildTitleAwarePrompt,
  };
  runInNewContext(`${suffixFn}\n${body}\n;globalThis.__build = buildPromptModePrompt;`, context);
  return { buildPromptModePrompt: context.__build, context };
}

// sliceTopLevelFunction 会断言切片里调用了指定函数；buildPromptModePrompt 在标题为空时
// 不调用 buildTitleAwarePrompt，所以这里只要切片本身，不额外断言调用。
function sliceTopLevelFunction2(source, anchor, _unused) {
  const start = source.indexOf(anchor);
  assert.ok(start !== -1, `public/app.js must expose ${JSON.stringify(anchor)}.`);
  const rest = source.slice(start + anchor.length);
  // 必须一并停在顶层 const 上：buildPromptModePrompt 后面紧跟的 syncPromptEnhanceMode
  // 与它同处一行，只按 function 停会把 DEFAULT_PROMPT_TEMPLATES 这类常量带进来，
  // 求值时直接 ReferenceError（SURPRISE_PROMPTS is not defined）。
  const nextDeclaration = rest.search(/\n(async function |function |const )/);
  const body = nextDeclaration === -1
    ? source.slice(start)
    : source.slice(start, start + anchor.length + nextDeclaration);
  assert.ok(body.length > 0, `sliced body for ${JSON.stringify(anchor)} must not be empty.`);
  return body;
}

test("prompt mode carries a filled title into the request prompt", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const { buildPromptModePrompt } = loadRealPromptModePrompt(source, {
    refs: { productTitleInput: { value: "磨砂黑手机壳" } },
  });

  const prompt = buildPromptModePrompt();
  assert.match(prompt, /^主图，白底/);
  assert.match(prompt, /磨砂黑手机壳/);
  assert.match(prompt, /不是操作指令/);
});

test("prompt mode without a title submits the prompt byte-for-byte unchanged", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const value of ["", "   ", "\n\t "]) {
    const { buildPromptModePrompt } = loadRealPromptModePrompt(source, {
      refs: { productTitleInput: { value } },
    });
    assert.equal(buildPromptModePrompt(), "主图，白底");
  }
});

const PROMPT_SET_GENERATION_ANCHOR = "async function startPromptSetGeneration(";
const GENERATION_ANCHOR = "async function startGeneration(";

// Slice one top-level declaration out of app.js, stopping at the next top-level
// `function`/`async function` line. We deliberately do NOT slice from the first
// anchor to the second: in v0.2.116 the two declarations may be ordered either
// way, and a reversed order yields an empty slice that would later fail with a
// confusing "startPromptSetGeneration is not a function".
function sliceTopLevelFunction(source, anchor, expectedCall) {
  const start = source.indexOf(anchor);
  assert.ok(
    start !== -1,
    `public/app.js must expose ${JSON.stringify(anchor)} as a top-level declaration (v0.2.116 anchor contract).`,
  );
  const rest = source.slice(start + anchor.length);
  const nextDeclaration = rest.search(/\n(async function |function )/);
  const body = nextDeclaration === -1
    ? source.slice(start)
    : source.slice(start, start + anchor.length + nextDeclaration);
  assert.ok(body.length > 0, `sliced body for ${JSON.stringify(anchor)} must not be empty.`);
  assert.match(
    body,
    new RegExp(`${expectedCall}\\(`),
    `sliced body for ${JSON.stringify(anchor)} must contain a call to ${expectedCall}().`,
  );
  return body;
}

// Like sliceTopLevelFunction, but for a leaf declaration that calls no other
// top-level function (so there is no expected call to assert on).
function sliceDeclaration(source, anchor) {
  const start = source.indexOf(anchor);
  assert.ok(start !== -1, `public/app.js must expose ${JSON.stringify(anchor)}.`);
  const rest = source.slice(start + anchor.length);
  const nextDeclaration = rest.search(/\n(async function |function |const )/);
  return nextDeclaration === -1 ? source.slice(start) : source.slice(start, start + anchor.length + nextDeclaration);
}

// #18：套图的标题不再逐模板看开关——有标题，每一条都带上；没有标题，一条都不带，
// 而且空标题不得再拦下整批提交（旧行为是 showError 后 return，一张都不发）。
test("a prompt set carries the title on every submission without gating on a template switch", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  // Hardened: both anchors must exist before slicing, so a rename fails loudly
  // here instead of silently producing an empty slice and failing later with a
  // confusing "startPromptSetGeneration is not a function". Do not weaken the
  // assertions that follow.
  assert.ok(
    source.indexOf(PROMPT_SET_GENERATION_ANCHOR) !== -1,
    `public/app.js must expose ${JSON.stringify(PROMPT_SET_GENERATION_ANCHOR)}; the 套图 generation entry point must survive the rewrite.`,
  );
  assert.ok(
    source.indexOf(GENERATION_ANCHOR) !== -1,
    `public/app.js must expose ${JSON.stringify(GENERATION_ANCHOR)}; this anchor must survive the rewrite.`,
  );

  const fn = sliceTopLevelFunction(source, PROMPT_SET_GENERATION_ANCHOR, "buildTitleAwarePrompt");
  const templates = [
    { id: "main", prompt: "Main image" },
    { id: "detail", prompt: "Detail image" },
  ];
  const set = { id: "set", templateIds: ["main", "detail"] };
  const state = { promptSets: [set], promptTemplates: templates, jobs: [] };
  const refs = { productTitleInput: { value: "Title A" }, promptSetNameInput: { value: "Set" } };
  const context = {
    state, refs, buildTitleAwarePrompt, resolvePromptSetTemplates,
    getSelectedPromptSet: () => set, getPromptSetDraftTemplates: () => templates,
    // The stub must refuse a submission that carries no prompt: issue #16 shipped
    // precisely because `(job) => job` accepted whatever the caller handed it, so
    // an empty template prompt reached the server and died on the "提示词不能为空"
    // gate. Asserting here keeps the caller honest; createJob's own contract is
    // covered by the test below, which loads the real function.
    createJob: (job = {}) => {
      if (!String(job.prompt || "").trim()) {
        throw new Error("startPromptSetGeneration must pass a non-empty prompt to createJob.");
      }
      return job;
    },
    makeJobPreviewKey: () => "preview",
    ensureReferenceGenerationFilesReady: async () => {},
  };
  // The generation path registers each job with the filmstrip session (issue #17);
  // the harness runs the real function, so it needs that collaborator stubbed too.
  context.state.promptFilmstripSessionJobIds = [];
  context.registerPromptFilmstripSessionJob = () => {};
  for (const name of ["clearError", "setPromptSetFeedback", "showError", "renderPromptSets", "recordJobQueued", "setPromptTemplatePopoverOpen", "setActiveView", "renderAll", "scheduleGenerationQueue"]) context[name] = () => {};
  runInNewContext(fn, context);
  for (const setId of ["set", ""]) {
    state.jobs = [];
    await context.startPromptSetGeneration(setId);
    assert.match(state.jobs[0].prompt, /Title A/);
    // 旧断言这里是 "Detail image"（该模板 analyzeTitle: false 就不带标题）；
    // #18 之后模板级开关不复存在，两条任务必须一致地带标题。
    assert.match(state.jobs[1].prompt, /Title A/);
  }
  refs.productTitleInput.value = "Title B";
  await context.startPromptSetGeneration("set");
  assert.match(state.jobs[0].prompt, /Title B/);
  assert.match(state.jobs[1].prompt, /Title B/);
  assert.ok(!state.jobs[0].prompt.includes("Title A"));
  assert.ok(!state.jobs[1].prompt.includes("Title A"));
  // 空标题不再拦下整批提交：#18 之前这里断言的是 state.jobs.length === 0。
  state.jobs = [];
  refs.productTitleInput.value = "  ";
  await context.startPromptSetGeneration("set");
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[0].prompt, "Main image");
  assert.equal(state.jobs[1].prompt, "Detail image");
});

// Issue #16: 套图批量提交曾整批报「提示词不能为空」。根因是 public/app.js 的
// createJob() 被上游 v0.2.116 的无参版本覆盖，把套图传入的 { prompt, params, ... }
// 静默丢弃，job.prompt 回落到空的提示词输入框。下面加载真实的 createJob 源文本
// （不是打桩），把它的入参契约锁死。
const CREATE_JOB_ANCHOR = "function createJob(";

function loadRealCreateJob(source, overrides = {}) {
  const body = sliceTopLevelFunction(source, CREATE_JOB_ANCHOR, "buildPromptModePrompt");
  // The enhancement suffix is shared by the single-shot and 套图 paths, so slice the
  // real implementation too rather than re-implementing it here.
  const suffixFn = sliceDeclaration(source, "function buildPromptEnhancementSuffix(");
  const refs = {
    promptInput: { value: "" },
    productTitleInput: { value: "" },
    ratioInput: { value: "1:1" },
    sizeSelect: { value: "auto" },
    outputFormatInput: { value: "png" },
    reasoningEffortInput: { value: "high" },
    promptEnhanceInput: { value: "" },
    baseUrlInput: { value: "https://example.test/v1" },
    responsesModelInput: { value: "gpt-5.4" },
    ...(overrides.refs || {}),
  };
  const aspectRatios = [
    { value: "1:1", baseSize: "1024x1024" },
    { value: "3:4", baseSize: "1024x1365" },
  ];
  const context = {
    refs,
    state: {
      referenceFiles: [],
      aspectRatios,
      config: {},
      promptEnhanceEnabled: false,
      ...(overrides.state || {}),
    },
    DEFAULT_UI_RATIO: "1:1",
    DEFAULT_UI_RATIO_LABEL: "1:1",
    DEFAULT_RESPONSES_MODEL: "gpt-5.4",
    normalizePromptTemplateParams,
    getRatioOption: (value) => aspectRatios.find((option) => option.value === value) || aspectRatios[0],
    getSelectedGenerationSize: () => "auto",
    resolveGenerationSizeForSelectedRoute: (ratioOption, sizeSetting) =>
      sizeSetting === "auto" ? ratioOption.baseSize : sizeSetting,
    getPromptImageBackground: () => "opaque",
    getSelectedImageRoute: () => "b",
    getSelectedImageQuality: () => "high",
    normalizeOutputFormat: (value) => value || "png",
    getSelectedImageToolModel: () => "gpt-image-2",
    getSelectedImageReasoningEffort: () => "low",
    buildGenerationTaskStatusText: () => "queued",
    getGenerationReferenceFile: (item) => item.file,
    nowIso: () => "2026-11-18T00:00:00.000Z",
    buildPromptModePrompt: () => "",
    ...(overrides.globals || {}),
  };
  runInNewContext(
    `${suffixFn}\n${body}\n;globalThis.__createJob = createJob;`,
    context,
  );
  return { createJob: context.__createJob, context };
}

test("createJob keeps the prompt and template metadata a prompt set hands it", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const { createJob } = loadRealCreateJob(source);

  const job = createJob({
    prompt: "Main image\n\nTitle block",
    params: { ratio: "3:4", size: "1536x2048", format: "jpg", reasoningEffort: "high" },
    promptTemplateId: "template-main",
    promptTemplateName: "主图提示词",
    promptSetId: "set-a",
    promptSetName: "套图 4.0",
  });

  // The prompt the caller supplied must survive: dropping it is what produced the
  // empty submission behind #16.
  assert.equal(job.prompt, "Main image\n\nTitle block");
  assert.equal(job.promptTemplateId, "template-main");
  assert.equal(job.promptTemplateName, "主图提示词");
  assert.equal(job.promptSetId, "set-a");
  assert.equal(job.promptSetName, "套图 4.0");
  // Template parameters must reach the job, not be silently replaced by the form's.
  assert.equal(job.ratio, "3:4");
  assert.equal(job.size, "1536x2048");
  assert.equal(job.format, "jpg");
  assert.equal(job.reasoningEffort, "high");
});

test("createJob without a prompt still falls back to the studio prompt input", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const { createJob, context } = loadRealCreateJob(source, {
    globals: { buildPromptModePrompt: () => "typed prompt" },
  });

  const job = createJob();

  // Single-shot generation keeps behaving exactly as before #16 was fixed.
  assert.equal(job.prompt, "typed prompt");
  assert.equal(job.ratio, "1:1");
  assert.equal(job.promptSetId, undefined);
  assert.equal(context.refs.promptInput.value, "");
});

test("createJob still applies prompt enhancement to a prompt set's prompt", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  // Fork parity: the pre-rewrite createJob pushed the supplied prompt through
  // buildEnhancedPrompt, so 套图 images picked up the enhancement text too. The
  // v0.2.116 rewrite inlined enhancement into buildPromptModePrompt only, so the
  // restored signature has to re-apply it or 套图 silently loses the toggle.
  const { createJob } = loadRealCreateJob(source, {
    state: { promptEnhanceEnabled: true },
    refs: { promptEnhanceInput: { value: "sharp focus, macro details" } },
  });

  const job = createJob({ prompt: "Main image" });

  assert.equal(job.prompt, "Main image\n\nsharp focus, macro details");
});
