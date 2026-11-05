# Docker 部署方案 — GPT-Image2-Studio（旧版分支）

> 面向旧版分支源码（`ImageStudio2.0/`，v0.2.0，`server.mjs` 5802 行）。本文档配套
> `Dockerfile`、`.dockerignore`、`docker-compose.yml`、`deploy/env.example`。
>
> 部署要求与工作区修改版（`repo/`，v0.2.046）**相同**：同一套保留策略 GC、同一套
> JSON 加固、同样的单卷数据布局与安全姿态。**唯一的根本差异是认证**：本分支应用
> **零认证**（无令牌、无 Basic、无明文守卫），第二节 1/2 是本文档最重要的一节。

## 一、项目运行时画像

| 项目 | 结论 | 依据 |
| --- | --- | --- |
| 形态 | 单进程 Node.js ESM HTTP 服务（`server.mjs`，5802 行） | `package.json` → `"start": "node server.mjs"` |
| 前端 | **预构建**，`public/` 下直接是成品（162 MB） | 无打包器、无 frontend 构建脚本 |
| 构建步骤 | **只有 `npm ci`**，无转译、无 codegen | 依赖树纯 JS |
| 生产依赖 | **2 个包**（jszip、pptxgenjs），纯 JS | 无 sharp / canvas / better-sqlite3 等原生模块 |
| Node | `engines: >=20` | 选用 `node:22-bookworm-slim` |
| 系统依赖 | 无外部二进制。全仓只有 2 处 `spawn`：`xdg-open`（可选，容器内无效）、`process.execPath` 再拉起 node 子进程（PPT 可编辑重建，容器内正常） | 逐处 grep 核对 |
| 网络 | 出站访问上游 API（OpenAI 等） | 需要容器能访问外网 |
| 数据 | 全部落在两个可配置目录下 | 见下方"数据目录" |

**数据目录**（与修改版完全一致，`server.mjs:167-176`）：

| 环境变量 | 默认值 | 实际用途 |
| --- | --- | --- |
| `IMAGE_STUDIO_OUTPUT_DIR` | `~/Pictures` | 生成图片、`json/ppt-decks`、`json/creation-sets` |
| `IMAGE_STUDIO_LOCAL_DATA_DIR` | **应用根目录**（危险） | `.local/config.json`、`prompt-agent-history.json` |

注意默认值：`LOCAL_DATA_DIR` 缺省指向**应用自己的目录**，会把 API Key 写进镜像层。
容器里必须显式覆盖。

另外 `lib/gallery-store.mjs` 把画廊索引写到 `dirname(OUTPUT_DIR)/.local/gallery-index.json`。
所以只要 `OUTPUT_DIR=/data/output` + `LOCAL_DATA_DIR=/data`，**所有持久化数据都落在 `/data` 一个卷里**：

```
/data/.local/config.json          ← 含 API Key，务必当机密
/data/.local/gallery-index.json
/data/prompt-agent-history.json
/data/output/...                  ← 生成资产
```

## 二、容器化的四个真正的难点

### 1. 本分支没有明文 HTTP 守卫——因为它根本没有认证

修改版 `server.mjs` 有"非回环 HOST 不能直接使用明文 HTTP"的守卫，容器里必须用
`IMAGE_STUDIO_ALLOW_INSECURE_REMOTE_HTTP=1` 显式放行。**本分支没有这个守卫**：

- `server.mjs:5796` 是 `server.listen(port, ...)`——**没有 HOST 参数**，Node 默认
  监听**所有网卡**（`::` / `0.0.0.0`）；
- 全仓不存在 `IMAGE_STUDIO_ALLOW_INSECURE_REMOTE_HTTP`、`IMAGE_STUDIO_REQUEST_TOKEN`、
  `lib/local-server-auth.mjs` 的任何一个。

结论：

> **容器里不需要（也没有）放行开关。应用无条件地以明文 HTTP 监听所有接口。**
> 唯一能用的边界是 Compose 的端口发布：`127.0.0.1:${STUDIO_PORT}:3600`。

