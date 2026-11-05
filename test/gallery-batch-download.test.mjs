import test from "node:test";
import assert from "node:assert/strict";

import { saveGalleryItemsIndividually } from "../lib/studio-enhancements.mjs";

test("saveGalleryItemsIndividually downloads each selected image separately", async () => {
  const downloaded = [];
  const items = [{ filename: "one.png" }, { filename: "two.png" }];

  const result = await saveGalleryItemsIndividually(items, {
    downloadItem: (item) => {
      downloaded.push(item.filename);
    },
  });

  assert.deepEqual(result, { saved: 2, failed: 0 });
  assert.deepEqual(downloaded, ["one.png", "two.png"]);
});

test("saveGalleryItemsIndividually counts unreadable images as failures", async () => {
  const items = [{ filename: "ok.png" }, { filename: "broken.png" }];

  const result = await saveGalleryItemsIndividually(items, {
    downloadItem: (item) => {
      if (item.filename === "broken.png") {
        throw new Error("cannot read");
      }
    },
  });

  assert.deepEqual(result, { saved: 1, failed: 1 });
});

test("saveGalleryItemsIndividually throws when nothing could be saved", async () => {
  await assert.rejects(
    saveGalleryItemsIndividually([{ filename: "broken.png" }], {
      downloadItem: () => {
        throw new Error("cannot read");
      },
    }),
    /所选图片都无法读取/,
  );
});

test("saveGalleryItemsIndividually tolerates a non-array input", async () => {
  await assert.rejects(
    saveGalleryItemsIndividually(null, { downloadItem: () => {} }),
    /所选图片都无法读取/,
  );
});
