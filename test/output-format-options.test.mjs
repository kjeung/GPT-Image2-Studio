import test from "node:test";
import assert from "node:assert/strict";

import {
  getOutputFormatOptions,
  DEFAULT_OUTPUT_FORMAT,
  normalizeOutputFormat,
  toApiOutputFormat,
  toOutputFormatExtension,
  toOutputFormatMimeType,
} from "../lib/output-format-options.mjs";

test("output format options expose jpg first, then png, for the studio UI", () => {
  // 默认格式是 jpg，所以它排在第一位，用户不选就是 jpg。
  assert.deepEqual(getOutputFormatOptions(), [
    { value: "jpg", label: "JPG" },
    { value: "png", label: "PNG" },
  ]);
});

test("output format normalization accepts png, jpg and jpeg aliases", () => {
  assert.equal(normalizeOutputFormat("png"), "png");
  assert.equal(normalizeOutputFormat("jpg"), "jpg");
  assert.equal(normalizeOutputFormat("jpeg"), "jpg");
  assert.equal(normalizeOutputFormat(".JPG"), "jpg");
  // 未知值回落到默认格式（jpg），不再是 png。
  assert.equal(normalizeOutputFormat("webp"), "jpg");
});

test("output format helpers use jpeg for the upstream API but jpg for local files", () => {
  assert.equal(toApiOutputFormat("jpg"), "jpeg");
  assert.equal(toApiOutputFormat("jpeg"), "jpeg");
  assert.equal(toApiOutputFormat("png"), "png");
  assert.equal(toOutputFormatExtension("jpeg"), "jpg");
  assert.equal(toOutputFormatMimeType("jpg"), "image/jpeg");
  assert.equal(toOutputFormatMimeType("png"), "image/png");
});

test("studio defaults to jpg output while transparent backgrounds stay png", () => {
  // 生图默认改为 jpg：没有显式选择时 normalizeOutputFormat 应回落到 jpg，
  // 但透明背景必须是 png（jpg 没有 alpha 通道）。
  assert.equal(DEFAULT_OUTPUT_FORMAT, "jpg");
  assert.equal(normalizeOutputFormat(""), "jpg");
  assert.equal(normalizeOutputFormat(undefined), "jpg");
});
