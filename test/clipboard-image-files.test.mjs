import assert from "node:assert/strict";
import test from "node:test";

import { prepareClipboardImageFiles, snapshotClipboardImageFile } from "../lib/clipboard-image-files.mjs";

test("clipboard images are detached into stable file snapshots before preview", async () => {
  const source = new File([new Uint8Array([1, 2, 3, 4])], "clipboard.png", {
    type: "image/png",
    lastModified: 123,
  });
  let decodedFile = null;

  const snapshot = await snapshotClipboardImageFile(source, {
    decodeImageFile: async (file) => {
      decodedFile = file;
    },
  });

  assert.notEqual(snapshot, source);
  assert.equal(snapshot.name, "clipboard.png");
  assert.equal(snapshot.type, "image/png");
  assert.equal(snapshot.lastModified, 123);
  assert.deepEqual(new Uint8Array(await snapshot.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  assert.equal(decodedFile, snapshot);
});

test("clipboard preparation rejects empty or undecodable images without losing valid images", async () => {
  const valid = new File([new Uint8Array([1])], "valid.png", { type: "image/png" });
  const empty = new File([], "empty.png", { type: "image/png" });
  const corrupt = new File([new Uint8Array([2])], "corrupt.png", { type: "image/png" });

  const result = await prepareClipboardImageFiles([valid, empty, corrupt], {
    decodeImageFile: async (file) => {
      if (file.name === "corrupt.png") {
        throw new Error("decode failed");
      }
    },
  });

  assert.deepEqual(result.acceptedFiles.map((file) => file.name), ["valid.png"]);
  assert.deepEqual(result.rejectedFiles.map((item) => item.file.name), ["empty.png", "corrupt.png"]);
  assert.match(result.rejectedFiles[0].message, /内容为空/);
  assert.equal(result.rejectedFiles[1].message, "decode failed");
});

test("clipboard image decoding retries once for transient browser failures", async () => {
  const source = new File([new Uint8Array([1])], "retry.png", { type: "image/png" });
  let attempts = 0;

  const snapshot = await snapshotClipboardImageFile(source, {
    decodeImageFile: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary decode failure");
      }
    },
  });

  assert.equal(snapshot.name, "retry.png");
  assert.equal(attempts, 2);
});
