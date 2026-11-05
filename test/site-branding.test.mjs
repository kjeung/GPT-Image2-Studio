import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_SITE_BRAND,
  DEFAULT_SITE_FAVICON_URL,
  MAX_SITE_LOGO_BYTES,
  SITE_BRAND_FAVICON_LINK_SELECTOR,
  SITE_BRAND_STORAGE_KEY,
  applySiteBrandFavicon,
  createSiteBrandConfigPayload,
  createSiteBrandingController,
  createSiteBrandPersistence,
  getSiteBrandFaviconHref,
  normalizeSiteBrand,
  resolveSiteBrandDocumentAppName,
  validateSiteLogoFile,
} from "../lib/site-branding.mjs";

function createMemoryStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set(SITE_BRAND_STORAGE_KEY, JSON.stringify(initialValue));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function createFaviconLink(href, type = "") {
  const attributes = new Map([["href", href]]);
  if (type) attributes.set("type", type);
  return {
    dataset: {},
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    readAttribute(name) { return attributes.get(name) ?? null; },
  };
}

function createFaviconDocument(links) {
  return {
    title: "",
    body: { classList: { toggle() {} } },
    querySelectorAll(selector) {
      return selector === SITE_BRAND_FAVICON_LINK_SELECTOR ? links : [];
    },
  };
}

test("site brand settings are normalized into safe editable bounds", () => {
  assert.deepEqual(normalizeSiteBrand({
    name: "  My   Studio  ",
    tagline: "  专属 创作 工作台  ",
    imageDataUrl: "javascript:alert(1)",
    size: 99,
    radius: -2,
    fit: "cover",
    background: "light",
  }), {
    name: "My Studio",
    tagline: "专属 创作 工作台",
    imageDataUrl: "",
    imageName: "",
    size: 64,
    radius: 0,
    fit: "cover",
    background: "light",
  });
});

test("site brand falls back to the default identity", () => {
  assert.equal(normalizeSiteBrand(null).name, DEFAULT_SITE_BRAND.name);
  assert.equal(normalizeSiteBrand({ name: "" }).tagline, DEFAULT_SITE_BRAND.tagline);
});

test("site logo validation accepts supported small images and rejects invalid uploads", () => {
  assert.equal(validateSiteLogoFile({ type: "image/png", size: 1024 }).type, "image/png");
  assert.throws(() => validateSiteLogoFile({ type: "text/plain", size: 20 }), /PNG/);
  assert.throws(() => validateSiteLogoFile({ type: "image/png", size: MAX_SITE_LOGO_BYTES + 1 }), /1\.5 MB/);
});

test("site brand lightweight config excludes image bytes and tracks a custom favicon", () => {
  const imageDataUrl = "data:image/png;base64,c21hbGw=";
  const payload = createSiteBrandConfigPayload({ imageDataUrl, imageName: "mark.png" });
  assert.equal(payload.hasCustomLogo, true);
  assert.equal("imageDataUrl" in payload, false);
  assert.equal(getSiteBrandFaviconHref({ imageDataUrl }), imageDataUrl);
  assert.equal(getSiteBrandFaviconHref({}), DEFAULT_SITE_FAVICON_URL);
});

test("site brand persistence stores image bytes outside localStorage and restores them", async () => {
  const storage = createMemoryStorage();
  let savedLogo = null;
  const logoStore = {
    async load() { return savedLogo; },
    async save(value) { savedLogo = { imageDataUrl: value.imageDataUrl, imageName: value.imageName }; },
    async remove() { savedLogo = null; },
  };
  const persistence = createSiteBrandPersistence({ storage, logoStore });
  const imageDataUrl = "data:image/png;base64,cGVyc2lzdGVk";

  await persistence.save({ name: "My Brand", imageDataUrl, imageName: "logo.png" });
  const compactPayload = JSON.parse(storage.getItem(SITE_BRAND_STORAGE_KEY));
  assert.equal(compactPayload.hasCustomLogo, true);
  assert.equal(compactPayload.imageDataUrl, undefined);

  const restored = await persistence.load();
  assert.equal(restored.name, "My Brand");
  assert.equal(restored.imageDataUrl, imageDataUrl);
  assert.equal(restored.imageName, "logo.png");
});

