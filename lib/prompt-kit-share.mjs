const SHARE_VERSION = 1;
const SHARE_CODE_PREFIX = "PROMPT-KIT.V1.";
const MAX_ENCODED_LENGTH = 240_000;
const MAX_DECODED_BYTES = 600_000;
const MAX_TEMPLATE_COUNT = 200;
const MAX_SET_COUNT = 100;
const MAX_TEMPLATE_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 12_000;

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function transformBytes(bytes, StreamConstructor) {
  const transformed = new Blob([bytes]).stream().pipeThrough(new StreamConstructor("gzip"));
  return new Uint8Array(await new Response(transformed).arrayBuffer());
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const normalized = {};
  for (const key of ["ratio", "size", "format", "reasoningEffort"]) {
    const value = cleanText(params[key], 40);
    if (value) {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeTemplate(template, index) {
  const prompt = cleanText(template?.prompt, MAX_PROMPT_LENGTH);
  if (!prompt) {
    return null;
  }
  const id = cleanText(template?.id, 160) || `shared-template-${index + 1}`;
  return {
    id,
    name: cleanText(template?.name, MAX_TEMPLATE_NAME_LENGTH) || `模板 ${index + 1}`,
    prompt,
    ...(template?.analyzeTitle === true ? { analyzeTitle: true } : {}),
    ...(normalizeParams(template?.params) ? { params: normalizeParams(template.params) } : {}),
  };
}

function normalizeSet(promptSet, index, templateIds) {
  const ids = [...new Set((Array.isArray(promptSet?.templateIds) ? promptSet.templateIds : [])
    .map((id) => cleanText(id, 160))
    .filter((id) => templateIds.has(id)))];
  if (ids.length === 0) {
    return null;
  }
  return {
    id: cleanText(promptSet?.id, 160) || `shared-set-${index + 1}`,
    name: cleanText(promptSet?.name, MAX_TEMPLATE_NAME_LENGTH) || `套图 ${index + 1}`,
    templateIds: ids,
    ...(cleanText(promptSet?.updatedAt, 80) ? { updatedAt: cleanText(promptSet.updatedAt, 80) } : {}),
  };
}

export function normalizePromptKitShareData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("分享配置格式不正确。");
  }
  const templates = (Array.isArray(value.templates) ? value.templates : [])
    .slice(0, MAX_TEMPLATE_COUNT)
    .map(normalizeTemplate)
    .filter(Boolean);
  if (templates.length === 0) {
    throw new Error("分享配置中没有可用的提示词模板。");
  }
  const templateIds = new Set(templates.map((template) => template.id));
  const sets = (Array.isArray(value.sets) ? value.sets : [])
    .slice(0, MAX_SET_COUNT)
    .map((promptSet, index) => normalizeSet(promptSet, index, templateIds))
    .filter(Boolean);
  const active = value.active && typeof value.active === "object" && !Array.isArray(value.active)
    ? {
        selectedTemplateId: cleanText(value.active.selectedTemplateId, 160),
        selectedSetId: cleanText(value.active.selectedSetId, 160),
        prompt: cleanText(value.active.prompt, MAX_PROMPT_LENGTH),
        params: normalizeParams(value.active.params),
        promptEnhanceEnabled: Boolean(value.active.promptEnhanceEnabled),
        promptEnhanceText: cleanText(value.active.promptEnhanceText, MAX_PROMPT_LENGTH),
      }
    : {};
  return { templates, sets, active };
}

function compactShareData(value) {
  const data = normalizePromptKitShareData(value);
  return {
    v: SHARE_VERSION,
    t: data.templates.map((template) => [template.id, template.name, template.prompt, template.params || null, template.analyzeTitle === true]),
    s: data.sets.map((promptSet) => [promptSet.id, promptSet.name, promptSet.templateIds, promptSet.updatedAt || ""]),
    a: [
      data.active.selectedTemplateId || "",
      data.active.selectedSetId || "",
      data.active.prompt || "",
      data.active.params || null,
      Boolean(data.active.promptEnhanceEnabled),
      data.active.promptEnhanceText || "",
    ],
  };
}

function expandShareData(value) {
  if (!value || value.v !== SHARE_VERSION || !Array.isArray(value.t)) {
    throw new Error("分享配置版本不受支持。");
  }
  return normalizePromptKitShareData({
    templates: value.t.map((template) => ({
      id: template?.[0],
      name: template?.[1],
      prompt: template?.[2],
      params: template?.[3],
      analyzeTitle: template?.[4] === true,
    })),
    sets: (Array.isArray(value.s) ? value.s : []).map((promptSet) => ({
      id: promptSet?.[0],
      name: promptSet?.[1],
      templateIds: promptSet?.[2],
      updatedAt: promptSet?.[3],
    })),
    active: {
      selectedTemplateId: value.a?.[0],
      selectedSetId: value.a?.[1],
      prompt: value.a?.[2],
      params: value.a?.[3],
      promptEnhanceEnabled: value.a?.[4],
      promptEnhanceText: value.a?.[5],
    },
  });
}

export async function encodePromptKitSharePayload(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(compactShareData(value)));
  if (bytes.byteLength > MAX_DECODED_BYTES) {
    throw new Error("模板内容过多，暂时无法生成分享链接。");
  }
  let prefix = "b64.";
  let output = bytes;
  if (typeof CompressionStream === "function") {
    try {
      output = await transformBytes(bytes, CompressionStream);
      prefix = "gz.";
    } catch {
      output = bytes;
    }
  }
  const payload = `${prefix}${bytesToBase64Url(output)}`;
  if (payload.length > MAX_ENCODED_LENGTH) {
    throw new Error("模板内容过多，暂时无法生成分享链接。");
  }
  return payload;
}

