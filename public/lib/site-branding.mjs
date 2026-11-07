export const SITE_BRAND_STORAGE_KEY = "image-studio-site-brand-v1";
export const SITE_BRAND_DB_NAME = "image-studio-site-brand-assets-v1";
export const SITE_BRAND_DB_STORE = "brand-assets";
export const SITE_BRAND_LOGO_KEY = "site-logo";
export const DEFAULT_SITE_FAVICON_URL = "./assets/site-brand-default.svg";
export const MAX_SITE_LOGO_BYTES = 1.5 * 1024 * 1024;

/* 自定义图标接管的入口。上游 v0.2.116 用 ICO + 多尺寸 PNG + apple-touch + manifest
   一整套图标；这里只接管浏览器标签页那一层（rel 含 icon 的 <link>，含 "shortcut icon"），
   apple-touch 与 manifest 保持上游原样——它们是安装/主屏图标，SVG data URL 在那些槽位不可用。 */
export const SITE_BRAND_FAVICON_LINK_SELECTOR = "link[rel~='icon']";
export const SITE_BRAND_DOCUMENT_APP_NAME = "IS";

export const DEFAULT_SITE_BRAND = Object.freeze({
  name: "",
  tagline: "AI 图像生成工作流",
  imageDataUrl: "",
  imageName: "",
  size: 40,
  radius: 14,
  fit: "contain",
  background: "soft",
});

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

function cleanText(value, fallback, maxLength) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return (text || fallback).slice(0, maxLength);
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizeSiteBrand(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const imageDataUrl = String(source.imageDataUrl || "");
  const safeImageDataUrl = imageDataUrl.startsWith("data:image/") ? imageDataUrl : "";
  return {
    name: cleanText(source.name, DEFAULT_SITE_BRAND.name, 40),
    tagline: cleanText(source.tagline, DEFAULT_SITE_BRAND.tagline, 60),
    imageDataUrl: safeImageDataUrl,
    imageName: safeImageDataUrl ? cleanText(source.imageName, "自定义 Logo", 120) : "",
    size: clampInteger(source.size, 32, 64, DEFAULT_SITE_BRAND.size),
    radius: clampInteger(source.radius, 0, 24, DEFAULT_SITE_BRAND.radius),
    fit: source.fit === "cover" ? "cover" : "contain",
    background: ["transparent", "soft", "dark", "light"].includes(source.background)
      ? source.background
      : DEFAULT_SITE_BRAND.background,
  };
}

export function createSiteBrandConfigPayload(value = {}) {
  const brand = normalizeSiteBrand(value);
  return {
    name: brand.name,
    tagline: brand.tagline,
    imageName: brand.imageName,
    hasCustomLogo: Boolean(brand.imageDataUrl),
    size: brand.size,
    radius: brand.radius,
    fit: brand.fit,
    background: brand.background,
  };
}

export function getSiteBrandFaviconHref(value = {}, fallback = DEFAULT_SITE_FAVICON_URL) {
  return normalizeSiteBrand(value).imageDataUrl || fallback;
}

/* 页面标题的唯一权威仍是 app.js 的 syncDocumentTitle（"IS" / "IS - <页面名>"）。
   品牌名只在用户真的改过之后才接管应用名：默认名字为空，未命名时标题继续是 "IS"，
   上游既有的标题约定（含 document-title.test.mjs）原样保留。 */
export function resolveSiteBrandDocumentAppName(
  value = {},
  fallback = SITE_BRAND_DOCUMENT_APP_NAME,
) {
  const name = normalizeSiteBrand(value).name;
  return name && name !== DEFAULT_SITE_BRAND.name ? name : fallback;
}

/* 抛出的错误带 code：调用方（浏览器侧）据此换成当前界面语言的文案，
   纯函数本身不依赖 i18n，测试仍是断言 message 里的格式名与体积上限。 */
function siteLogoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateSiteLogoFile(file) {
  if (!file) throw siteLogoError("SITE_BRAND_LOGO_MISSING", "请选择 Logo 图片。");
  if (!SUPPORTED_IMAGE_TYPES.has(String(file.type || "").toLowerCase())) {
    throw siteLogoError("SITE_BRAND_LOGO_TYPE", "Logo 支持 PNG、JPG、WebP、GIF 或 SVG 格式。");
  }
  if (Number(file.size || 0) > MAX_SITE_LOGO_BYTES) {
    throw siteLogoError("SITE_BRAND_LOGO_TOO_LARGE", "Logo 图片不能超过 1.5 MB，请压缩后重试。");
  }
  return file;
}

