export const SITE_BRAND_STORAGE_KEY = "image-studio-site-brand-v1";
export const SITE_BRAND_DB_NAME = "image-studio-site-brand-assets-v1";
export const SITE_BRAND_DB_STORE = "brand-assets";
export const SITE_BRAND_LOGO_KEY = "site-logo";
export const DEFAULT_SITE_FAVICON_URL = "./assets/site-brand-default.svg";
export const MAX_SITE_LOGO_BYTES = 1.5 * 1024 * 1024;

export const DEFAULT_SITE_BRAND = Object.freeze({
  name: "aEboli",
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

export function validateSiteLogoFile(file) {
  if (!file) throw new Error("请选择 Logo 图片。");
  if (!SUPPORTED_IMAGE_TYPES.has(String(file.type || "").toLowerCase())) {
    throw new Error("Logo 支持 PNG、JPG、WebP、GIF 或 SVG 格式。");
  }
  if (Number(file.size || 0) > MAX_SITE_LOGO_BYTES) {
    throw new Error("Logo 图片不能超过 1.5 MB，请压缩后重试。");
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
      reject(transaction.error || new Error("Logo 图片保存已中止。"));
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
  showError = () => {},
} = {}) {
  const persistence = createSiteBrandPersistence({ storage, logoStore });
  let current = normalizeSiteBrand(DEFAULT_SITE_BRAND);
  let draft = { ...current };
  let restoreFocusElement = null;
  let saving = false;

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
    if (!refs.siteBrandFavicon) return;
    refs.siteBrandFavicon.href = getSiteBrandFaviconHref(brand);
  }

  function applyBrand(brand) {
    const normalized = normalizeSiteBrand(brand);
    current = normalized;
    if (refs.brandName) refs.brandName.textContent = normalized.name;
    if (refs.brandTagline) refs.brandTagline.textContent = normalized.tagline;
    setMarkAppearance(refs.brandMark, normalized);
    setImage(refs.brandLogoImage, normalized);
    setFavicon(normalized);
    if (documentObj) documentObj.title = `${normalized.name} · Image Studio`;
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
    if (refs.siteBrandPreviewTagline) refs.siteBrandPreviewTagline.textContent = rendered.tagline;
    if (refs.siteBrandFilename) {
      refs.siteBrandFilename.textContent = rendered.imageDataUrl ? rendered.imageName : "当前使用默认图形标识";
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

  async function applyImageFile(file) {
    try {
      const validFile = validateSiteLogoFile(file);
      const imageDataUrl = await readSiteLogoFile(validFile);
      draft = normalizeSiteBrand({ ...draft, imageDataUrl, imageName: validFile.name || "自定义 Logo" });
      renderDraft();
      setFeedback("Logo 图片已载入，点击“保存品牌设置”后将同步到浏览器标签页。", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      refs.siteBrandSaveButton.textContent = "保存中…";
    }
    setFeedback("正在保存品牌设置…", "pending");
    try {
      const savedBrand = await persistence.save(draft);
      applyBrand(savedBrand);
      setOpen(false);
    } catch {
      const message = "Logo 保存失败，请检查浏览器是否允许网站存储数据后重试。";
      setFeedback(message, "error");
      showError(message);
    } finally {
      saving = false;
      if (refs.siteBrandSaveButton) {
        refs.siteBrandSaveButton.disabled = false;
        refs.siteBrandSaveButton.textContent = "保存品牌设置";
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
      setFeedback("已恢复默认预览，保存后生效。", "success");
    });
    refs.siteBrandRemoveImageButton?.addEventListener("click", () => {
      draft = normalizeSiteBrand({ ...draft, imageDataUrl: "", imageName: "" });
      renderDraft();
      setFeedback("已移除 Logo 图片，保存后生效。", "success");
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

  return { applyBrand, bind, load, open: () => setOpen(true), close: () => setOpen(false) };
}