export async function decodePromptKitSharePayload(payload) {
  const value = String(payload || "");
  if (!value || value.length > MAX_ENCODED_LENGTH) {
    throw new Error("分享链接中的配置无效或过大。");
  }
  const isCompressed = value.startsWith("gz.");
  if (!isCompressed && !value.startsWith("b64.")) {
    throw new Error("分享链接中的配置格式不正确。");
  }
  const encoded = value.slice(isCompressed ? 3 : 4);
  if (/\.{3}|…/.test(encoded)) {
    throw new Error("分享口令已被截断，请让发送方重新导出 TXT 文件后导入。");
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded) || encoded.replace(/=+$/, "").length % 4 === 1) {
    throw new Error("分享口令编码不正确，请使用完整的 TXT 文件导入。");
  }
  let bytes;
  try {
    bytes = base64UrlToBytes(encoded);
  } catch {
    throw new Error("分享口令已损坏，请重新导出 TXT 文件后导入。");
  }
  if (isCompressed) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("当前浏览器版本过旧，无法读取压缩的分享配置。");
    }
    try {
      bytes = await transformBytes(bytes, DecompressionStream);
    } catch {
      throw new Error("分享口令已损坏或不完整，请重新导出 TXT 文件后导入。");
    }
  }
  if (bytes.byteLength > MAX_DECODED_BYTES) {
    throw new Error("分享链接中的配置过大。");
  }
  try {
    return expandShareData(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("分享配置")) {
      throw error;
    }
    throw new Error("分享链接中的配置已损坏。");
  }
}

export function formatPromptKitShareCode(payload) {
  const value = String(payload || "").trim();
  if (!value) {
    throw new Error("分享口令不能为空。");
  }
  return `${SHARE_CODE_PREFIX}${value}`;
}

export function parsePromptKitShareCode(code) {
  const value = String(code || "").trim().replace(/^```(?:txt|text)?\s*/i, "").replace(/```$/, "").replace(/\\([_-])/g, "$1").replace(/\s+/g, "");
  if (!value.startsWith(SHARE_CODE_PREFIX)) {
    throw new Error("分享口令格式不正确，请完整复制后重试。");
  }
  const payload = value.slice(SHARE_CODE_PREFIX.length);
  if (!payload) {
    throw new Error("分享口令内容为空。");
  }
  return payload;
}

export function mergePromptKitShareData(localTemplates, localSets, sharedValue) {
  const shared = normalizePromptKitShareData(sharedValue);
  const sharedTemplateIds = new Set(shared.templates.map((template) => template.id));
  const templates = [
    ...shared.templates,
    ...(Array.isArray(localTemplates) ? localTemplates : []).filter((template) => !sharedTemplateIds.has(String(template?.id || ""))),
  ];
  const sharedSetIds = new Set(shared.sets.map((promptSet) => promptSet.id));
  const sets = [
    ...shared.sets,
    ...(Array.isArray(localSets) ? localSets : []).filter((promptSet) => !sharedSetIds.has(String(promptSet?.id || ""))),
  ];
  return {
    templates,
    sets,
    active: shared.active,
  };
}

export function movePromptTemplateInList(templates, templateId, direction) {
  const list = Array.isArray(templates) ? [...templates] : [];
  const index = list.findIndex((template) => String(template?.id || "") === String(templateId || ""));
  const offset = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  const targetIndex = index + offset;
  if (index < 0 || offset === 0 || targetIndex < 0 || targetIndex >= list.length) {
    return list;
  }
  [list[index], list[targetIndex]] = [list[targetIndex], list[index]];
  return list;
}

export function removePromptTemplatesFromLibrary(templates, sets, templateIds) {
  const removedIds = new Set(Array.from(templateIds || [], (id) => String(id || "")).filter(Boolean));
  return {
    templates: (Array.isArray(templates) ? templates : []).filter((template) => !removedIds.has(String(template?.id || ""))),
    sets: (Array.isArray(sets) ? sets : []).map((promptSet) => ({
      ...promptSet,
      templateIds: (Array.isArray(promptSet?.templateIds) ? promptSet.templateIds : [])
        .filter((templateId) => !removedIds.has(String(templateId || ""))),
    })),
  };
}