test("site brand persistence migrates a legacy localStorage logo into the image store", async () => {
  const imageDataUrl = "data:image/svg+xml;base64,PHN2Zy8+";
  const storage = createMemoryStorage({ name: "Legacy", imageDataUrl, imageName: "legacy.svg" });
  let migratedLogo = null;
  const logoStore = {
    async load() { return migratedLogo; },
    async save(value) { migratedLogo = value; },
    async remove() {},
  };
  const persistence = createSiteBrandPersistence({ storage, logoStore });

  const restored = await persistence.load();
  assert.equal(restored.imageDataUrl, imageDataUrl);
  assert.equal(migratedLogo.imageName, "legacy.svg");
  assert.equal(JSON.parse(storage.getItem(SITE_BRAND_STORAGE_KEY)).imageDataUrl, undefined);
});

/* 上游 v0.2.116 的标签页图标是一组 <link>（ICO、多尺寸 PNG、shortcut icon）。
   自定义图片必须把这一整组一起改掉，只改一个 <link> 的话浏览器仍会用剩下的那几条。 */
test("site brand favicon takeover rewrites the whole icon link stack and restores it exactly", () => {
  const links = [
    createFaviconLink("/favicon.ico?v=20261029-is-5", "image/x-icon"),
    createFaviconLink("/favicon.ico?v=20261029-is-5"),
    createFaviconLink("/favicon.png?v=20261029-is-5", "image/png"),
    createFaviconLink("/icon.png?v=20261029-is-5", "image/png"),
  ];
  const documentObj = createFaviconDocument(links);
  const imageDataUrl = "data:image/png;base64,Y3VzdG9t";

  applySiteBrandFavicon(documentObj, { imageDataUrl });
  for (const link of links) {
    assert.equal(link.readAttribute("href"), imageDataUrl);
    assert.equal(link.readAttribute("type"), null, "自定义 data URL 不能保留上游的 MIME 声明");
  }

  applySiteBrandFavicon(documentObj, {});
  assert.equal(links[0].readAttribute("href"), "/favicon.ico?v=20261029-is-5");
  assert.equal(links[0].readAttribute("type"), "image/x-icon");
  assert.equal(links[1].readAttribute("href"), "/favicon.ico?v=20261029-is-5");
  assert.equal(links[2].readAttribute("href"), "/favicon.png?v=20261029-is-5");
  assert.equal(links[2].readAttribute("type"), "image/png");
  assert.equal(links[3].readAttribute("href"), "/icon.png?v=20261029-is-5");
});

test("site brand only takes over the app name once the user actually renames it", () => {
  assert.equal(resolveSiteBrandDocumentAppName({}), "IS");
  assert.equal(resolveSiteBrandDocumentAppName(DEFAULT_SITE_BRAND), "IS");
  assert.equal(resolveSiteBrandDocumentAppName({ name: "   " }), "IS");
  assert.equal(resolveSiteBrandDocumentAppName({ name: "My Studio" }), "My Studio");
});

test("site brand controller applies the custom image to the browser favicon and hands the title to syncDocumentTitle", () => {
  const imageDataUrl = "data:image/png;base64,dGFiLWljb24=";
  let titleSyncs = 0;
  const mark = {
    style: { setProperty() {} },
    dataset: {},
    classList: { toggle() {} },
  };
  const logoImage = {
    style: {},
    removeAttribute() {},
  };
  const refs = {
    brandName: {},
    brandTagline: {},
    brandMark: mark,
    brandLogoImage: logoImage,
  };
  const documentObj = createFaviconDocument([
    createFaviconLink("/favicon.ico?v=20261029-is-5", "image/x-icon"),
  ]);
  const controller = createSiteBrandingController({
    refs,
    documentObj,
    storage: createMemoryStorage(),
    syncDocumentTitle: () => { titleSyncs += 1; },
  });

  controller.applyBrand({ name: "Tab Brand", imageDataUrl, imageName: "tab.png" });
  assert.equal(documentObj.querySelectorAll(SITE_BRAND_FAVICON_LINK_SELECTOR)[0].readAttribute("href"), imageDataUrl);
  assert.equal(refs.brandName.textContent, "Tab Brand");
  assert.equal(titleSyncs, 1, "品牌变更后必须让 app.js 的 syncDocumentTitle 重算标题，而不是自己写 document.title");
  assert.equal(controller.getDocumentAppName(), "Tab Brand");
  assert.equal(documentObj.title, "", "控制器不得直接写 document.title，否则与 syncDocumentTitle 抢写");
});

