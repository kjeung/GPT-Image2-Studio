import test from "node:test";
import assert from "node:assert/strict";

import {
  getCardThumbnailUrl,
  getGridThumbnailUrl,
  getThumbnailUrl,
  isServerImageProxyUrl,
  mergeServerAndBrowserGalleryItems,
  normalizeBrowserCachedGalleryItem,
} from "../lib/browser-image-cache.mjs";

test("saved local suite cards use bounded thumbnails and keep originals for full preview", () => {
  const item = { imageUrl: "/output/套图/source.png", thumbnailUrl: "/output/套图/source.png", relativePath: "套图/source.png", updatedAt: "2026-11-01" };
  const url = new URL(getCardThumbnailUrl(item), "http://localhost");
  assert.equal(url.pathname, "/api/gallery/thumbnail");
  assert.equal(url.searchParams.get("path"), item.relativePath);
  assert.equal(url.searchParams.get("v"), item.updatedAt);
  assert.equal(item.imageUrl, "/output/套图/source.png");
});

test("card thumbnails preserve explicit thumbnails, streamed previews and remote assets", () => {
  for (const imageUrl of ["data:image/png;base64,YQ==", "blob:preview", "https://example.com/image.png", "/api/images/remote.png"]) {
    assert.equal(getCardThumbnailUrl({ imageUrl, relativePath: "source.png" }), imageUrl);
  }
  assert.equal(getCardThumbnailUrl({ imageUrl: "/output/original.png", thumbnailUrl: "/thumb.webp", relativePath: "original.png" }), "/thumb.webp");
  assert.equal(getCardThumbnailUrl({ imageUrl: "/output/original.png" }), "/output/original.png");
});

test("browser image cache retains background metadata without guessing for old records", () => {
  for (const imageBackground of ["transparent", "opaque", undefined]) {
    const item = normalizeBrowserCachedGalleryItem({ filename: "background.png", imageBackground });
    assert.equal(item.imageBackground || "", imageBackground || "");
  }
});

test("browser image cache preserves image generation route metadata", () => {
  const normalized = normalizeBrowserCachedGalleryItem({
    filename: "direct-mode.png",
    generationRoute: "b",
    prompt: "直接调用模式记录",
  });

  assert.equal(normalized.imageRoute, "b");
});

test("browser image cache normalizes explicit image transport booleans", () => {
  for (const value of [true, 1, "1", "true", "on", "yes", "enabled"]) {
    const normalized = normalizeBrowserCachedGalleryItem({
      filename: "transport.png",
      includeImageToolModel: value,
      directImageStream: value,
    });
    assert.equal(normalized.includeImageToolModel, true);
    assert.equal(normalized.directImageStream, true);
  }

  for (const value of [false, 0, "0", "false", "off", "no", "disabled"]) {
    const normalized = normalizeBrowserCachedGalleryItem({
      filename: "transport.png",
      includeImageToolModel: value,
      directImageStream: value,
    });
    assert.equal(normalized.includeImageToolModel, false);
    assert.equal(normalized.directImageStream, false);
  }

  const legacy = normalizeBrowserCachedGalleryItem({ filename: "legacy.png" });
  assert.equal(Object.hasOwn(legacy, "includeImageToolModel"), false);
  assert.equal(Object.hasOwn(legacy, "directImageStream"), false);
});

test("browser image cache migrates legacy quality values by route", () => {
  assert.equal(
    normalizeBrowserCachedGalleryItem({ filename: "grok.png", imageRoute: "d", quality: "auto" }).quality,
    "medium",
  );
  assert.equal(
    normalizeBrowserCachedGalleryItem({ filename: "gpt.png", imageRoute: "a", quality: "auto" }).quality,
    "high",
  );
});

test("browser image cache recognizes local output and thumbnail URLs as server media", () => {
  assert.equal(isServerImageProxyUrl("/output/2026-09/09-01/demo.png"), true);
  assert.equal(isServerImageProxyUrl("/api/gallery/thumbnail?path=2026-09%2F09-01%2Fdemo.png"), true);
  assert.equal(isServerImageProxyUrl("https://example.com/image.png"), false);
});

test("thumbnail-focused views retain the server thumbnail over a cached full image", () => {
  const [item] = mergeServerAndBrowserGalleryItems(
    [{
      filename: "demo.png",
      imageUrl: "/output/2026-09/09-01/demo.png",
      thumbnailUrl: "/api/gallery/thumbnail?path=2026-09%2F09-01%2Fdemo.png",
    }],
    [{
      filename: "demo.png",
      imageUrl: "data:image/png;base64,ZmFrZQ==",
      thumbnailUrl: "data:image/png;base64,ZmFrZQ==",
    }],
  );

  assert.equal(item.imageUrl, "data:image/png;base64,ZmFrZQ==");
  assert.equal(item.thumbnailUrl, "/api/gallery/thumbnail?path=2026-09%2F09-01%2Fdemo.png");
  assert.equal(getThumbnailUrl({ ...item, serverThumbnailUrl: item.thumbnailUrl }), item.thumbnailUrl);
});

test("gallery grid asks for a server thumbnail even when a full data URL is cached", () => {
  // 新生成的图片保存时把整张原图的 dataURL 同时写进 imageUrl 与 thumbnailUrl，
  // 于是画廊/胶片条直接渲染全尺寸 base64，首屏因此很慢。有 relativePath 时
  // 网格必须改走缩略图接口，原图只在点开灯箱时才加载。
  const item = {
    filename: "fresh.png",
    imageUrl: "data:image/png;base64,AAAA",
    thumbnailUrl: "data:image/png;base64,AAAA",
    relativePath: "2026-11/fresh.png",
    createdAt: "2026-11-18T00:00:00.000Z",
  };
  const url = new URL(getGridThumbnailUrl(item), "http://localhost");
  assert.equal(url.pathname, "/api/gallery/thumbnail");
  assert.equal(url.searchParams.get("path"), "2026-11/fresh.png");
});

test("gallery grid keeps the original when no server-side file exists", () => {
  // 没有 relativePath（例如远端资产、生成中预览）时不能编造缩略图地址。
  assert.equal(getGridThumbnailUrl({ imageUrl: "https://example.com/a.png" }), "https://example.com/a.png");
  assert.equal(getGridThumbnailUrl({ imageUrl: "blob:preview" }), "blob:preview");
});

test("cached gallery entries keep relativePath so the grid can find thumbnails", () => {
  const normalized = normalizeBrowserCachedGalleryItem({
    filename: "kept.png",
    relativePath: "2026-11/kept.png",
    imageUrl: "/output/2026-11/kept.png",
    thumbnailUrl: "/api/gallery/thumbnail?path=2026-11%2Fkept.png",
  });
  assert.equal(normalized.relativePath, "2026-11/kept.png");
});
