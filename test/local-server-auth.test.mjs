import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 本 fork 把访问控制整体交给前置 Traefik + Authentik：应用不再自己判断来源、
// 不再校验令牌、不再校验 Origin。这个文件的断言随之改写，但**不删除**——
// 它现在记录的是「应用侧已放行」这个新契约，以及这个契约依赖的前提。

test("the app itself no longer gates requests; the edge proxy owns access control", () => {
  const source = readFile(new URL("../lib/local-server-auth.mjs", import.meta.url), "utf8");

  return source.then((body) => {
    // 放行必须是无条件返回 allow()，不能残留任何 deny 分支。
    const authorizeBody = body.match(/export function authorizeLocalServerRequest[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(authorizeBody, "authorizeLocalServerRequest 必须仍然存在");
    assert.match(authorizeBody, /return allow\(\);/, "必须无条件放行");
    assert.doesNotMatch(authorizeBody, /deny\(/, "不得残留拒绝分支");
    assert.doesNotMatch(authorizeBody, /isLoopbackRemoteAddress|requestToken/, "不得再看来源或令牌");
  });
});

test("the startup guard no longer rejects a plaintext non-loopback bind", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  // 容器里 HOST 必然是 0.0.0.0（否则端口映射接不进来），TLS 又终结在 Traefik，
  // 所以「非回环 + 明文」是容器的常态而不是错误。
  assert.doesNotMatch(
    server,
    /非回环 HOST 不能直接使用明文 HTTP/u,
    "启动守卫已被移除：容器拓扑下非回环 + 明文是常态",
  );
  // 启动日志也不能再宣称应用自己有令牌与认证用户名，否则读日志的人会被误导。
  assert.doesNotMatch(server, /远程访问令牌: \$\{requestToken\}/u);
  assert.doesNotMatch(server, /远程浏览器认证用户名/u);
  assert.match(server, /访问控制: 由前置 Traefik \+ Authentik 负责/u);
});

test("the env example documents who owns access control now", async () => {
  const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");

  assert.match(envExample, /Traefik \+ Authentik/u, "必须在样例环境里写明访问控制归属");
  assert.match(envExample, /HOST=/, "HOST 仍要保留：容器下需设 0.0.0.0");
  // 这两个变量已不参与决策，样例里若还写着「开启/关闭」会误导。
  assert.doesNotMatch(envExample, /IMAGE_STUDIO_REQUEST_TOKEN=.*\n?.*固定访问令牌/u);
});

test("loopback-only helpers stay exported for direct Node runs", async () => {
  const {
    isLoopbackHostname,
    isLoopbackRemoteAddress,
    getLocalServerPlainHttpBindingPolicy,
  } = await import("../lib/local-server-auth.mjs");

  // 直接跑 Node（不经容器）时这些工具仍有意义，且被其它模块引用，不能删。
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("0.0.0.0"), false);
  assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackRemoteAddress("172.18.0.20"), false);
  assert.deepEqual(
    getLocalServerPlainHttpBindingPolicy({ host: "0.0.0.0", allowInsecureRemoteHttp: "1" }),
    { allowed: true, remote: true, insecure: true },
  );
});