`docker-compose.yml` 里因此**不设** `HOST`、**不设** `IMAGE_STUDIO_ALLOW_INSECURE_REMOTE_HTTP`——
设了也是 no-op，只会制造"有防护"的错觉。

### 2. 零认证：远程访问的认证必须由你的反代提供

本分支应用**不校验任何凭据**：没有令牌头、没有 Basic 挑战、没有来源地址检查。
任何能连到端口的人都能驱动工作台、花你的 API 额度。

由此得到与修改版**相反**的设计结论：

- 修改版：应用自带 Basic 认证（用户名 `studio` + 令牌），反代只做 TLS 透传；
- **本分支：应用零认证，反代必须自己提供认证**（SSO、Authentik、HTTP Basic、
  mTLS，任选），并且终结 TLS。

**唯一不能做的事**：把 `3600` 直接发布到 `0.0.0.0`，或者只在反代做 TLS 而不做认证。
那等于把一个无认证的 AI 图像生成服务挂到公网上。

### 3. DNS：容器里应当关掉应用自带的公共 DNS 兜底

`lib/node-dns-fallback.mjs`（与修改版逐字节相同）会把 `223.5.5.5`、`1.1.1.1`
**插到解析器列表最前面**，并劫持 `dns.lookup` 做失败兜底。Docker 已经提供了可用解析器，
在容器里这个兜底只会带来两个问题：多一条慢路径；以及在国内某些网络/防火墙下这两个地址不可达时表现异常。

→ Compose 里固定 `IMAGE_STUDIO_DISABLE_DNS_FALLBACK=1`。

### 4. 反向代理的硬约束

仓库不带反代，但这几条要求换任何实现都成立，不满足就会表现为"生成到一半断掉""大图 413"
"流式进度不动"。完整清单与 Traefik 示例见第四节 4.2 / 4.3：

- **SSE 不能缓冲**。生成进度走 `text/event-stream`（`server.mjs` 共 8 处），代理必须逐块转发；
  nginx 要 `proxy_buffering off`，Traefik 默认即可。
- **不能设读超时**。本分支**没有**上游超时旋钮（修改版的
  `IMAGE_STUDIO_CREATION_UPSTREAM_TIMEOUT_MS` 在这里不存在）——请求会一直开到上游关闭。
  代理任何 `read_timeout` / `write_timeout` 都会掐断长流。
- **请求体不能限制**：本地蒙版 50 MB（`server.mjs:219` `MAX_LOCAL_MASK_FILE_BYTES`）。
  **nginx 默认 `client_max_body_size 1m` 会直接 413，必须设成 `0`**；Traefik 无默认上限。

## 三、镜像构建方案

两阶段，`node:22-bookworm-slim`：

```
stage deps     COPY package.json package-lock.json → npm ci --omit=dev
stage runtime  COPY --from=deps node_modules，再 COPY server.mjs/lib/public/generate-image.mjs
```

与修改版构建方案的差异（均由本分支源码决定）：

- **不 COPY `extensions/`**——本分支没有这个目录（商品图采集插件是新版分支的
  Windows 专属功能）。
- **不设 `HOST` / `IMAGE_STUDIO_ALLOW_INSECURE_REMOTE_HTTP`**——应用不支持（见第二节 1）。
- 依赖只有 2 个包，`npm ci` 更快、`node_modules` 只有约 8 MB。

其余要点与修改版相同：

- **`--omit=dev` 必须**：开发依赖里的 Windows 桌面工具链（electron 等）不该进运行时镜像。
- **只 COPY 运行时真正读到的目录**：`server.mjs` 与 `lib/*.mjs` 只读 `public/`、`lib/`、
  `package.json`。`scripts/`、`test/`、`openspec/`、`docs/`、`examples/`、Cloudflare
  Pages 文件、Windows 启动脚本全部不需要。
