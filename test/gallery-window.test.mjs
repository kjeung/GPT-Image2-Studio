import test from "node:test";
import assert from "node:assert/strict";

import {
  applyGalleryRenderWindowToSections,
  resolveGalleryLoadMoreState,
  resolveNextGalleryRenderLimit,
} from "../lib/gallery-window.mjs";

function makeItems(count, { dayKey = "2026-04-26", startHour = 12 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    filename: `${dayKey}-${String(index).padStart(3, "0")}.png`,
    createdAt: `${dayKey}T${String(startHour).padStart(2, "0")}:${String((index % 60)).padStart(2, "0")}:00.000Z`,
  }));
}

function makeSection(key, count) {
  return {
    key,
    label: key,
    dateText: key,
    count,
    items: makeItems(count, { dayKey: key }),
  };
}

test("gallery load-more shows while the current date page still has unpainted items", () => {
  const state = resolveGalleryLoadMoreState({
    renderWindow: { totalCount: 800, visibleCount: 10 },
  });

  assert.equal(state.shouldShow, true);
  assert.equal(state.hiddenCount, 790);
  assert.equal(state.pageCount, 800);
  assert.equal(state.pageIsDrawnOut, false);
  // Another date page exists, but this page is still half-painted: widening is
  // the next step, so turning the page is locked rather than offered beside it.
  assert.equal(state.pageTurnBlocked, true);
  assert.equal(state.buttonText, "加载更多（10 张）");
  // The archive size is known now that the whole library is loaded, so the
  // status line states exact numbers instead of an ellipsis placeholder.
  assert.equal(state.statusText, "已显示 10 / 800 张，画完本页后可翻页");
});

test("gallery forward actions are ordered, never offered at the same time", () => {
  // Busy page followed by more dates: only "load more" is a live forward action.
  const partlyPainted = resolveGalleryLoadMoreState({
    renderWindow: { totalCount: 800, visibleCount: 10 },
    hasNextHistoryPage: true,
  });
  assert.equal(partlyPainted.shouldShow, true);
  assert.equal(partlyPainted.pageTurnBlocked, true);

  // Page fully painted: the load-more control is gone and pagination is free.
  const drawnOut = resolveGalleryLoadMoreState({
    renderWindow: { totalCount: 10, visibleCount: 10 },
    hasNextHistoryPage: true,
  });
  assert.equal(drawnOut.shouldShow, false);
  assert.equal(drawnOut.pageTurnBlocked, false);
  assert.equal(drawnOut.pageIsDrawnOut, true);

  // They are never both active: the pair (show load-more, allow page turn)
  // must not be (true, true).
  for (const state of [partlyPainted, drawnOut]) {
    assert.equal(state.shouldShow && !state.pageTurnBlocked, false);
  }
});

test("gallery load-more steps aside once the whole date page is painted", () => {
  const state = resolveGalleryLoadMoreState({
    renderWindow: { totalCount: 10, visibleCount: 10 },
    hasNextHistoryPage: true,
  });

  assert.equal(state.shouldShow, false);
  assert.equal(state.buttonText, "");
  assert.equal(state.pageIsDrawnOut, true);
  // Turning to the next date page is the pagination control's job.
  assert.equal(state.statusText, "本页日期已全部显示，可翻到下一页。");
});

test("gallery load-more stays silent when the page is drawn out and last", () => {
  const state = resolveGalleryLoadMoreState({
    renderWindow: { totalCount: 10, visibleCount: 10 },
    hasNextHistoryPage: false,
  });

  assert.equal(state.shouldShow, false);
  assert.equal(state.pageIsDrawnOut, false);
  assert.equal(state.statusText, "");
});

test("gallery load-more disables the control while a page is loading", () => {
  const state = resolveGalleryLoadMoreState({
    renderWindow: { totalCount: 30, visibleCount: 10 },
    loading: true,
  });

  assert.equal(state.disabled, true);
});

test("gallery window next limit always grows and never shrinks below known items", () => {
  assert.equal(resolveNextGalleryRenderLimit({ renderLimit: 10, paintedCount: 0 }), 20);
  assert.equal(resolveNextGalleryRenderLimit({ renderLimit: 10, paintedCount: 45 }), 45);
  assert.equal(resolveNextGalleryRenderLimit({ renderLimit: 20, paintedCount: 0 }), 30);
  // An invalid render limit falls back to the default before growing.
  assert.equal(resolveNextGalleryRenderLimit({ renderLimit: 0, paintedCount: 0 }), 20);
});