test("site brand controller keeps the upstream application name until a rename happens", () => {
  const refs = { brandName: {}, brandTagline: {}, brandMark: { style: { setProperty() {} }, dataset: {}, classList: { toggle() {} } } };
  const controller = createSiteBrandingController({
    refs,
    documentObj: createFaviconDocument([]),
    storage: createMemoryStorage(),
    syncDocumentTitle: () => {},
  });
  controller.applyBrand(DEFAULT_SITE_BRAND);
  assert.equal(controller.getDocumentAppName(), "IS");
  controller.applyBrand({ name: "自建工作台" });
  assert.equal(controller.getDocumentAppName(), "自建工作台");
});

/* 合并契约：上游 v0.2.116 引入了整套站点图标入口，本地只有单个 SVG link。
   移植后两者必须并存——上游那套入口不能因为移植而被删，自定义也必须在同一套入口上生效。 */
test("ported branding coexists with the upstream multi-entry icon stack", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(html, /<link rel="icon" type="image\/x-icon" href="\/favicon\.ico\?v=[^"]+"\s*\/>/, "上游 ICO 入口必须保留");
  assert.match(html, /<link rel="icon" type="image\/png" sizes="1024x1024" href="\/favicon\.png\?v=[^"]+"\s*\/>/, "上游多尺寸 PNG 入口必须保留");
  assert.match(html, /<link rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png\?v=[^"]+"\s*\/>/, "上游 apple-touch 入口必须保留");
  assert.match(html, /<link rel="manifest" href="\/site\.webmanifest\?v=[^"]+"\s*\/>/, "上游 manifest 入口必须保留");
  assert.doesNotMatch(html, /id="siteBrandFavicon"/, "不能保留 fork 的单 SVG favicon 槽位，否则会出现第二个冲突入口");
  assert.match(html, /id="siteBrandModal"/, "品牌编辑器必须落在页面上");
  assert.match(html, /data-nav-action="brand"/, "品牌编辑器需要有可点击入口");
});

/* 上游 v0.2.116 的 .brand-mark 没有 overflow:hidden（fork 那份有），
   直接把 logo 放上去会溢出到圆角方框之外。这两条把裁切与底板对比度钉住。 */
test("brand mark clips a custom logo to its rounded box and keeps backplates legible", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(
    styles,
    /\.brand-mark\.has-custom-logo\s*\{[^}]*overflow:\s*hidden;/,
    "自定义 Logo 必须被裁到 .brand-mark 的圆角内（fork 靠 overflow:hidden 做到这点）",
  );
  assert.match(
    styles,
    /\.brand-mark\s*\{[^}]*border-radius:\s*var\(--brand-mark-radius/,
    "圆角必须由 --brand-mark-radius 接管，否则弹窗滑杆不起作用",
  );
  assert.match(
    styles,
    /\.brand-mark\[data-brand-background="light"\]\.has-custom-logo\s*\{[^}]*box-shadow:/,
    "浅底 + 白色 Logo 会同色不可见，必须补描边兜底",
  );
  assert.match(
    styles,
    /\.brand-mark\[data-brand-background="dark"\]\.has-custom-logo\s*\{[^}]*box-shadow:/,
    "深底 + 深色 Logo 需要同样的可见性兜底",
  );
  assert.match(
    styles,
    /body\.site-brand-modal-open\s*\{[^}]*overflow:\s*hidden;/,
    "弹窗打开时必须锁住整页滚动",
  );
});
