// 生图默认 jpg：体积远小于 png，生成与回传都更快。透明背景仍需 png，
// 那条路径在 public/app.js 里显式覆盖。
export const DEFAULT_OUTPUT_FORMAT = "jpg";

const OUTPUT_FORMAT_OPTIONS = [
  { value: "jpg", label: "JPG" },
  { value: "png", label: "PNG" },
];

export function getOutputFormatOptions() {
  return OUTPUT_FORMAT_OPTIONS.map((option) => ({ ...option }));
}

export function normalizeOutputFormat(value = DEFAULT_OUTPUT_FORMAT) {
  const normalized = String(value || DEFAULT_OUTPUT_FORMAT).trim().replace(/^\./, "").toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") {
    return "jpg";
  }
  if (normalized === "png") {
    return "png";
  }
  return DEFAULT_OUTPUT_FORMAT;
}

export function toApiOutputFormat(value = "png") {
  return normalizeOutputFormat(value) === "jpg" ? "jpeg" : "png";
}

export function toOutputFormatExtension(value = "png") {
  return normalizeOutputFormat(value);
}

export function toOutputFormatMimeType(value = "png") {
  return normalizeOutputFormat(value) === "jpg" ? "image/jpeg" : "image/png";
}