export function readSiteLogoFile(file, FileReaderCtor = globalThis.FileReader) {
  validateSiteLogoFile(file);
  if (typeof FileReaderCtor !== "function") {
    return Promise.reject(new Error("当前浏览器无法读取 Logo 图片。"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReaderCtor();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(new Error("Logo 图片读取失败，请重新选择。")), { once: true });
    reader.readAsDataURL(file);
  });
}

/* 把标签页图标入口整体指向自定义图片；没有自定义时逐项还原成上游原始 href/type。
   原始值在第一次接管时记进 data-* ：移除自定义后图标栈回到 ICO / 1024 PNG 那一套，
   不留下任何"被改过但没还原"的入口。 */
export function applySiteBrandFavicon(documentObj, value = {}) {
  const brand = normalizeSiteBrand(value);
  const links = [...(documentObj?.querySelectorAll?.(SITE_BRAND_FAVICON_LINK_SELECTOR) || [])];
  for (const link of links) {
    if (!link?.dataset || typeof link.getAttribute !== "function") continue;
    if (link.dataset.siteBrandOriginalHref === undefined) {
      link.dataset.siteBrandOriginalHref = link.getAttribute("href") || "";
      link.dataset.siteBrandOriginalType = link.getAttribute("type") || "";
    }
    if (brand.imageDataUrl) {
      link.setAttribute("href", brand.imageDataUrl);
      link.removeAttribute("type");
    } else {
      link.setAttribute("href", link.dataset.siteBrandOriginalHref);
      if (link.dataset.siteBrandOriginalType) link.setAttribute("type", link.dataset.siteBrandOriginalType);
      else link.removeAttribute("type");
    }
  }
  return links;
}

function openSiteBrandDatabase(indexedDb) {
  if (!indexedDb?.open) return Promise.reject(new Error("当前浏览器不支持图片持久保存。"));
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(SITE_BRAND_DB_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SITE_BRAND_DB_STORE)) {
        database.createObjectStore(SITE_BRAND_DB_STORE, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("Logo 图片数据库打开失败。")), { once: true });
    request.addEventListener("blocked", () => reject(new Error("Logo 图片数据库正被其他页面占用，请关闭旧页面后重试。")), { once: true });
  });
}

function runLogoStoreRequest(indexedDb, mode, createRequest) {
  return openSiteBrandDatabase(indexedDb).then((database) => new Promise((resolve, reject) => {
    let result = null;
    const transaction = database.transaction(SITE_BRAND_DB_STORE, mode);
    const store = transaction.objectStore(SITE_BRAND_DB_STORE);
    const request = createRequest(store);
    request.addEventListener("success", () => { result = request.result ?? null; }, { once: true });
    transaction.addEventListener("complete", () => {
      database.close();
      resolve(result);
    }, { once: true });
    transaction.addEventListener("error", () => {
      database.close();
      reject(transaction.error || request.error || new Error("Logo 图片保存失败。"));
    }, { once: true });
    transaction.addEventListener("abort", () => {
      database.close();
      reject(transaction.error || request.error || new Error("Logo 图片保存已中止。"));
    }, { once: true });
  }));
}

export function createIndexedDbSiteLogoStore({ indexedDb = globalThis.indexedDB } = {}) {
  return {
    async load() {
      const record = await runLogoStoreRequest(indexedDb, "readonly", (store) => store.get(SITE_BRAND_LOGO_KEY));
      return record?.imageDataUrl?.startsWith("data:image/")
        ? { imageDataUrl: record.imageDataUrl, imageName: String(record.imageName || "自定义 Logo") }
        : null;
    },
    async save({ imageDataUrl, imageName }) {
      if (!String(imageDataUrl || "").startsWith("data:image/")) throw new Error("Logo 图片数据无效。");
      await runLogoStoreRequest(indexedDb, "readwrite", (store) => store.put({
        id: SITE_BRAND_LOGO_KEY,
        imageDataUrl,
        imageName: String(imageName || "自定义 Logo"),
        updatedAt: new Date().toISOString(),
      }));
    },
    async remove() {
      await runLogoStoreRequest(indexedDb, "readwrite", (store) => store.delete(SITE_BRAND_LOGO_KEY));
    },
  };
}

