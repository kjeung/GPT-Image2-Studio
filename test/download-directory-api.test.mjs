import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function getFreePort() {
  const server = createTcpServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return address.port;
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode) {
    return;
  }
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    delay(1500).then(() => {
      if (server.exitCode === null && !server.signalCode) {
        server.kill("SIGKILL");
      }
    }),
  ]);
}

async function waitForServer(baseUrl, server) {
  const deadline = Date.now() + 7000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`server exited early (${server.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.status < 500) {
        await response.arrayBuffer();
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`server did not start: ${lastError?.message || "timeout"}`);
}

async function postJson(baseUrl, path, body = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

async function getConfig(baseUrl) {
  const response = await fetch(`${baseUrl}/api/config`);
  return { response, payload: await response.json() };
}

test("download directory saves, switches the output root, and drives image downloads", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "download-directory-api-"));
  const startupOutputDir = join(tempRoot, "startup-output");
  const chosenDir = join(tempRoot, "chosen-downloads");
  const localDataRootDir = join(tempRoot, "local-data");
  await mkdir(startupOutputDir, { recursive: true });

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      IMAGE_STUDIO_OUTPUT_DIR: startupOutputDir,
      IMAGE_STUDIO_LOCAL_DATA_DIR: localDataRootDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, server);

  // 1. 启动时没有配置下载目录：公开配置里应是空串，生效目录退回启动目录。
  const initial = await getConfig(baseUrl);
  assert.equal(initial.response.ok, true);
  assert.equal(initial.payload.downloadDirectory, "");
  assert.equal(initial.payload.effectiveOutputDirectory, startupOutputDir);

  // 2. 未配置目录时下载必须被明确拒绝，而不是静默写到别处。
  const body = new FormData();
  body.set("filename", "reject.png");
  body.set("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "reject.png");
  const rejected = await fetch(`${baseUrl}/api/download-image`, { method: "POST", body });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await readdir(startupOutputDir), []);

  // 3. 保存下载目录：应当被接受、落盘、并成为生效输出根目录。
  const saved = await postJson(baseUrl, "/api/download-directory/save", { directory: chosenDir });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.payload.ok, true);
  assert.equal(saved.payload.directory, chosenDir);
  assert.equal(saved.payload.effectiveOutputDirectory, chosenDir);

  const afterSave = await getConfig(baseUrl);
  assert.equal(afterSave.payload.downloadDirectory, chosenDir);
  assert.equal(afterSave.payload.effectiveOutputDirectory, chosenDir);

  // 4. 相对路径必须被拒绝（下载目录要求完整绝对路径）。
  const relative = await postJson(baseUrl, "/api/download-directory/save", { directory: "downloads" });
  assert.equal(relative.response.status, 400);
  assert.match(String(relative.payload.message), /绝对路径/);
  // 被拒绝的保存不能改动已生效的设置。
  const stillSaved = await getConfig(baseUrl);
  assert.equal(stillSaved.payload.downloadDirectory, chosenDir);

  // 5. 同一文件名下载两次：第二次自动加序号，绝不覆盖第一张。
  async function downloadPng(bytes, filename) {
    const form = new FormData();
    form.set("filename", filename);
    form.set("image", new Blob([new Uint8Array(bytes)], { type: "image/png" }), filename);
    const response = await fetch(`${baseUrl}/api/download-image`, { method: "POST", body: form });
    return { response, payload: await response.json().catch(() => ({})) };
  }

  const first = await downloadPng([1, 2, 3], "result.png");
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.ok, true);
  assert.equal(first.payload.filename, "result.png");
  assert.equal(first.payload.directory, chosenDir);
  assert.deepEqual([...await readFile(first.payload.absolutePath)], [1, 2, 3]);

  const second = await downloadPng([4, 5, 6], "result.png");
  assert.equal(second.response.status, 200);
  assert.equal(second.payload.filename, "result (1).png");
  assert.deepEqual([...await readFile(second.payload.absolutePath)], [4, 5, 6]);

  // 6. 非图片类型与超限类型必须被区分拒绝。
  const notImageForm = new FormData();
  notImageForm.set("filename", "notes.txt");
  notImageForm.set("image", new Blob(["hello"], { type: "text/plain" }), "notes.txt");
  const notImage = await fetch(`${baseUrl}/api/download-image`, { method: "POST", body: notImageForm });
  assert.equal(notImage.status, 415);

  // 7. 存档目录里只有那两张成功下载的图片，没有被拒绝的请求污染。
  const files = (await readdir(chosenDir)).sort();
  assert.deepEqual(files, ["result (1).png", "result.png"]);
});

test("clearing the download directory falls back to the startup output root", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "download-directory-clear-"));
  const startupOutputDir = join(tempRoot, "startup-output");
  const chosenDir = join(tempRoot, "chosen-downloads");
  const localDataRootDir = join(tempRoot, "local-data");
  await mkdir(startupOutputDir, { recursive: true });

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      IMAGE_STUDIO_OUTPUT_DIR: startupOutputDir,
      IMAGE_STUDIO_LOCAL_DATA_DIR: localDataRootDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, server);

  const saved = await postJson(baseUrl, "/api/download-directory/save", { directory: chosenDir });
  assert.equal(saved.response.status, 200);

  // 空字符串表示「清空设置」，应当退回启动目录而不是留在旧目录。
  const cleared = await postJson(baseUrl, "/api/download-directory/save", { directory: "" });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.payload.directory, "");
  assert.equal(cleared.payload.effectiveOutputDirectory, startupOutputDir);

  const config = await getConfig(baseUrl);
  assert.equal(config.payload.downloadDirectory, "");
  assert.equal(config.payload.effectiveOutputDirectory, startupOutputDir);

  // 目录清空后下载重新变成 409，而不是写进上一个目录。
  const form = new FormData();
  form.set("filename", "after-clear.png");
  form.set("image", new Blob([new Uint8Array([9])], { type: "image/png" }), "after-clear.png");
  const afterClear = await fetch(`${baseUrl}/api/download-image`, { method: "POST", body: form });
  assert.equal(afterClear.status, 409);

  // 没有配置目录时「打开目录」必须给出明确的 400 提示，而不是抛栈变 500。
  const openWithoutDirectory = await postJson(baseUrl, "/api/download-directory/open", {});
  assert.equal(openWithoutDirectory.response.status, 400);
  assert.match(String(openWithoutDirectory.payload.message), /请先设置/);
});