- **`.dockerignore` 的匹配规则和 `.gitignore` 不一样**：Docker 匹配**相对构建上下文根**的
  路径，`*` 不跨 `/`。本分支源码 zip 附带了 `node_modules/`、`.env`、`.local/config.json`
  （含真实 API Key）、`output/`——`.dockerignore` 已全部排除。注意 `docker/` 目录
  **必须留在上下文里**（Dockerfile 要 COPY `entrypoint.sh` 和 `retention-gc.mjs`）。
- **非 root 运行**：使用镜像自带的 `node` 用户（uid 1000），`/data` 与 `/app/artifacts` 预先 chown。
- **健康检查不依赖 curl/wget**：slim 镜像两个都没有，改用 Node 内置 `fetch` 打 `127.0.0.1:3600/`
  （容器内自访问是回环请求）。

镜像体积预估 ≈ 300 MB（`public/` 162 MB 是主要部分，无法再压）。

## 四、部署形态与接入自己的反代

本仓库**只部署 studio 本身，不带任何反向代理**。用哪个反代是你的选择，应用对此没有意见——
只有几条硬性要求（见 4.2）。`docker-compose.yml` 里预留了一个外部网络，方便接入独立部署的反代。

| 形态 | 命令 | 适用 |
| --- | --- | --- |
| A. 本机单机 | `docker compose up -d --build` | 只在自己机器上用，端口只发布到 `127.0.0.1` |
| B. 接自己的反代 | 见 4.3 | 需要远程访问；由你的反代终结 TLS **并提供认证** |

### 4.1 快速开始

```bash
cp deploy/env.example .env
# 填 API Key（OPENAI_API_KEY 或 DIRECT_* / PROTOCOL_* 其中一条路由）
docker compose up -d --build
# 访问 http://127.0.0.1:3600
```

**本分支没有令牌要生成**——应用不校验令牌，`deploy/env.example` 里也没有
`IMAGE_STUDIO_REQUEST_TOKEN`。启动横幅会打印输出目录与配置路径，从 `docker logs` 可见。

不用 Compose 直接跑（注意 `.env` 不会被自动读取，要显式 `--env-file`）：

```bash
docker build -t gpt-image2-studio .
docker run -d --name studio -p 127.0.0.1:3600:3600 \
  -v studio-data:/data \
  --env-file .env \
  gpt-image2-studio
docker logs studio | head          # 启动横幅会打印 配置路径 / 输出目录
```

> 构建阶段用了 `RUN --mount=type=cache`（缓存 npm 下载），需要 BuildKit。
> `docker compose build` 与 Docker 23+ 的 `docker build` 默认就是 BuildKit，正常无需处理。

### 4.2 反代必须满足的四条

这四条与具体实现无关，换任何反代都要满足；不满足会表现为"生成到一半断掉""大图 413""流式进度不动"：

1. **不缓冲响应**。生成进度是 SSE（`text/event-stream`），代理必须逐块转发。
   nginx 要 `proxy_buffering off`，Traefik 默认即可。
2. **不设读/写/空闲超时**。本分支没有上游超时上限，长流会一直开到上游关闭，
   任何 `read_timeout` 都会掐断它；Traefik 的 `idleTimeout`（默认 180s）同样危险——
   **应用的 SSE 流没有心跳**，一次生成可能几分钟完全静默，必须显式归零。
3. **不限制请求体**。本地蒙版 50 MB。
   **nginx 默认 `client_max_body_size 1m` 会直接 413，必须设成 `0`**；Traefik 无默认上限。
4. **终结 TLS 并提供认证**。应用在容器内只能监听明文（见第二节 1），且**应用本身零认证**——
   TLS 和认证都必须由反代提供。反代到应用这一段是容器内网明文，属于可接受的边界。

### 4.3 Traefik 示例（完整配置）

Traefik 独立部署时，让两边共用一个 bridge 网络即可：

```bash
docker network create proxy
```

在本仓库的 `docker-compose.yml` 中取消两处注释（`studio` 的 `networks` 与文件末尾的 `proxy:`），
Traefik 侧用静态配置 + 动态配置两个文件：

