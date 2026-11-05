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

test("mixed prompt set applies title analysis per template on every submission", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("async function startPromptSetGeneration("), source.indexOf("async function startGeneration("));
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
