import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTitleAwarePrompt,
  normalizePromptSet,
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

test("title analysis uses each generation's current title and stays optional", () => {
  const first = buildTitleAwarePrompt("main image", "Title A", true);
  const next = buildTitleAwarePrompt("main image", "Title B", true);
  assert.match(first, /Title A/);
  assert.match(next, /Title B/);
  assert.ok(!next.includes("Title A"));
  assert.equal(buildTitleAwarePrompt("main image", "Title B", false), "main image");
  assert.throws(() => buildTitleAwarePrompt("main image", "  ", true));

});

// Ticket constraint: these two top-level entry points must survive the v0.2.116
// app.js rewrite, so the slice below stays addressable.
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

test("mixed prompt set applies title analysis per template on every submission", async () => {
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
    { id: "main", prompt: "Main image", analyzeTitle: true },
    { id: "detail", prompt: "Detail image", analyzeTitle: false },
  ];
  const set = { id: "set", templateIds: ["main", "detail"], analyzeTitle: true };
  const state = { promptSets: [set], promptTemplates: templates, jobs: [] };
  const refs = { productTitleInput: { value: "Title A" }, promptSetNameInput: { value: "Set" } };
  const context = {
    state, refs, buildTitleAwarePrompt, resolvePromptSetTemplates,
    getSelectedPromptSet: () => set, getPromptSetDraftTemplates: () => templates,
    createJob: (job) => job, makeJobPreviewKey: () => "preview",
    ensureReferenceGenerationFilesReady: async () => {},
  };
  for (const name of ["clearError", "setPromptSetFeedback", "showError", "renderPromptSets", "recordJobQueued", "setPromptTemplatePopoverOpen", "setActiveView", "renderAll", "scheduleGenerationQueue"]) context[name] = () => {};
  runInNewContext(fn, context);
  for (const setId of ["set", ""]) {
    state.jobs = [];
    await context.startPromptSetGeneration(setId);
    assert.match(state.jobs[0].prompt, /Title A/);
    assert.equal(state.jobs[1].prompt, "Detail image");
  }
  refs.productTitleInput.value = "Title B";
  await context.startPromptSetGeneration("set");
  assert.match(state.jobs[0].prompt, /Title B/);
  assert.ok(!state.jobs[0].prompt.includes("Title A"));
  assert.equal(state.jobs[1].prompt, "Detail image");
  state.jobs = [];
  refs.productTitleInput.value = "  ";
  await context.startPromptSetGeneration("set");
  assert.equal(state.jobs.length, 0);
});