```yaml
# ========== traefik.yml（静态配置） ==========
global:
  checkNewVersion: false
  sendAnonymousUsage: false

log:
  level: INFO

api:
  dashboard: false

entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"

providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true

certificatesResolvers:
  le:
    acme:
      email: you@example.com
      storage: /etc/traefik/acme.json
      httpChallenge:
        entryPoint: web

# 四条硬约束里属于全局的部分：
#   1) 不缓冲 SSE —— Traefik 默认逐块转发，无需配置；注意不要加 buffering 中间件
#   2) 无读/写超时 —— 显式归零，生成流开到上游关闭为止
#   3) 空闲超时也必须归零：应用的 SSE 流没有心跳（只在阶段切换时写事件），
#      一次生成可能几分钟完全静默，Traefik 默认的 idleTimeout=180s 会把
#      静默中的生成流掐断
transport:
  respondingTimeouts:
    readTimeout: 0
    writeTimeout: 0
    idleTimeout: 0
#   4) 请求体不限 —— Traefik 无默认上限（这是 nginx 侧要注意的事，见 4.2）
```

```yaml
# ========== /etc/traefik/dynamic/studio.yml（动态配置，file provider 加载） ==========
http:
  routers:
    studio:
      rule: Host(`studio.example.com`)
      entryPoints: [websecure]
      service: studio
      middlewares: [studio-auth]        # 认证必须在反代层做，见下方说明
      tls:
        certResolver: le

  middlewares:
    # ⚠️ studio 应用零认证（第二节 2），这是唯一防线——绕过它 = 公开烧 API 额度
    # 生成哈希: htpasswd -nbB admin '你的密码'（Bcrypt，Traefik 推荐）
    studio-auth:
      basicAuth:
        users:
          - "admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"
        removeHeader: true

    # 需要 SSO 时改用 forwardAuth 指向 Authentik/Authelia 等：
    # studio-auth:
    #   forwardAuth:
    #     address: http://authentik-outpost:9000/outpost.goauthentik.io/auth/traefik
    #     trustForwardHeader: true

  services:
    studio:
      loadBalancer:
        servers:
          - url: "http://gpt-image2-studio:3600"   # 容器名，走 proxy 网络
```

两条命令把它跑起来（Traefik 自己不在本仓库的 Compose 里，由你部署）：

```bash
docker run -d --name traefik --restart unless-stopped \
  -p 80:80 -p 443:443 \
  --network proxy \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v $PWD/traefik.yml:/etc/traefik/traefik.yml:ro \
  -v $PWD/dynamic:/etc/traefik/dynamic:ro \
  traefik:v3
```

> ⚠️ **认证在反代层做**：应用零认证（第二节 2），必须由反代提供——上面的
> `basicAuth`、或 `forwardAuth`（SSO 网关）、或前置一个认证代理都可以。
> **不要**指望应用会弹认证框——它不会。同时确保应用端口**绝对不可绕过反代**
> （Compose 已把端口限制在宿主机回环，保持这样）。

## 五、保留策略与 JSON 加固（移植自修改版 fork）

前四节只动 Docker 配置；本节是**对源码的改动**，全部移植自工作区修改版 fork
（`repo/`）的同类改动，移植范围与验证结果如下。改动全部留在本分支内，不向上游提 PR。

### 5.0 移植清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `docker/entrypoint.sh` | 原样复制 | 启动保留 GC 后 exec 应用 |
| `docker/retention-gc.mjs` | 原样复制 | 自包含，只依赖 `lib/safe-json-file.mjs` |
| `lib/safe-json-file.mjs` | 原样复制 | 原子写 + 损坏隔离 |
| 7 个 store 的 JSON 读写点 | 按修改版模式加固 | creation / gallery / config / portrait / article-illustration / ppt-deck / **prompt-agent** |

**数据布局已逐项验证与修改版一致**，因此 GC 无需改动即可工作：

- 集合清单目录：`json/{creation-sets,portrait-sets,article-illustration-sets,ppt-decks}`；
- 集合目录名：`YYYY-MM-DD-{creation,portrait,article,ppt}`（`server.mjs:684/942` 与
  各 store 的 `build*RelativeDir`）；
