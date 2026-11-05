// Pure decisions for the bounded gallery window.
//
// The gallery archives every generated image, so the view paints a small
// newest-first window and grows on demand. Everything that decides "what does
// the load-more control say / what limit do we ask for next" lives here so the
// shell code in public/app.js stays a thin DOM adapter and these rules stay
// unit-testable without a browser.

import {
  DEFAULT_GALLERY_RENDER_LIMIT,
  GALLERY_RENDER_LIMIT_STEP,
  normalizeGalleryRenderLimit,
} from "./gallery-organizer.mjs";

export const GALLERY_UNKNOWN_TOTAL_LABEL = "…";

function normalizeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

// Whether the control is visible, whether growing the window needs more disk
// reads, and the two pieces of copy it shows.
export function resolveGalleryLoadMoreState({
  renderWindow = {},
  hasMoreOnServer = false,
  loading = false,
  step = GALLERY_RENDER_LIMIT_STEP,
  unknownTotalLabel = GALLERY_UNKNOWN_TOTAL_LABEL,
} = {}) {
  const knownCount = normalizeCount(renderWindow.totalCount);
  const visibleCount = normalizeCount(renderWindow.visibleCount);
  const hiddenCount = Math.max(0, knownCount - visibleCount);
  const hasHiddenLocally = hiddenCount > 0;
  // Only reach for the server once every already-known item is painted; until
  // then growing the window is a pure client-side re-render.
  const needsServerPage = Boolean(hasMoreOnServer) && !hasHiddenLocally;
  const shouldShow = hasHiddenLocally || needsServerPage;
  // The client cannot state an exact archive size while the server still holds
  // items it has never sent.
  const totalCount = hasMoreOnServer ? unknownTotalLabel : String(knownCount);
  const resolvedStep = normalizeGalleryRenderLimit(step, GALLERY_RENDER_LIMIT_STEP);

  return {
    shouldShow,
    needsServerPage,
    visibleCount,
    hiddenCount,
    totalCount,
    buttonText: needsServerPage ? "加载更多（读取磁盘）" : `加载更多（${resolvedStep} 张）`,
    statusText: shouldShow ? `已显示 ${visibleCount} / ${totalCount} 张` : "",
    disabled: Boolean(loading),
  };
}

// Next window width. Always grows, so a repeated click cannot stall, and it
// never shrinks below what is already painted.
export function resolveNextGalleryRenderLimit({
  renderLimit,
  knownCount = 0,
  step = GALLERY_RENDER_LIMIT_STEP,
} = {}) {
  const current = normalizeGalleryRenderLimit(renderLimit, DEFAULT_GALLERY_RENDER_LIMIT);
  const resolvedStep = normalizeGalleryRenderLimit(step, GALLERY_RENDER_LIMIT_STEP);
  return Math.max(current + resolvedStep, current, normalizeCount(knownCount));
}

// Whether the click can be served from items already in memory.
export function shouldFetchMoreGalleryFromServer({
  renderWindow = {},
  hasMoreOnServer = false,
} = {}) {
  const knownCount = normalizeCount(renderWindow.totalCount);
  const visibleCount = normalizeCount(renderWindow.visibleCount);
  const hasHiddenLocally = knownCount > visibleCount;
  return !hasHiddenLocally && Boolean(hasMoreOnServer);
}

// Merge a newly fetched page into the items already held, dropping duplicates
// by filename and keeping newest-first order.
export function mergeGalleryWindowItems(existingItems = [], incomingItems = []) {
  const mergedByFilename = new Map();

  for (const item of Array.isArray(existingItems) ? existingItems : []) {
    const filename = String(item?.filename || "").trim();
    if (filename) {
      mergedByFilename.set(filename, item);
    }
  }

  for (const item of Array.isArray(incomingItems) ? incomingItems : []) {
    const filename = String(item?.filename || "").trim();
    if (!filename) {
      continue;
    }
    const current = mergedByFilename.get(filename);
    mergedByFilename.set(filename, current ? { ...current, ...item } : item);
  }

  return [...mergedByFilename.values()].sort((left, right) =>
    String(right?.createdAt || "").localeCompare(String(left?.createdAt || "")),
  );
}

// Deleting an item inside the window shrinks the painted tile count below the
// window width. The server may still hold unseen items, so the view must top
// itself back up — otherwise repeated deletes walk 10 → 9 → … → 0 while the
// archive is still full, and the gallery would claim to be empty.
export function shouldBackfillGalleryWindow({
  knownCount = 0,
  renderLimit = DEFAULT_GALLERY_RENDER_LIMIT,
  hasMoreOnServer = false,
} = {}) {
  const resolvedLimit = normalizeGalleryRenderLimit(renderLimit, DEFAULT_GALLERY_RENDER_LIMIT);
  const resolvedKnown = normalizeCount(knownCount);
  return Boolean(hasMoreOnServer) && resolvedKnown < resolvedLimit;
}

// How many newest items the next page must request to restore the window.
// `renderLimit + 1` is enough: it refills the deleted gap and the extra item
// tells us whether the archive continues past the restored window.
export function resolveBackfillGalleryLimit({
  renderLimit = DEFAULT_GALLERY_RENDER_LIMIT,
} = {}) {
  return normalizeGalleryRenderLimit(renderLimit, DEFAULT_GALLERY_RENDER_LIMIT) + 1;
}
