import {
  GENERATION_REQUEST_RETRY_DELAY_MS,
  getGenerationRequestRetryPlan,
} from "./generation-request-retry.mjs";
import { buildHttpResponseError } from "./http-response-error.mjs";

export function parseSseChunk(chunk) {
  const lines = String(chunk || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  let eventName = "";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      // 规范只要求吃掉冒号后的**单个**前导空格，其余空白属于数据本身。
      // 对整段 trim 会在代理恰好折在空格处时悄悄吞掉那个空格，把文本改写成
      // 另一个词——比报错更难发现。
      const value = line.slice("data:".length);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }

  // 规范要求多行 `data:` 用 `\n` 拼接；但实测上游代理会把长 JSON 拦腰折成
  // 多行 `data:`，按规范拼回后字符串中间凭空多出一个换行，`JSON.parse` 报
  // "Bad control character in string literal"。两种拼法都留着，解析时先规范、
  // 后紧凑。
  return {
    eventName,
    data: dataLines.join("\n"),
    dataCompact: dataLines.join(""),
  };
}

/**
 * 把 JSON 字符串字面量内部的裸控制字符转义成 `\uXXXX`。
 *
 * 中转原样透传上游 JSON 时，base64 分片里可能混进 0x0A 这类字符；按 RFC 8259
 * 它们必须写成 `\u` 转义。只改字符串内部的字符，结构部分一律不动。
 */
export function escapeJsonStringControlCharacters(text) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (const character of String(text || "")) {
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      output += character;
      if (inString) {
        escaped = true;
      }
      continue;
    }

    if (character === '"') {
      output += character;
      inString = !inString;
      continue;
    }

    if (inString && character.charCodeAt(0) < 0x20) {
      output += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }

    output += character;
  }

  return output;
}

/**
 * 按「规范拼法 → 折行兜底拼法 → 控制字符修复」的顺序解析一个 SSE 事件的 data。
 *
 * 顺序是硬的：控制字符修复会把换行转义成 `\u000a`，所以它必须排在两种拼法的
 * 原样解析之后。否则代理折行产生的换行会被当成「合法的字符串内容」转义进
 * base64，解析 succeeds 但数据已经被污染——比直接报错更难查。
 */
export function parseSseJsonText(text) {
  const candidates = [text];
  const compact = text.replace(/\n/g, "");
  if (compact !== text) {
    candidates.push(compact);
  }
  let lastError = new SyntaxError("SSE 事件没有 data 行");
  // 第一遍：原样解析，两种拼法都试；能救回折行且不改动内容。
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  // 第二遍：上游 JSON 里真带裸控制字符时，才上转义修复。
  for (const candidate of candidates) {
    try {
      return JSON.parse(escapeJsonStringControlCharacters(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export const TRUNCATED_SSE_STREAM_MESSAGE = "生成连接已中断，最终图未完整接收。请稍后重试，或降低分辨率。";

export async function consumeSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  // A chunk that only exists because the stream ended mid-event is a truncated
  // payload, not malformed protocol. Parsing it raises a raw JSON syntax error
  // that says nothing about the dropped connection, so trailing data reports the
  // interruption instead. Complete chunks keep surfacing real parse failures.
  async function emitChunk(chunk, { isTrailing = false } = {}) {
    const parsed = parseSseChunk(chunk);
    if (!parsed.data || parsed.data === "[DONE]") return;

    let payload;
    try {
      // 代理折行与控制字符都由 parseSseJsonText 兜住；失败才轮到 isTrailing
      // 那条「截断而非畸形」的判定。
      payload = parseSseJsonText(parsed.data);
    } catch (error) {
      if (isTrailing) {
        throw new Error(TRUNCATED_SSE_STREAM_MESSAGE, { cause: error });
      }
      throw error;
    }

    await onEvent(parsed.eventName, payload);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) await emitChunk(buffer, { isTrailing: true });
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      await emitChunk(chunk);
    }
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

export async function requestGenerationStream(endpointOrOptions = {}, directOptions = {}) {
  if (typeof endpointOrOptions === "string") {
    const {
      body,
      clientSessionId = "",
      fetchImpl = fetch,
      headers = {},
      method = "POST",
    } = directOptions || {};
    const requestHeaders = { ...headers };
    if (clientSessionId) {
      requestHeaders["x-client-session-id"] = clientSessionId;
    }
    const response = await fetchImpl(endpointOrOptions, {
      method,
      headers: requestHeaders,
      body,
    });
    if (!response.ok || !response.body) {
      throw await buildHttpResponseError(response, "生成请求失败");
    }
    return response;
  }

  const {
    job,
    clientSessionId,
    buildGenerationFormData,
    fetchImpl = fetch,
    retryPlan = getGenerationRequestRetryPlan,
    updateJob = () => {},
    waitMs = wait,
  } = endpointOrOptions || {};

  while (true) {
    try {
      const response = await fetchImpl("/api/generate", {
        method: "POST",
        headers: {
          "x-client-session-id": clientSessionId,
        },
        body: buildGenerationFormData(job),
      });

      if (!response.ok || !response.body) {
        throw await buildHttpResponseError(response, "生成请求失败");
      }

      return response;
    } catch (error) {
      const plan = retryPlan({
        error,
        retryCount: job.requestRetryCount || 0,
      });
      if (!plan.shouldRetry) {
        if (plan.retryable && !plan.shouldSurfaceError) {
          return null;
        }
        throw error;
      }

      job.requestRetryCount = plan.nextRetryCount;
      updateJob({
        requestRetryCount: plan.nextRetryCount,
        statusStage: "connecting",
        statusText: plan.message,
      });
      await waitMs(GENERATION_REQUEST_RETRY_DELAY_MS);
    }
  }
}