- 画廊索引：`dirname(OUTPUT_DIR)/.local/gallery-index.json`（`lib/gallery-store.mjs`）；
- sidecar：`json/**` 元数据孪生目录。

**与修改版的一处差异**：修改版没有加固 `prompt-agent-store.mjs`（历史文件仍是裸
`writeFile`），本次按对齐决定**顺手加固**——本分支 7 个 store 全部完成加固，
`lib/gallery-store.mjs` 仅剩的二进制图片写入（`writeFile(imagePath, imageBuffer)`）
不是 JSON，保持原样。

### 5.1 为什么必须做

应用自己**不删任何东西**：没有 TTL、没有数量上限、没有保留策略。持久卷会一直涨。
而 JSON 的持久化方式有一个系统性缺陷（见 5.5），会让一个被截断的文件永久废掉对应功能。

### 5.2 计数单位：单图按张、集合按套

输出有两种形态，单元必须分开：

| 类型 | 落盘 | 计数单元 |
| --- | --- | --- |
| 单图 | `output/YYYY-MM/DD/YYYY-MM-DD-<kind>/图片`（同一天同类共用一个目录） | 单个图片文件 |
| 集合 | `output/YYYY-MM/DD/YYYY-MM-DD-{creation,portrait,article,ppt}/<HHMM-名-后缀>/` 内含**多张** | 整个集合 |

**集合必须整体淘汰。** 清单里的 `items` / `listingDrafts` / `skuSubjects[].filenames` 逐条引用
图片文件名，从集合内部按张裁剪会让套图页面列出已经不存在的文件。删除时图目录、元数据孪生
目录（同路径加 `json/` 前缀）和清单一起删，语义完全照搬应用自己的
`creation-store.mjs` / `ppt-deck-store.mjs` 的目录解析规则。

**目录不能当统一单元**：单图的"日目录"里躺着当天所有图，按目录删会一次删掉一天。

### 5.3 参数

全部走环境变量，默认值写在 `docker/retention-gc.mjs` 里，`deploy/env.example` 有注释版：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `STUDIO_RETENTION_ENABLED` | `1` | 关掉则完全不跑 GC |
| `STUDIO_RETENTION_MAX_IMAGES` | `500` | 单图张数上限 |
| `STUDIO_RETENTION_MAX_SETS` | `50` | 集合套数上限 |
| `STUDIO_RETENTION_INTERVAL_SEC` | `300` | 扫描间隔 |
| `STUDIO_RETENTION_GRACE_SEC` | `600` | 宽限期，见下 |
| `STUDIO_RETENTION_DRY_RUN` | `0` | 只记日志不删，首次上线建议先开 |

**下限是 1，不允许 0**——"什么都不留"会让工作台变成黑洞，非法值会被回落到默认值并打警告。

**取值必须是纯十进制整数**（`/^\d+$/`），不接受 `1e3`、`12abc`、`500.0` 这类写法，违反即回落并告警。
这条不是洁癖：`Number.parseInt("1e3")` 会**静默返回 1**，而上限是 1 意味着下一次扫描几乎删光所有图。
一个有破坏性的开关不应该有能力悄悄犯这种错。

**宽限期是必需的**：跳过最近 `GRACE_SEC` 内被写过的对象，否则可能把正在生成的套图删掉。
排序键：单图用文件 `mtime`（简单），集合用清单里的 `createdAt`（生成时间，不可变——
用 mtime 会被应用的"重命名"功能刷新而误判为最新）；宽限期判断则额外看目录与清单的 mtime，
因为那才代表"最后活动时间"。

### 5.4 删除前先改名（避开竞态）

`listManifests` 之类的读取路径是 `readdir` + `readFile`，目录在中间被 `rm -rf` 会抛错。
所以 GC 删除前先把目标 `rename` 成同卷内的临时名（同卷 `rename` 是原子的），再删临时名——
读取方**要么看到完整文件、要么看到不存在，不会看到半个**。

### 5.5 JSON 加固

