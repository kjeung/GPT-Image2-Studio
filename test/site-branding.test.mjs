import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SITE_BRAND,
  DEFAULT_SITE_FAVICON_URL,
  MAX_SITE_LOGO_BYTES,
  SITE_BRAND_STORAGE_KEY,
  createSiteBrandConfigPayload,
  createSiteBrandingController,
  createSiteBrandPersistence,
  getSiteBrandFaviconHref,
  normalizeSiteBrand,
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

test("site brand controller applies the custom image to the browser favicon", () => {
  const imageDataUrl = "data:image/png;base64,dGFiLWljb24=";
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
    siteBrandFavicon: {},
  };
  const documentObj = { title: "", body: { classList: { toggle() {} } } };
  const controller = createSiteBrandingController({ refs, documentObj, storage: createMemoryStorage() });

  controller.applyBrand({ name: "Tab Brand", imageDataUrl, imageName: "tab.png" });
  assert.equal(refs.siteBrandFavicon.href, imageDataUrl);
  assert.equal(refs.brandName.textContent, "Tab Brand");
  assert.equal(documentObj.title, "Tab Brand · Image Studio");
});