test("page-scoped window paints newest dates first and stops at the limit", () => {
  const pageSections = [makeSection("2026-04-26", 8), makeSection("2026-04-25", 9)];

  const renderWindow = applyGalleryRenderWindowToSections(pageSections, 10);

  assert.equal(renderWindow.totalCount, 17);
  assert.equal(renderWindow.visibleCount, 10);
  assert.equal(renderWindow.hiddenCount, 7);
  assert.equal(renderWindow.hasMore, true);
  // The newest date fills the window completely; the older date lends 2 tiles.
  assert.deepEqual(renderWindow.sections.map((section) => section.windowCount), [8, 2]);
  // Each section keeps its true day count so headers can say "2 / 9".
  assert.deepEqual(renderWindow.sections.map((section) => section.count), [8, 9]);
});

test("page-scoped window keeps every tile when the page fits inside it", () => {
  const pageSections = [makeSection("2026-04-26", 3), makeSection("2026-04-25", 2)];

  const renderWindow = applyGalleryRenderWindowToSections(pageSections, 10);

  assert.equal(renderWindow.visibleCount, 5);
  assert.equal(renderWindow.hiddenCount, 0);
  assert.equal(renderWindow.hasMore, false);
  assert.deepEqual(renderWindow.sections.map((section) => section.windowCount), [3, 2]);
});

test("page-scoped window drops sections that receive no budget", () => {
  const pageSections = [makeSection("2026-04-26", 12), makeSection("2026-04-25", 9)];

  const renderWindow = applyGalleryRenderWindowToSections(pageSections, 10);

  // The whole budget is consumed by the newest date, so the older date would
  // only add an empty header; it is dropped instead of painted as "0 / 9".
  assert.equal(renderWindow.sections.length, 1);
  assert.equal(renderWindow.sections[0].key, "2026-04-26");
  assert.equal(renderWindow.sections[0].windowCount, 10);
  assert.equal(renderWindow.hiddenCount, 11);
});

test("window and date axes stay orthogonal and never swallow loaded data", () => {
  // The regression this ticket exists to prevent: ten items spanning ten dates
  // used to be windowed first and then re-paginated by date, so the current
  // page painted five of the ten items it had already loaded.
  const tenDates = Array.from({ length: 10 }, (_, index) =>
    makeSection(`2026-04-${String(26 - index).padStart(2, "0")}`, 1),
  );

  // Date axis: ten dates at five per page yield two pages, every date intact.
  const firstPageSections = tenDates.slice(0, 5);
  const secondPageSections = tenDates.slice(5);

  // Quantity axis: each page's five items fit a ten-wide window untouched.
  const firstPageWindow = applyGalleryRenderWindowToSections(firstPageSections, 10);
  const secondPageWindow = applyGalleryRenderWindowToSections(secondPageSections, 10);

  assert.equal(firstPageWindow.visibleCount, 5);
  assert.equal(secondPageWindow.visibleCount, 5);
  // Every loaded item is painted: no second pass hides half of them.
  assert.equal(firstPageWindow.sections.length, 5);
  assert.equal(secondPageWindow.sections.length, 5);
  assert.equal(firstPageWindow.hasMore, false);
  assert.equal(secondPageWindow.hasMore, false);
});

test("a single day of 800 images paints at most one window and grows on demand", () => {
  const pageSections = [makeSection("2026-04-26", 800)];

  const firstPaint = applyGalleryRenderWindowToSections(pageSections, 10);
  assert.equal(firstPaint.sections[0].items.length, 10);
  // The header still reports the day's real size: ten painted of eight hundred.
  assert.equal(firstPaint.sections[0].count, 800);
  assert.equal(firstPaint.sections[0].windowCount, 10);

  const grown = applyGalleryRenderWindowToSections(
    pageSections,
    resolveNextGalleryRenderLimit({ renderLimit: 10, paintedCount: firstPaint.visibleCount }),
  );
  assert.equal(grown.sections[0].items.length, 20);
  assert.equal(grown.hiddenCount, 780);
});
