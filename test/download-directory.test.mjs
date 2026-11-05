import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  normalizeDownloadDirectory,
  sanitizeDownloadFilename,
  saveDownloadFile,
  validateDownloadDirectory,
} from "../lib/download-directory.mjs";

test("download directory validation accepts full paths and rejects relative paths", () => {
  const projectPath = resolve(process.cwd(), "output", "downloads");
  assert.equal(normalizeDownloadDirectory(`\"${projectPath}\"`), projectPath);
  assert.equal(validateDownloadDirectory(projectPath), projectPath);
  assert.equal(isAbsolute(validateDownloadDirectory(projectPath)), true);
  assert.throws(() => validateDownloadDirectory("downloads"), /绝对路径/);
});

test("download filenames remove traversal and Windows-invalid characters", () => {
  assert.equal(sanitizeDownloadFilename("../bad:name?.png"), "bad_name_.png");
  assert.equal(sanitizeDownloadFilename("CON.png"), "_CON.png");
  assert.equal(sanitizeDownloadFilename(""), "image.png");
});

test("saving downloads stays in the selected directory and never overwrites", async (t) => {
  const testRoot = join(process.cwd(), ".local-data", "download-directory-tests", randomUUID());
  const backToWorkspace = relative(resolve(process.cwd()), resolve(testRoot));
  assert.equal(backToWorkspace.startsWith(".."), false);
  t.after(async () => rm(testRoot, { recursive: true, force: true }));

  const first = await saveDownloadFile({
    directory: testRoot,
    filename: "result.png",
    data: new Uint8Array([1, 2, 3]),
  });
  const second = await saveDownloadFile({
    directory: testRoot,
    filename: "result.png",
    data: new Uint8Array([4, 5, 6]),
  });

  assert.equal(first.filename, "result.png");
  assert.equal(second.filename, "result (1).png");
  assert.deepEqual([...await readFile(first.absolutePath)], [1, 2, 3]);
  assert.deepEqual([...await readFile(second.absolutePath)], [4, 5, 6]);
});
