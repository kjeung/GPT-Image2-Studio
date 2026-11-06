import assert from "node:assert/strict";
import test from "node:test";

import { TRUNCATED_SSE_STREAM_MESSAGE, consumeSse } from "../lib/generation-client.mjs";

function streamOfText(text, chunkSize = 65536) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

test("generation SSE consumes the final event without a trailing blank line", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: complete\ndata: {"ok":true}'));
      controller.close();
    },
  });
  const events = [];
  await consumeSse(body, (eventName, payload) => events.push({ eventName, payload }));
  assert.deepEqual(events, [{ eventName: "complete", payload: { ok: true } }]);
});

test("generation SSE reports an interrupted stream instead of a raw JSON parse error", async () => {
  const payload = JSON.stringify({ setId: "s1", itemId: "i1", dataUrl: `data:image/png;base64,${"A".repeat(200_000)}` });
  const full = `event: item_final_image\ndata: ${payload}\n\n`;
  const truncated = full.slice(0, full.length - 300);

  const events = [];
  await assert.rejects(
    consumeSse(streamOfText(truncated), (eventName) => {
      events.push(eventName);
    }),
    (error) => {
      assert.equal(error.message, TRUNCATED_SSE_STREAM_MESSAGE);
      assert.ok(error.cause instanceof SyntaxError);
      assert.doesNotMatch(error.message, /JSON|position/i);
      return true;
    },
  );
  assert.deepEqual(events, []);
});

test("generation SSE still surfaces a parse failure for a complete malformed event", async () => {
  await assert.rejects(
    consumeSse(streamOfText('event: status\ndata: {"broken":\n\nevent: complete\ndata: {"ok":true}\n\n'), () => {}),
    (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.notEqual(error.message, TRUNCATED_SSE_STREAM_MESSAGE);
      return true;
    },
  );
});

test("generation SSE reassembles a large event split across many reads", async () => {
  const chunk = "B".repeat(300_000);
  const payload = JSON.stringify({ setId: "s1", itemId: "i1", chunk });
  const events = [];

  await consumeSse(
    streamOfText(`event: item_final_image_chunk\ndata: ${payload}\n\nevent: complete\ndata: {"ok":true}\n\n`, 8192),
    (eventName, parsed) => {
      events.push({ eventName, length: parsed.chunk?.length });
    },
  );

  assert.deepEqual(events, [
    { eventName: "item_final_image_chunk", length: 300_000 },
    { eventName: "complete", length: undefined },
  ]);
});

// ─── fork 回归：浏览器侧同样要吃住代理折行（服务端修好不够，浏览器是另一份解析器） ───

test("browser SSE parser survives a payload split mid-string across data lines", async () => {
  const result = "A".repeat(300);
  const payload = JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result } });
  const splitAt = payload.indexOf(result) + 100;
  const sse = [
    "event: response.output_item.done",
    `data: ${payload.slice(0, splitAt)}`,
    `data: ${payload.slice(splitAt)}`,
    "",
    "",
  ].join("\n");

  const events = [];
  await consumeSse(streamOfText(sse), async (eventName, eventPayload) => {
    events.push({ eventName, result: eventPayload?.item?.result });
  });

  assert.equal(events.length, 1);
  // 关键：结果必须是原样的 300 个 A，不能被折行换行污染。
  assert.equal(events[0].result, result);
});

test("browser SSE parser repairs raw control characters from an upstream JSON string", async () => {
  // 用 0x01（SOH）：它落在 JSON 字符串里属非法，但不像 0x0A / 0x0D 那样会被
  // SSE 自身的行切分吃掉。裸换行在**事件块级**本来就无法无损还原——切分那一
  // 步已经把换行当成行分隔符了；能无损修复的是整体 JSON body 那条路径。
  const rawPayload = `{"type":"image_generation.completed","b64_json":"prefix${String.fromCharCode(1)}suffix"}`;
  const sse = ["event: image_generation.completed", `data: ${rawPayload}`, "", ""].join("\n");

  const events = [];
  await consumeSse(streamOfText(sse), async (eventName, payload) => {
    events.push({ eventName, payload });
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].payload.b64_json, "prefix\u0001suffix");
});
