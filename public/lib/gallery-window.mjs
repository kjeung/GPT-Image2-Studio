// Pure decisions for the page-scoped gallery render window.
//
// The gallery has two orthogonal axes:
//
//   1. the date axis (upstream): `buildGallerySections` groups by day and
//      `paginateGallerySections` shows five days per page;
//   2. the quantity axis (this module): the window bounds how many tiles the
//      *current date page* paints.
//
// They are orthogonal, never chained: a date page decides which days are on
// screen, the window decides how many of that page's tiles are painted. Chaining
// them was the bug this module replaces — a 10-tile window sliced first, then
// paginated by date, hid half of the items it had just loaded.
//
// Everything that decides "what does the load-more control say / what window
// width comes next" lives here so public/app.js stays a thin DOM adapter and
// these rules stay unit-testable without a browser.

import {
  DEFAULT_GALLERY_RENDER_LIMIT,
  GALLERY_RENDER_LIMIT_STEP,
  normalizeGalleryRenderLimit,
} from "./gallery-organizer.mjs";

function normalizeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

// The two forward actions are ordered, never simultaneous: first widen the
// window inside the current date page, then turn the page. So while any item on
// the current page is still unpainted, "load more" is the only forward action
// offered and pagination is locked; once the page is fully painted, pagination
// takes over and this control disappears. Offering both at once would leave the
// user guessing which one moves them forward.
export function resolveGalleryLoadMoreState({
  renderWindow = {},
  hasNextHistoryPage = false,
  loading = false,
  step = GALLERY_RENDER_LIMIT_STEP,
} = {}) {
  // `totalCount` is the current date page's item count, not the archive's: the
  // window is page-scoped, so "10 / 800" means ten of this page's eight hundred.
  const pageCount = normalizeCount(renderWindow.totalCount);
  const visibleCount = normalizeCount(renderWindow.visibleCount);
  const hiddenCount = Math.max(0, pageCount - visibleCount);
  const shouldShow = hiddenCount > 0;
  // Pagination is only reachable after the current page is fully painted.
  const pageTurnBlocked = shouldShow;
  const pageIsDrawnOut = !shouldShow && Boolean(hasNextHistoryPage);
  const resolvedStep = normalizeGalleryRenderLimit(step, GALLERY_RENDER_LIMIT_STEP);

  return {
    shouldShow,
    visibleCount,
    hiddenCount,
    pageCount,
    pageIsDrawnOut,
    pageTurnBlocked,
    buttonText: shouldShow ? `加载更多（${resolvedStep} 张）` : "",
    statusText: shouldShow
      ? `已显示 ${visibleCount} / ${pageCount} 张，画完本页后可翻页`
      : pageIsDrawnOut
        ? "本页日期已全部显示，可翻到下一页。"
        : "",
    disabled: Boolean(loading),
  };
}

/* 把页内窗口套到**当前日期页**的 sections 上：按日期从新到旧依次发放预算，
   发完就停。返回的 section 保留该日期的完整条数（`count`）与被画出的条数
   （`windowCount`），这样表头能诚实地说「10 / 800」，而不是把 800 张说成 10 张。
   本页所有日期都画尽时 `hasMore` 为 false，控制权交回翻页按钮。 */
export function applyGalleryRenderWindowToSections(
  pageSections = [],
  limit = DEFAULT_GALLERY_RENDER_LIMIT,
) {
  const sourceSections = Array.isArray(pageSections) ? pageSections : [];
  const resolvedLimit = Math.max(0, normalizeGalleryRenderLimit(limit));
  let remaining = resolvedLimit;
  const sections = [];
  let totalCount = 0;

  for (const section of sourceSections) {
    const items = Array.isArray(section?.items) ? section.items : [];
    totalCount += items.length;
    if (remaining <= 0) {
      continue;
    }
    const paintedItems = items.slice(0, remaining);
    remaining -= paintedItems.length;
    sections.push({
      ...section,
      count: items.length,
      windowCount: paintedItems.length,
      items: paintedItems,
    });
  }

  const visibleCount = sections.reduce((total, section) => total + section.windowCount, 0);
  const hiddenCount = Math.max(0, totalCount - visibleCount);

  return {
    sections,
    totalCount,
    visibleCount,
    hiddenCount,
    hasMore: hiddenCount > 0,
    nextLimit: resolvedLimit + GALLERY_RENDER_LIMIT_STEP,
  };
}

// Next window width. Always grows by one step, so a repeated click cannot stall,
// and it never shrinks below what is already painted. `paintedCount` is the tile
// count currently on screen — not the page total: clamping to the page total
// would jump 10 straight to 800 on a busy day and defeat the whole window.
export function resolveNextGalleryRenderLimit({
  renderLimit,
  paintedCount = 0,
  step = GALLERY_RENDER_LIMIT_STEP,
} = {}) {
  const current = normalizeGalleryRenderLimit(renderLimit, DEFAULT_GALLERY_RENDER_LIMIT);
  const resolvedStep = normalizeGalleryRenderLimit(step, GALLERY_RENDER_LIMIT_STEP);
  return Math.max(current + resolvedStep, current, normalizeCount(paintedCount));
}
