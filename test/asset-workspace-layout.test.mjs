import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "parse5";

const indexPath = new URL("../public/index.html", import.meta.url);
const stylesPath = new URL("../public/styles.css", import.meta.url);
const appPath = new URL("../public/app.js", import.meta.url);
const controllerPath = new URL("../public/lib/asset-workspace.mjs", import.meta.url);
const deleteControllerPath = new URL("../public/lib/asset-record-delete-controller.mjs", import.meta.url);
const lightboxViewerPath = new URL("../public/lib/lightbox-image-viewer.mjs", import.meta.url);

test("five asset views expose the same compact navigation contract", async () => {
  const html = await readFile(indexPath, "utf8");
  assert.equal((html.match(/class="asset-view-nav" aria-label="资产视图"/g) || []).length, 5);
  for (const hash of ["gallery", "article-record", "creation-record", "portrait-record", "ppt-record"]) {
    assert.match(html, new RegExp(`href="#${hash}"`));
    assert.match(html, new RegExp(`href="#${hash}" aria-current="page"`));
  }
});

test("creation record heading omits the redundant asset eyebrow", async () => {
  const html = await readFile(indexPath, "utf8");
  const sectionStart = html.indexOf('<section class="view-panel creation-record-view');
  const sectionEnd = html.indexOf('<section class="view-panel portrait-record-view', sectionStart);
  const creationRecordSection = html.slice(sectionStart, sectionEnd);

  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
  assert.match(creationRecordSection, /<h2>套图记录 <span class="count-pill" id="creationRecordCount">0 套<\/span><\/h2>/);
  assert.doesNotMatch(creationRecordSection, /<span class="asset-eyebrow">资产<\/span>/);
});