export function createSiteBrandPersistence({
  storage = globalThis.localStorage,
  logoStore = createIndexedDbSiteLogoStore(),
} = {}) {
  function readStoredSource() {
    try {
      const raw = storage?.getItem(SITE_BRAND_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveLocalPayload(payload) {
    storage?.setItem(SITE_BRAND_STORAGE_KEY, JSON.stringify(payload));
  }

  async function load() {
    const source = readStoredSource();
    const localBrand = normalizeSiteBrand(source);

    if (localBrand.imageDataUrl) {
      try {
        await logoStore.save(localBrand);
        saveLocalPayload(createSiteBrandConfigPayload(localBrand));
      } catch {
        // Keep the legacy localStorage image as a working fallback.
      }
      return localBrand;
    }

    if (source.hasCustomLogo !== true) return localBrand;
    try {
      const savedLogo = await logoStore.load();
      return normalizeSiteBrand({ ...localBrand, ...savedLogo });
    } catch {
      return localBrand;
    }
  }

  async function save(value) {
    const brand = normalizeSiteBrand(value);
    try {
      if (brand.imageDataUrl) await logoStore.save(brand);
      else await logoStore.remove();
      saveLocalPayload(createSiteBrandConfigPayload(brand));
    } catch (databaseError) {
      try {
        saveLocalPayload({ ...createSiteBrandConfigPayload(brand), ...brand });
      } catch {
        throw databaseError;
      }
    }
    return brand;
  }

  return { load, save };
}

export function createSiteBrandingController({
  refs,
  storage = globalThis.localStorage,
  logoStore = createIndexedDbSiteLogoStore(),
  documentObj = globalThis.document,
  getUiText = () => "",
  syncDocumentTitle = () => {},
  showError = () => {},
} = {}) {
  const persistence = createSiteBrandPersistence({ storage, logoStore });
  let current = normalizeSiteBrand(DEFAULT_SITE_BRAND);
  let draft = { ...current };
  let restoreFocusElement = null;
  let saving = false;

  function uiText(key, fallback) {
    return String(getUiText(key) || fallback);
  }

  function setFeedback(message = "", kind = "") {
    if (!refs.siteBrandFeedback) return;
    refs.siteBrandFeedback.textContent = message;
    refs.siteBrandFeedback.dataset.kind = kind;
  }

  function setMarkAppearance(mark, brand) {
    if (!mark) return;
    mark.style.setProperty("--brand-mark-size", `${brand.size}px`);
    mark.style.setProperty("--brand-mark-radius", `${brand.radius}px`);
    mark.dataset.brandBackground = brand.background;
    mark.classList.toggle("has-custom-logo", Boolean(brand.imageDataUrl));
  }

  function setImage(image, brand) {
    if (!image) return;
    if (brand.imageDataUrl) {
      image.src = brand.imageDataUrl;
      image.alt = `${brand.name} Logo`;
    } else {
      image.removeAttribute("src");
      image.alt = "";
    }
    image.style.objectFit = brand.fit;
  }

  function setFavicon(brand) {
    applySiteBrandFavicon(documentObj, brand);
    if (!refs.siteBrandFavicon) return;
    if (brand.imageDataUrl) refs.siteBrandFavicon.href = brand.imageDataUrl;
  }

  function applyBrand(brand) {
    const normalized = normalizeSiteBrand(brand);
    current = normalized;
    if (refs.brandName) refs.brandName.textContent = normalized.name;
    if (refs.brandTagline) refs.brandTagline.textContent = normalized.tagline;
    /* 未命名时标题行整体不占位，只保留图形标识与副标题，与默认留空一致。 */
    if (refs.brandTitleRow) refs.brandTitleRow.hidden = !normalized.name;
    setMarkAppearance(refs.brandMark, normalized);
    setImage(refs.brandLogoImage, normalized);
    setFavicon(normalized);
    syncDocumentTitle();
  }

  function renderDraft({ syncInputs = true } = {}) {
    const rendered = normalizeSiteBrand(draft);
    if (syncInputs && refs.siteBrandNameInput) refs.siteBrandNameInput.value = rendered.name;
    if (syncInputs && refs.siteBrandTaglineInput) refs.siteBrandTaglineInput.value = rendered.tagline;
    if (syncInputs && refs.siteBrandSizeInput) refs.siteBrandSizeInput.value = String(rendered.size);
    if (refs.siteBrandSizeValue) refs.siteBrandSizeValue.textContent = `${rendered.size}px`;
    if (syncInputs && refs.siteBrandRadiusInput) refs.siteBrandRadiusInput.value = String(rendered.radius);
    if (refs.siteBrandRadiusValue) refs.siteBrandRadiusValue.textContent = `${rendered.radius}px`;
    if (syncInputs && refs.siteBrandFitInput) refs.siteBrandFitInput.value = rendered.fit;
    if (syncInputs && refs.siteBrandBackgroundInput) refs.siteBrandBackgroundInput.value = rendered.background;
    if (refs.siteBrandPreviewName) refs.siteBrandPreviewName.textContent = rendered.name;
    if (refs.siteBrandPreviewTitleRow) refs.siteBrandPreviewTitleRow.hidden = !rendered.name;
    if (refs.siteBrandPreviewTagline) refs.siteBrandPreviewTagline.textContent = rendered.tagline;
    if (refs.siteBrandFilename) {
      refs.siteBrandFilename.textContent = rendered.imageDataUrl
        ? rendered.imageName
        : uiText("siteBrandDefaultMark", "当前使用默认图形标识");
    }
    if (refs.siteBrandRemoveImageButton) refs.siteBrandRemoveImageButton.disabled = !rendered.imageDataUrl;
    setMarkAppearance(refs.siteBrandPreviewMark, rendered);
    setImage(refs.siteBrandPreviewImage, rendered);
  }

  function syncDraftFromInputs() {
    draft = {
      ...draft,
      name: refs.siteBrandNameInput?.value,
      tagline: refs.siteBrandTaglineInput?.value,
      size: refs.siteBrandSizeInput?.value,
      radius: refs.siteBrandRadiusInput?.value,
      fit: refs.siteBrandFitInput?.value,
      background: refs.siteBrandBackgroundInput?.value,
    };
    renderDraft({ syncInputs: false });
  }

  function setOpen(open) {
    if (!refs.siteBrandModal) return;
    refs.siteBrandModal.classList.toggle("hidden", !open);
    refs.siteBrandModal.setAttribute("aria-hidden", String(!open));
    documentObj?.body?.classList.toggle("site-brand-modal-open", open);
    if (open) {
      restoreFocusElement = documentObj?.activeElement || null;
      draft = { ...current };
      renderDraft();
      setFeedback();
      requestAnimationFrame(() => refs.siteBrandNameInput?.focus());
    } else if (restoreFocusElement?.focus) {
      restoreFocusElement.focus();
      restoreFocusElement = null;
    }
  }

  const LOGO_ERROR_TEXT_KEYS = {
    SITE_BRAND_LOGO_MISSING: ["siteBrandErrorMissing", "请选择 Logo 图片。"],
    SITE_BRAND_LOGO_TYPE: ["siteBrandErrorType", "Logo 支持 PNG、JPG、WebP、GIF 或 SVG 格式。"],
    SITE_BRAND_LOGO_TOO_LARGE: ["siteBrandErrorTooLarge", "Logo 图片不能超过 1.5 MB，请压缩后重试。"],
    SITE_BRAND_LOGO_READ_FAILED: ["siteBrandErrorRead", "Logo 图片读取失败，请重新选择。"],
    SITE_BRAND_LOGO_UNSUPPORTED: ["siteBrandErrorUnsupported", "当前浏览器无法读取 Logo 图片。"],
  };

  function localizeLogoError(error) {
    const code = error?.code;
    const entry = LOGO_ERROR_TEXT_KEYS[code];
    if (entry) return uiText(entry[0], entry[1]);
    return error instanceof Error ? error.message : String(error);
  }

  async function applyImageFile(file) {
    try {
      const validFile = validateSiteLogoFile(file);
      const imageDataUrl = await readSiteLogoFile(validFile);
      draft = normalizeSiteBrand({ ...draft, imageDataUrl, imageName: validFile.name || "自定义 Logo" });
      renderDraft();
      setFeedback(uiText("siteBrandLogoLoaded", "Logo 图片已载入，点击“保存品牌设置”后将同步到浏览器标签页。"), "success");
    } catch (error) {
      const message = localizeLogoError(error);
      setFeedback(message, "error");
      showError(message);
    } finally {
      if (refs.siteBrandImageInput) refs.siteBrandImageInput.value = "";
    }
  }

  async function save(event) {
    event?.preventDefault();
    if (saving) return;
    saving = true;
    syncDraftFromInputs();
    draft = normalizeSiteBrand(draft);
    if (refs.siteBrandSaveButton) {
      refs.siteBrandSaveButton.disabled = true;
      refs.siteBrandSaveButton.textContent = uiText("siteBrandSaving", "保存中…");
    }
    setFeedback(uiText("siteBrandSavingHint", "正在保存品牌设置…"), "pending");
    try {
      const savedBrand = await persistence.save(draft);
      applyBrand(savedBrand);
      setOpen(false);
    } catch {
      const message = uiText("siteBrandSaveFailed", "Logo 保存失败，请检查浏览器是否允许网站存储数据后重试。");
      setFeedback(message, "error");
      showError(message);
    } finally {
      saving = false;
      if (refs.siteBrandSaveButton) {
        refs.siteBrandSaveButton.disabled = false;
        refs.siteBrandSaveButton.textContent = uiText("siteBrandSave", "保存品牌设置");
      }
    }
  }

  function bind() {
    refs.brandEditorOpenButton?.addEventListener("click", () => setOpen(true));
    refs.siteBrandCloseButton?.addEventListener("click", () => setOpen(false));
    refs.siteBrandCancelButton?.addEventListener("click", () => setOpen(false));
    refs.siteBrandBackdrop?.addEventListener("click", () => setOpen(false));
    refs.siteBrandForm?.addEventListener("submit", save);
    refs.siteBrandResetButton?.addEventListener("click", () => {
      draft = normalizeSiteBrand(DEFAULT_SITE_BRAND);
      renderDraft();
      setFeedback(uiText("siteBrandResetDone", "已恢复默认预览，保存后生效。"), "success");
    });
    refs.siteBrandRemoveImageButton?.addEventListener("click", () => {
      draft = normalizeSiteBrand({ ...draft, imageDataUrl: "", imageName: "" });
      renderDraft();
      setFeedback(uiText("siteBrandImageRemoved", "已移除 Logo 图片，保存后生效。"), "success");
    });
    refs.siteBrandImageInput?.addEventListener("change", (event) => applyImageFile(event.target.files?.[0]));

    [
      refs.siteBrandNameInput,
      refs.siteBrandTaglineInput,
      refs.siteBrandSizeInput,
      refs.siteBrandRadiusInput,
      refs.siteBrandFitInput,
      refs.siteBrandBackgroundInput,
    ].forEach((input) => {
      input?.addEventListener(input.type === "range" || input.tagName === "INPUT" ? "input" : "change", syncDraftFromInputs);
    });

    refs.siteBrandUploadZone?.addEventListener("dragover", (event) => {
      event.preventDefault();
      refs.siteBrandUploadZone.classList.add("dragover");
    });
    refs.siteBrandUploadZone?.addEventListener("dragleave", () => refs.siteBrandUploadZone.classList.remove("dragover"));
    refs.siteBrandUploadZone?.addEventListener("drop", (event) => {
      event.preventDefault();
      refs.siteBrandUploadZone.classList.remove("dragover");
      applyImageFile(event.dataTransfer?.files?.[0]);
    });

    documentObj?.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !refs.siteBrandModal?.classList.contains("hidden")) {
        event.preventDefault();
        setOpen(false);
      }
    });
  }

  async function load() {
    try {
      applyBrand(await persistence.load());
    } catch {
      applyBrand(DEFAULT_SITE_BRAND);
    }
  }

  function getBrand() {
    return { ...current };
  }

  function getDocumentAppName() {
    return resolveSiteBrandDocumentAppName(current);
  }

  return {
    applyBrand,
    bind,
    load,
    open: () => setOpen(true),
    close: () => setOpen(false),
    getBrand,
    getDocumentAppName,
    /* 语言切换后重画动态文案（文件名兜底、保存按钮等 data-ui-i18n 管不到的字段）。 */
    refresh: () => renderDraft(),
  };
}