**根因**（逐文件核过，本分支与修改版基线相同）：

| 文件 | 写入方式 | 解析失败时 |
| --- | --- | --- |
| `gallery-index.json` | temp + `rename` **原子** | 抛错 → 画廊 500 |
| sidecar `json/**/*.json` | **裸 `writeFile`** | 抛错 → **画廊 500** |
| 4 类集合清单 | **裸 `writeFile`** | 抛错 → 对应列表 500 |
| `config.json` | **裸 `writeFile`** | 抛错 → 配置读取整体失败 |
| `prompt-agent-history.json` | **裸 `writeFile** | 抛错 → 提示词代理功能 500 |

**非原子写 + 读取端只容忍 ENOENT** = 进程被 kill / 磁盘满留下截断文件后，对应功能**永久 500**，
直到有人手工删掉那个文件。

**三层修复**（与修改版同构）：

1. **读取端容错**（`lib/safe-json-file.mjs`）——`readJsonFileSafe` 把"存在但解析不了"
   当作缺失，并把坏文件**改名隔离**成 `<文件名>.corrupt`（固定后缀，不会无限累积）。
   `readJsonFileOrThrowMissing` 让"缺失"以 `ENOENT` 形式抛出，于是各 store **原有的
   `catch (error) { if (error.code === "ENOENT") ... }` 分支全部原样生效**，改动面最小。
2. **写入端原子化**——7 个 store 的裸 `writeFile` 全部换成 `writeJsonFileAtomic`
   （同目录 temp + `rename`）。这才是**消除**截断文件的手段；第 1 层只是让它可自愈。
3. **兜底**——GC 每轮顺带递归清理 `.tmp` 半成品和 `.gc-` 残壳（含
   `dirname(OUTPUT_DIR)/.local` 这个索引目录，它在资产树之外，需要单独一个清理根）。
   两个实现细节值得记下来：**递归不受目录 mtime 影响**（否则活跃目录里的陈旧 `.tmp`
   永远扫不到，而活跃目录恰恰是写入被中断的地方），宽限期只作用于**被删的那个对象**；
   并且**先按文件名过滤再 `stat`**，因为这一层遍历会经过树里的每一张图和每一个 sidecar。

**分文件策略（不能一刀切地"删掉重建"）**：

| 文件 | 策略 | 理由 |
| --- | --- | --- |
| `gallery-index.json` | 当作空、按需重建 | 纯派生缓存，重扫盘 + sidecar 即可完全重建 |

> GC 删除图片后，索引里会留下该图的悬空条目（GC 只删文件、不写索引）。这无害：
> 画廊列表从**磁盘文件**构建（`collectImageEntries`），悬空条目永远不会被渲染；
> 同名图重新生成时它还会被复用为元数据源。作为对比，应用自己的
> `POST /api/output/delete` 会顺带清掉索引条目（旧版只有这一个删除入口，且只能删单图）。
| sidecar | 当作缺失，随后被回写 | 索引里通常有同一份元数据，双份互为冗余 |
| 4 类集合清单 | **改名隔离，绝不删除** | 清单是该集合的**唯一记录**，删了就永久丢失 |
| `config.json` | **改名隔离 + 回退环境变量** | 删了会丢掉全部 API Key |
| `prompt-agent-history.json` | 当作空 | 历史记录，丢了只影响提示词代理的上下文 |

**两处有意的行为变更**：

1. 损坏集合清单原本让对应列表接口**永久 500**（根因表第 3 行），现在被隔离并从列表中
   跳过——该集合不出现在列表里，但文件保留为 `.corrupt`，删掉隔离文件即可恢复显示。
   注意本分支**没有**"删除集合"接口（`/api/creation/sets/delete` 是新版分支才有的），
   所以不存在"删除接口从 500 变 200"这一说。
2. 画廊索引的 `.tmp` 快照恢复路径（`recoverGalleryIndex`）随加固一起删除：
   损坏索引现在被隔离后由 `listGalleryItems` 从图片文件与 sidecar **重建**（纯派生缓存），
   GC 负责清扫陈旧 `.tmp`。对应测试
   （`gallery store recovers a corrupt index from the newest valid temporary snapshot`）
   已删除并在原处注明原因——与修改版 fork 的处理一致。

### 5.6 空间估算（用于定卷大小）

上限数的是**数量不是字节**。按应用支持的 2K/4K 出图档位，单张约 2–10 MB：

| 单张 | 500 单图 | + 50 套 × 10 张 | × 20 张 | × 30 张 |
| --- | --- | --- | --- | --- |
| ~2 MB (1K) | 1.0 GB | 2.0 GB | 3.0 GB | 4.0 GB |
| ~5 MB (2K) | 2.5 GB | 5.0 GB | 7.5 GB | 10 GB |
| ~10 MB (4K) | 5.0 GB | 10 GB | 15 GB | 20 GB |

即**稳态约 2–20 GB**，请据此给卷留余量（建议 ≥ 25 GB）。元数据可忽略：
sidecar ~3 KB + 索引 ~1 KB 每张，2000 张才 ~8 MB。
每套几张由用户填的 SKU 决定（`targetCount = targetItems.length`），没有硬上限，所以按 30 张预留更稳。

### 5.7 实测覆盖

**测试基线对照**（本机 Node v24.21.0，`node --test --test-reporter=tap`）：

- 改动前：**1043 个测试 / 1038 通过 / 5 失败**；
- 改动后：**1042 个测试 / 1037 通过 / 5 失败**——数量差 1 是删除的 `.tmp` 恢复测试
  （5.5 行为变更 2），**5 个失败与改动前逐条相同**（均为改动前既有的环境/预算类失败，
  与本次改动无关）。**净回归为零**。

**GC 与 entrypoint 的端到端验证**：本机没有 Docker，验证方式与修改版相同——用与
Dockerfile 完全相同的 COPY 集合在 `/tmp` 搭"镜像文件系统"实测（详见第六节）。

## 六、已验证 / 未验证

本机**没有 Docker**，所以镜像没有真正 build 过。为弥补这一点，做了如下等价验证：

**已验证**：

- `npm ci --omit=dev` 成功（2 个生产包，纯 JS）；
- 以容器环境的变量启动服务成功，启动横幅输出正确，配置路径落在数据卷上；
- 路由全部 200：`/`、`/index.html`、`/styles.css`、`/app.js`、`/api/config`
  （本分支 `public/` 不含 `site.webmanifest` / `favicon.ico`，这两个 404 是正常的）；
- Dockerfile 里那条 healthcheck 命令实际执行 → exit 0；
- **写隔离**：跑完整轮流量后（高频轮询 + 前后快照对比），应用目录零新增/零变更文件，
  写入只落在 `/data`（`.local/config.json`、`output/json/...`）；
- **JSON 加固**：损坏 sidecar 不再让画廊 500 且被隔离后重建、损坏索引被隔离并重建、
  损坏清单被隔离且从列表跳过（而非 500）、损坏 `config.json` 回退环境变量、
  损坏提示词代理历史按空处理（返回 `[]` 而非 500）、原子写不残留临时文件；
- **保留策略**：GC 用带真实时间分布的夹具跑断言（最老单图淘汰 + sidecar 连带、
  最老集合整体淘汰、损坏清单隔离、路径逃逸拒绝、幂等、宽限期保护），
  并用 entrypoint 做端到端：GC 与应用同进程组运行时 `/`、`/api/config`、`/api/gallery`、
  `/api/creation/sets` 全程 200，单图与套数收敛到上限、嵌套 `.tmp` 与 `.gc-` 残壳清零。

**未验证**：镜像 build 与容器运行本身、Compose 端口/卷编排、以及接入具体反代后的端到端链路。

## 七、已知限制

1. **应用零认证**（本分支与修改版的最大差异）。没有令牌、没有 Basic、没有明文守卫；
   唯一边界是 Compose 的 loopback 端口发布。远程访问必须经**带认证**的 TLS 反代（见第二节 2）。
2. **没有商品图采集插件**。本分支不含 `extensions/product-image-collector`（该插件是
   新版分支的 Windows 专属功能），镜像里也没有对应报错路径。
3. **`xdg-open` 相关功能无效**。容器内没有该命令，"打开输出目录"这类按钮会失败；
   改为从宿主机的 `docker compose cp` 或直接看挂载目录。
4. **API Key 存在 `/data/.local/config.json`**：在界面里改的设置会落盘到卷。
   备份该卷等于备份密钥，注意权限。
5. 镜像基于 `node:22-bookworm-slim`；升级 Node 大版本前建议先跑一遍 `npm test`。

## 八、运维

```bash
docker compose logs -f studio          # 启动时会打印 配置路径 / 输出目录
docker compose exec studio sh          # 进容器
docker compose build --pull && docker compose up -d   # 升级
```

**备份**（数据全在一个卷里）：

```bash
docker run --rm -v gpt-image2-studio_studio-data:/data -v "$PWD:/backup" \
  alpine tar czf /backup/studio-data-$(date +%F).tar.gz -C /data .
