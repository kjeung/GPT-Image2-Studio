import test from "node:test";
import assert from "node:assert/strict";

import {
  GALLERY_UNKNOWN_TOTAL_LABEL,
  mergeGalleryWindowItems,
  resolveGalleryLoadMoreState,
  resolveNextGalleryRenderLimit,
  shouldFetchMoreGalleryFromServer,
} from "../lib/gallery-window.mjs";

test("gallery window shows load-more while unpainted items remain", () => {
  const state = resolveGalleryLoadMoreState({
    renderWindow: { totalCount: 3000, visibleCount: 10 },
    hasMoreOnServer: true,
  });

  assert.equal(state.shouldShow, true);
  assert.equal(state.hiddenCount, 2990);
  // Local items exist, so the click must not touch the disk.
  assert.equal(state.needsServerPage, false);
  assert.equal(state.buttonText, "加载更多（10 张）");
  // The archive size is unknown while the server still holds unsent items.
  assert.equal(state.totalCount, GALLERY_UNKNOWN_TOTAL_LABEL);
  assert.equal(state.statusText, `已显示 10 / ${GALLERY_UNKNOWN_TOTAL_LABEL} 张`);
});

test("gallery window asks the server only once known items are all painted", () => {
  const state = resolveGalleryLoadMoreState({
    renderWindow: { totalCount: 10, visibleCount: 10 },
    hasMoreOnServer: true,
  });

  assert.equal(state.shouldShow, true);
  assert.equal(state.needsServerPage, true);
  assert.equal(state.buttonText, "加载更多（读取磁盘）");
});

test("gallery window hides the control when the whole archive fits", () => {
  const state = resolveGalleryLoadMoreState({
    renderWindow: { totalCount: 3, visibleCount: 3 },
    hasMoreOnServer: false,
  });

  assert.equal(state.shouldShow, false);
  assert.equal(state.statusText, "");
  assert.equal(state.totalCount, "3");
});

test("gallery window disables the control while a page is loading", () => {
  const state = resolveGalleryLoadMoreState({
    renderWindow: { totalCount: 30, visibleCount: 10 },
    hasMoreOnServer: true,
    loading: true,
  });

  assert.equal(state.disabled, true);
});

test("gallery window next limit always grows and never shrinks below known items", () => {
  assert.equal(resolveNextGalleryRenderLimit({ renderLimit: 10, knownCount: 0 }), 20);
  assert.equal(resolveNextGalleryRenderLimit({ renderLimit: 10, knownCount: 45 }), 45);
  assert.equal(resolveNextGalleryRenderLimit({ renderLimit: 20, knownCount: 0 }), 30);
  // An invalid render limit falls back to the default before growing.
  assert.equal(resolveNextGalleryRenderLimit({ renderLimit: 0, knownCount: 0 }), 20);
});

test("gallery window decides server fetches from the render window, not raw counts", () => {
  assert.equal(
    shouldFetchMoreGalleryFromServer({
      renderWindow: { totalCount: 10, visibleCount: 10 },
      hasMoreOnServer: true,
    }),
    true,
  );
  assert.equal(
    shouldFetchMoreGalleryFromServer({
      renderWindow: { totalCount: 40, visibleCount: 10 },
      hasMoreOnServer: true,
    }),
    false,
  );
  assert.equal(
    shouldFetchMoreGalleryFromServer({
      renderWindow: { totalCount: 10, visibleCount: 10 },
      hasMoreOnServer: false,
    }),
    false,
  );
});

test("gallery window merge dedupes by filename and keeps newest-first order", () => {
  const existing = [
    { filename: "a.png", createdAt: "2026-04-26T10:00:00.000Z", prompt: "old a" },
    { filename: "b.png", createdAt: "2026-04-26T09:00:00.000Z", prompt: "b" },
  ];
  const incoming = [
    { filename: "c.png", createdAt: "2026-04-26T11:00:00.000Z", prompt: "c" },
    { filename: "a.png", createdAt: "2026-04-26T10:00:00.000Z", prompt: "new a" },
  ];

  const merged = mergeGalleryWindowItems(existing, incoming);

  assert.deepEqual(
    merged.map((item) => item.filename),
    ["c.png", "a.png", "b.png"],
  );
  // A re-sent item updates its metadata instead of duplicating the tile.
  assert.equal(merged.find((item) => item.filename === "a.png").prompt, "new a");
});
