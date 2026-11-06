import { createHash, timingSafeEqual } from "node:crypto";

export const LOCAL_SERVER_BASIC_AUTH_USERNAME = "studio";
export const LOCAL_SERVER_WWW_AUTHENTICATE = 'Basic realm="GPT-Image2-Studio", charset="UTF-8"';

function getHeader(headers, name) {
  if (typeof headers?.get === "function") {
    return String(headers.get(name) || "").trim();
  }

  const normalizedName = name.toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === normalizedName);
  const value = Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1];
  return String(value || "").trim();
}

function safeEqual(left, right) {
  const leftDigest = createHash("sha256").update(String(left || ""), "utf8").digest();
  const rightDigest = createHash("sha256").update(String(right || ""), "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function normalizeNetworkHostname(value) {
  const hostname = String(value || "").trim().toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function parseHostHeader(value) {
  const rawHost = String(value || "").trim();
  const validHostSyntax = rawHost.startsWith("[")
    ? /^\[[0-9a-f:.]+\](?::\d{1,5})?$/iu.test(rawHost)
    : /^[a-z0-9.-]+(?::\d{1,5})?$/iu.test(rawHost);
  if (!validHostSyntax) {
    return { host: "", hostname: "" };
  }
  try {
    const parsed = new URL(`http://${rawHost}`);
    return {
      host: parsed.host.toLowerCase(),
      hostname: normalizeNetworkHostname(parsed.hostname),
    };
  } catch {
    return { host: "", hostname: "" };
  }
}

export function isLoopbackHostname(value) {
  const hostname = normalizeNetworkHostname(value);
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function isLoopbackRemoteAddress(value) {
  const address = normalizeNetworkHostname(value).replace(/^::ffff:/, "");
  return address === "::1" || /^127(?:\.\d{1,3}){3}$/.test(address);
}

export function getLocalServerPlainHttpBindingPolicy({ host, allowInsecureRemoteHttp } = {}) {
  const remote = !isLoopbackHostname(host);
  const insecure = remote && String(allowInsecureRemoteHttp || "").trim() === "1";
  return {
    allowed: !remote || insecure,
    remote,
    insecure,
  };
}

function isSameOriginRequest(headers, requestHost) {
  const origin = getHeader(headers, "origin");
  if (!origin) {
    return false;
  }
  try {
    const parsedOrigin = new URL(origin);
    return ["http:", "https:"].includes(parsedOrigin.protocol) && parsedOrigin.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

function parseBasicCredentials(value) {
  const match = String(value || "").match(/^Basic\s+(.+)$/i);
  if (!match) {
    return null;
  }
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return null;
    }
    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function hasValidRequestToken(headers, requestToken) {
  if (!requestToken) {
    return false;
  }

  const headerToken = getHeader(headers, "x-image-studio-token");
  if (headerToken && safeEqual(headerToken, requestToken)) {
    return true;
  }

  const authorization = getHeader(headers, "authorization");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  if (bearer && safeEqual(bearer, requestToken)) {
    return true;
  }

  const basic = parseBasicCredentials(authorization);
  return Boolean(
    basic &&
      safeEqual(basic.username, LOCAL_SERVER_BASIC_AUTH_USERNAME) &&
      safeEqual(basic.password, requestToken),
  );
}

function allow() {
  return { authorized: true, statusCode: 200, headers: {} };
}

function deny(statusCode, headers = {}) {
  return { authorized: false, statusCode, headers };
}

/**
 * 本 fork 的容器部署把访问控制整体交给前置的 Traefik + Authentik：
 * 应用不再自己判断来源、不再校验令牌、不再校验 Origin。
 *
 * 这样做的代价写在这里，改的人需要知道：任何能连到这个端口的人都能驱动
 * studio 并消耗 API 额度。因此这个放行**只在容器里成立**——对外暴露的
 * 唯一入口必须是带 Authentik 认证的 Traefik 路由。
 *
 * 保留函数形态而不是直接删掉调用点，是为了让 `server.mjs` 的接线保持
 * 单一分支、测试也仍有东西可断言（见 test/local-server-auth.test.mjs）。
 */
export function authorizeLocalServerRequest() {
  return allow();
}