```

**改用宿主机目录挂载**（把卷换成 bind mount）时要注意 uid：容器内是 `node`(1000)，

```bash
mkdir -p ./data && sudo chown -R 1000:1000 ./data
# 然后把 compose 里的 studio-data:/data 改为 ./data:/data
```

**进一步加固**（可选；`read_only` 的前提已成立——第六节确认过应用目录零写入。
但这一组改动本机没有 Docker，未实测，请自行确认后再上生产）：

```yaml
    read_only: true
    tmpfs:
      - /tmp:size=64m            # mkdtemp 需要（PPT 插件打包等）
      - /app/artifacts:size=64m  # 默认 compose 未挂，见上方说明
```

**保留策略相关**：

```bash
docker compose logs -f studio | grep retention      # 只看淘汰日志
```

GC 只在**确实动了东西**时才打一行摘要，静止时完全安静，所以"没日志"就是"没超限"。

```bash
# 首次上线：先干跑观察一段时间，确认不会误删再放开
echo 'STUDIO_RETENTION_DRY_RUN=1' >> .env && docker compose up -d
docker compose logs -f studio | grep retention
# 确认无误后改回
sed -i 's/^STUDIO_RETENTION_DRY_RUN=1/STUDIO_RETENTION_DRY_RUN=0/' .env && docker compose up -d
```

**看到 `.corrupt` 文件说明发生过 JSON 损坏**（或清单解析失败）。这些文件是**故意保留**的：
坏掉的清单是那个集合的唯一记录，删掉就永久找不回了。确认不需要后可以手工清掉：

```bash
docker compose exec studio find /data -name '*.corrupt' -ls
```

**排错清单**：

| 现象 | 原因 |
| --- | --- |
| 容器反复重启，日志有启动失败 | 检查 `deploy/env.example` 是否漏抄；本分支没有"非回环 HOST"守卫，不会因此失败 |
| 浏览器/客户端一连上就要求认证 | 本分支应用不会弹认证框——是你接的反代在要求认证，属预期（第二节 2） |
| 生成到一半连接断掉 | 你接的反代设了读超时，或缓冲了 SSE；对照第四节 4.2 |
| 上传大图 413 | 前面是 nginx 且没设 `client_max_body_size 0` |
| 生成结果重启后消失 | `/data` 没挂上卷，或改了 `OUTPUT_DIR` 却让它跑到卷外 |
| 卷一直涨、不收敛 | `STUDIO_RETENTION_ENABLED=0`，或数值非法被回落成了默认值（日志里会有警告） |
| 刚生成的图被删了 | `STUDIO_RETENTION_GRACE_SEC` 太小，调到大于单次最长生成时长 |
| 套图页面出现"清单里有、图没了" | 不应该发生——集合是整体淘汰的。若出现，说明有人手工删过目录 |
| 日志里出现 `quarantined unreadable JSON` | 该文件损坏过，已被隔离；应用会自动重建或降级，无需干预 |