test("asset workspace palette follows the creation theme tokens in both themes", async () => {
  const styles = await readFile(stylesPath, "utf8");
  const themeStart = styles.indexOf("/* Unified asset workspace */");
  const themeEnd = styles.indexOf(".asset-workspace,", themeStart);
  const assetTheme = styles.slice(themeStart, themeEnd);

  assert.ok(themeStart >= 0 && themeEnd > themeStart);
  for (const [assetToken, creationToken] of [
    ["asset-surface", "panel"],
    ["asset-surface-raised", "nav-tab-bg-hover"],
    ["asset-surface-soft", "panel-soft"],
    ["asset-border", "border"],
    ["asset-border-strong", "border-strong"],
    ["asset-selected", "active-tab-bg"],
    ["asset-selected-border", "accent"],
    ["asset-danger", "danger"],
  ]) {
    assert.match(assetTheme, new RegExp(`--${assetToken}:\\s*var\\(--${creationToken}\\);`));
  }
  assert.doesNotMatch(assetTheme, /#17191d|#202328|#1b1e22|#4a90e2|#0066cc/);
});

test("record commands are grouped and selection is exposed to assistive technology", async () => {
  const [html, app, controller] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(controllerPath, "utf8"),
  ]);
  assert.ok((html.match(/data-asset-menu/g) || []).length >= 3);
  assert.equal((html.match(/data-asset-record-picker/g) || []).length, 4);
  assert.match(app, /setAttribute\("role", "option"\)/);
  assert.match(app, /setAttribute\("aria-selected", String\(/);
  assert.match(controller, /aria-expanded/);
  assert.match(controller, /closeRecordPickers/);
  assert.match(controller, /closeCommandMenus/);
  assert.match(app, /if \(event\.key === "Escape"\)[\s\S]*details\[data-asset-menu\]\[open\]/);
});

test("all asset pages expose current and selected deletion without implicit filtered deletion", async () => {
  const [html, app, styles, deleteController] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(stylesPath, "utf8"),
    readFile(deleteControllerPath, "utf8"),
  ]);
  for (const prefix of ["gallery", "articleRecord", "portraitRecord", "pptRecord"]) {
    assert.match(html, new RegExp(`id="${prefix}DeleteCurrentButton"[^>]*>删除当前<\\/button>`));
    assert.match(html, new RegExp(`id="${prefix}DeleteSelectedButton"[^>]*>删除选中`));
    assert.doesNotMatch(html, new RegExp(`id="${prefix}DeleteFilteredButton"`));
  }
  assert.match(html, /id="assetRecordDeleteDialog"[^>]*aria-labelledby="assetRecordDeleteDialogTitle"/);
  assert.match(html, /id="assetRecordDeleteCancelButton"[^>]*>取消<\/button>/);
  assert.match(html, /id="assetRecordDeleteConfirmButton"[^>]*>确认删除<\/button>/);
  assert.match(app, /from "\/lib\/asset-record-delete-controller\.mjs\?v=/);
  assert.match(deleteController, /from "\.\/asset-record-delete\.mjs"/);
  assert.match(app, /data-gallery-select-filename/);
  assert.match(app, /data-article-record-select-set-id/);
  assert.match(app, /data-portrait-record-select-set-id/);
  assert.match(app, /data-ppt-record-select-key/);
  assert.match(deleteController, /fetch\("\/api\/article-illustration\/sets\/delete"/);
  assert.match(deleteController, /fetch\("\/api\/portrait\/sets\/delete"/);
  assert.match(deleteController, /fetch\("\/api\/ppt\/decks\/delete"/);
  assert.match(styles, /\.asset-record-select-row\s*\{/);
  assert.match(styles, /\.asset-record-select\s*\{/);
  assert.match(styles, /\.gallery-tile-select\s*\{/);
  assert.match(styles, /\.asset-record-delete-dialog\s*\{/);
});

test("waterfall gallery only renders image checkboxes in explicit checking mode", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  assert.equal((html.match(/id="gallerySelectionModeButton"/g) || []).length, 1);
  assert.match(html, /id="gallerySelectionModeButton"[^>]*aria-pressed="false"[^>]*>勾选图片<\/button>/);
  assert.match(app, /gallerySelectionMode:\s*false/);
  assert.match(app, /if \(state\.gallerySelectionMode\) \{ const selectLabel = document\.createElement\("label"\)/);
  assert.match(app, /refs\.galleryDeleteSelectedButton\.disabled = deleteBlocked \|\| !state\.gallerySelectionMode \|\| checkedCount === 0/);
  assert.match(app, /gallerySelectionModeButton\.setAttribute\("aria-pressed", String\(state\.gallerySelectionMode\)\)/);
  assert.match(app, /state\.gallerySelectionMode = !state\.gallerySelectionMode; renderGalleryView\(\)/);
  assert.match(styles, /\.gallery-selection-mode-button\[aria-pressed="true"\]\s*\{/);
  assert.match(styles, /\.gallery-selection-mode-button:focus-visible\s*\{/);
  assert.match(styles, /html\[data-ui-layout="mobile"\] \.gallery-tile-select\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
});

test("waterfall gallery paginates ordinary history by five dates without changing two-date density groups", async () => {
  const [html, app] = await Promise.all([readFile(indexPath, "utf8"), readFile(appPath, "utf8")]);
  assert.match(html, /class="gallery-column-switch hidden" id="galleryColumnSwitch"[^>]*aria-label="搜索结果列数"/);
  assert.match(app, /const shouldPaginateHistory = !filters\.query;/);
  assert.match(app, /\? paginateGallerySections\(allSections, state\.galleryHistoryPage\)\s*: getSearchGalleryPagination\(allSections\)/);
  assert.match(app, /shouldPaginateHistory && layoutMode === "desktop" \? getGalleryHistorySectionLayouts\(allSections\)/);
  assert.match(app, /layoutMode === "mobile" \? 2 : layoutMode === "tablet" \? 4 : getGalleryColumnCount\(\)/);
  assert.match(app, /galleryColumnSwitch\?\.classList\.toggle\("hidden", shouldPaginateHistory\)/);
  assert.match(app, /if \(changed && state\.activeView === "gallery" && !state\.galleryLoading\) renderGalleryView\(\)/);
  assert.match(app, /refs\.galleryView\.dataset\.galleryLayout = layoutMode;/);
  assert.match(app, /sectionLayouts\.forEach\(\(layout, index\) => \{[\s\S]*createGallerySection\(sections\[index\], layout\.columnCount\)/);
  assert.match(app, /每页显示 5 个日期[\s\S]*自动 \$\{layoutText\}，每 2 个日期最多 3 行[\s\S]*本页已画 \$\{displayedCount\} \/ \$\{visibleItems\.length\} 张/);
});

test("waterfall gallery paints a page-scoped window instead of chaining the two axes", async () => {
  const [html, app] = await Promise.all([readFile(indexPath, "utf8"), readFile(appPath, "utf8")]);
  // The quantity axis applies to the current date page, after pagination — not
  // before it. Chaining window-then-page is the bug this ordering prevents.
  assert.match(app, /const pagination = shouldPaginateHistory[\s\S]*?paginateGallerySections\(allSections, state\.galleryHistoryPage\)[\s\S]*?: getSearchGalleryPagination\(allSections\);/);
  assert.match(app, /const renderWindow = applyGalleryRenderWindowToSections\(pagination\.sections, state\.galleryRenderLimit\);/);
  assert.match(app, /const sections = renderWindow\.sections;/);
  assert.doesNotMatch(app, /paginateGalleryRenderWindow\(visibleItems/);
  // Layout density is still computed from the complete date groups, so a
  // "load more" click never changes tile sizes.
  assert.match(app, /getGalleryHistorySectionLayouts\(allSections\)/);
  // Growing the window is pure client work: no fetch, no disk.
  assert.match(app, /function loadMoreGalleryWindow\(\) {\n  if \(state\.galleryLoading\) {\n    return;/);
  assert.doesNotMatch(app, /\/api\/gallery\?limit=/);
  // The load-more control yields to pagination once the page is drawn out, and
  // pagination is locked while widening is still pending: the two forward
  // actions are ordered, never simultaneous.
  assert.match(html, /id="galleryLoadMoreButton"/);
  assert.match(app, /refs\.galleryNextPageButton\.disabled = !pagination\.hasNext \|\| pageTurnBlocked;/);
  assert.match(app, /renderGalleryPagination\(pagination, shouldPaginateHistory, loadMoreControl\.pageTurnBlocked\)/);
  assert.match(app, /refs\.galleryLoadMoreButton\?\.addEventListener\("click", \(\) => {\n    loadMoreGalleryWindow\(\);\n  }\);/);
  // A date page's header reports both the painted share and the day's true size.
  assert.match(app, /`\$\{paintedCount\} \/ \$\{section\.count\} 张`/);
  // Switching date pages restarts the window at its default width.
  assert.match(app, /function setGalleryHistoryPage\(page\) {\n  state\.galleryHistoryPage = Math\.max\(0, Number\(page\) \|\| 0\);\n  state\.galleryRenderLimit = DEFAULT_GALLERY_RENDER_LIMIT;/);
});

test("asset empty states distinguish no data, no results, loading, and failure", async () => {
  const [html, app] = await Promise.all([readFile(indexPath, "utf8"), readFile(appPath, "utf8")]);
  assert.match(html, /<strong>暂无图片<\/strong>[\s\S]*前往提示词生图/);
  assert.match(html, /<strong>暂无 PPT<\/strong>[\s\S]*前往 PPT 生成/);
  assert.match(app, /正在加载图片/);
  assert.match(app, /画廊加载失败/);
  assert.match(app, /没有匹配的图片/);
  assert.match(app, /assetLoadErrors/);
});

test("mobile assets avoid horizontal record rails and preserve allowed horizontal navigation", async () => {
  const styles = await readFile(stylesPath, "utf8");
  assert.match(styles, /html\[data-ui-layout="mobile"\] \.asset-record-picker\.is-open :is\([\s\S]*overflow-x:\s*hidden;[\s\S]*overflow-y:\s*auto;/);
  assert.match(styles, /html\[data-ui-layout="mobile"\] \.article-record-image-grid,[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(styles, /\.asset-view-nav\s*\{[\s\S]*overflow-x:\s*auto;/);
  assert.match(styles, /html\[data-ui-layout="mobile"\] \.ppt-record-slide-strip\s*\{[\s\S]*overflow-x:\s*auto;/);
});

test("lightbox prioritizes the image and exposes concise accessible controls", async () => {
  const [html, styles, app, controller, lightboxViewer] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(stylesPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(controllerPath, "utf8"),
    readFile(lightboxViewerPath, "utf8"),
  ]);
  assert.match(html, /aria-label="缩小图片" title="缩小图片"/);
  assert.match(html, /<div class="lightbox-meta">\s*<button class="toolbar-button lightbox-back-button" id="lightboxClose"[^>]*aria-label="返回图片列表"[^>]*>[\s\S]*?←[\s\S]*?返回[\s\S]*?<\/button>\s*<strong id="lightboxTitle"/);
  assert.doesNotMatch(html, /id="lightboxDownload"[\s\S]{0,300}id="lightboxClose"/);
  assert.match(html, /data-lightbox-tab="prompt"[\s\S]*data-lightbox-tab="params"/);
  assert.doesNotMatch(html, /data-lightbox-tab="file"|data-lightbox-panel="file"/);
  assert.match(html, /data-lightbox-tab="prompt">提示词<\/button>[\s\S]*data-lightbox-tab="params">参数<\/button>[\s\S]*data-lightbox-panel="prompt"[\s\S]*data-lightbox-panel="params"[\s\S]*lightbox-file-list/);
  assert.match(html, /aria-selected="false" data-lightbox-tab="prompt"[\s\S]*aria-selected="true" data-lightbox-tab="params"/);
  assert.match(html, /class="detail-field hidden" role="tabpanel" data-lightbox-panel="prompt"[\s\S]*class="detail-field lightbox-params-field" role="tabpanel" data-lightbox-panel="params"/);
  assert.doesNotMatch(html, /lightboxInspectorToggle|lightbox-more-menu|lightbox-inspector-head/);
  assert.match(styles, /\.lightbox-fields,[\s\S]*\.lightbox-media-stage\.is-viewer-inspecting \.lightbox-fields\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/);
  assert.match(styles, /\.lightbox-media-stage,[\s\S]*\.lightbox-media-stage\.is-viewer-inspecting\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(280px,\s*340px\);/);
  assert.match(styles, /\.lightbox-actions > \.toolbar-button\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*1;/);
  assert.match(styles, /\.lightbox-back-button\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;/);
  assert.match(styles, /\.lightbox :is\(\.toolbar-button, \.lightbox-inspector-tabs > button\):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--asset-selected-border\);[^}]*outline-offset:\s*2px;/);
  assert.match(styles, /html\[data-ui-layout="mobile"\] \.lightbox-media-stage,[\s\S]*grid-template-rows:\s*52dvh auto;/);
  assert.match(styles, /html\[data-ui-layout="mobile"\] \.lightbox-image-shell,[\s\S]*height:\s*100%;/);
  assert.match(styles, /html\[data-ui-layout="tablet"\] \.lightbox-media-stage,[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*grid-template-rows:\s*minmax\(52dvh,\s*1fr\) minmax\(0,\s*40dvh\);/);
  assert.match(styles, /html\[data-ui-layout="tablet"\] \.lightbox-image-shell,[\s\S]*grid-column:\s*1;[^}]*grid-row:\s*1;/);
  assert.match(styles, /html\[data-ui-layout="tablet"\] \.lightbox-fields,[\s\S]*grid-column:\s*1;[^}]*grid-row:\s*2;[^}]*overflow:\s*hidden;/);
  assert.match(styles, /html\[data-ui-layout="tablet"\] #lightboxInspectorBody,[\s\S]*overflow:\s*auto;[^}]*overscroll-behavior:\s*contain;/);
  assert.match(styles, /html\[data-ui-layout="mobile"\] \.lightbox-fields,[\s\S]*grid-column:\s*1;[^}]*grid-row:\s*2;/);
  assert.match(styles, /html\[data-ui-layout="mobile"\] #lightboxInspectorBody,[\s\S]*overflow:\s*auto;[^}]*overscroll-behavior:\s*contain;/);
  assert.match(styles, /\.lightbox-prompt-field dd,[\s\S]*\.lightbox-file-list dd\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(styles, /\.lightbox-dialog\s*\{[\s\S]*width:\s*min\(1440px,\s*calc\(100vw\s*-\s*32px\)\);[\s\S]*height:\s*min\(92dvh,\s*940px\);[\s\S]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\);/);
  assert.match(styles, /\.lightbox-media-stage,[\s\S]*height:\s*auto;/);
  assert.match(styles, /\.lightbox-prompt-field dd,[\s\S]*white-space:\s*pre-line;/);
  assert.match(app, /button\.setAttribute\("aria-label", `查看图片 \$\{filename\}`\)/);
  assert.match(app, /setImageRevealSource\(refs\.lightboxImage, imageUrl, \{\s*alt: fresh\.filename \? `图片详情 \$\{fresh\.filename\}` : "生成图片详情",/);
  assert.match(controller, /JSON\.parse\(source\)/);
  assert.match(controller, /export function getStructuredPromptFields\(value, path = ""\)/);
  assert.match(controller, /Array\.isArray\(value\)[\s\S]*return formatted \? \[\{ label: path \|\| "内容", value: formatted \}\] : \[\];/);
  assert.match(lightboxViewer, /new ResizeObserver\(\(\) => \{[\s\S]*syncMetrics\(\{ preserveMode: true \}\);[\s\S]*resizeObserver\.observe\(refs\.lightboxImageShell\);/);
  assert.doesNotMatch(lightboxViewer, /syncCompactStageHeight|--lightbox-media-height|preferredHeight/);
});

test("gallery toolbar markup parses cleanly with unique ids", async () => {
  // A string-level assertion cannot catch a mangled edit that leaves an orphan
  // </div>, a duplicated control, or a subtree hoisted out of the view. Parse the
  // document and check the structure the shell actually relies on.
  const html = await readFile(indexPath, "utf8");
  const document = parse(html);

  const ids = new Map();
  const duplicates = [];
  const galleryControls = [];
  let galleryViewNode = null;

  function walk(node, ancestors) {
    const attributes = new Map((node.attrs || []).map((attribute) => [attribute.name, attribute.value]));
    if (attributes.has("id")) {
      const id = attributes.get("id");
      if (ids.has(id)) {
        duplicates.push(id);
      } else {
        ids.set(id, true);
      }
      for (const controlId of ["galleryLoadMoreButton", "galleryLoadMoreStatus", "galleryNextPageButton", "galleryPagination"]) {
        if (id === controlId) {
          galleryControls.push({ id, ancestors });
        }
      }
    }
    if (attributes.get("class")?.split(/\s+/).includes("gallery-view")) {
      galleryViewNode = galleryViewNode || ids.get("galleryViewProbe");
    }
    for (const child of node.childNodes || []) {
      walk(child, [...ancestors, node]);
    }
  }

  walk(document, []);

  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(", ")}`);

  // Each forward control must live inside one single toolbar element, so the
  // shell can hide it without hiding the other.
  for (const controlId of ["galleryLoadMoreButton", "galleryNextPageButton"]) {
    const entry = galleryControls.find((candidate) => candidate.id === controlId);
    assert.equal(entry.ancestors.length > 0, true, `${controlId} must have a parent`);
  }
});

test("gallery scroll surface stays inside the gallery view panel", async () => {
  const html = await readFile(indexPath, "utf8");
  const document = parse(html);

  function findById(node, id) {
    if ((node.attrs || []).some((attribute) => attribute.name === "id" && attribute.value === id)) {
      return node;
    }
    for (const child of node.childNodes || []) {
      const found = findById(child, id);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function hasGalleryViewAncestor(root, target, ancestors = []) {
    if (root === target) {
      return ancestors.some((node) => String(node.attrs?.find((attribute) => attribute.name === "class")?.value || "").split(/\s+/).includes("gallery-view"));
    }
    return (root.childNodes || []).some((child) => hasGalleryViewAncestor(child, target, [...ancestors, root]));
  }

  const sections = findById(document, "gallerySections");
  assert.ok(sections, "#gallerySections must exist");
  assert.equal(
    hasGalleryViewAncestor(document, sections),
    true,
    "#gallerySections must stay inside .gallery-view, otherwise leaving the gallery no longer hides it",
  );
});
