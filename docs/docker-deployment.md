# Docker 部署方案 — GPT-Image2-Studio

> 面向 v0.2.046（commit `457f43b`）。本文档配套 `Dockerfile`、`.dockerignore`、
> `docker-compose.yml`、`deploy/Caddyfile`、`deploy/env.example`。

## 一、项目运行时画像

先把它是什么搞清楚，方案才有依据：

| 项目 | 结论 | 依据 |
| --- | --- | --- |
| 形态 | 单进程 Node.js ESM HTTP 服务（`server.mjs`，7643 行） | `package.json` → `"start": "node server.mjs"` |
| 前端 | **预构建**，`public/` 下直接是成品（`app.js` 926 KB、`styles.css` 531 KB） | 无打包器、无 frontend 构建脚本 |
| 构建步骤 | **只有 `npm ci`**，无转译、无 codegen | 官方 `vercel.json` 就是 `npm ci --omit=dev` |
| 生产依赖 | 177 个包 / 154 MB，**纯 JS**（jimp、exceljs、jszip、pptxgenjs、morphicons、@jsquash/webp） | 无 sharp / canvas / better-sqlite3 等原生模块 |
| Node | `engines: >=20`；上游 CI 用 22 | 选用 `node:22-bookworm-slim` |
| 系统依赖 | 无外部二进制。全仓只有 3 处 `spawn`：`xdg-open`（可选，容器内无效）、`process.execPath` 再拉起 node 子进程（PPT 可编辑重建，容器内正常）、Windows 专属编译器（插件打包，容器内不可用） | 逐处 grep 核对 |
| 网络 | 出站访问上游 API（OpenAI / xAI） | 需要容器能访问外网 |
| 数据 | 全部落在两个可配置目录下 | 见下方"数据目录" |

**数据目录**（这是容器化的核心，`server.mjs:236-243`）：

| 环境变量 | 默认值 | 实际用途 |
| --- | --- | --- |
| `IMAGE_STUDIO_OUTPUT_DIR` | `~/Pictures` | 生成图片、`json/ppt-decks`、`json/creation-sets` |
| `IMAGE_STUDIO_LOCAL_DATA_DIR` | **应用根目录**（危险） | `.local/config.json`、`prompt-agent-history.json` |

注意默认值：`LOCAL_DATA_DIR` 缺省指向**应用自己的目录**，会把 API Key 写进镜像层。
容器里必须显式覆盖。

另外 `lib/gallery-store.mjs:484` 把画廊索引写到 `dirname(OUTPUT_DIR)/.local/gallery-index.json`。
所以只要 `OUTPUT_DIR=/data/output` + `LOCAL_DATA_DIR=/data`，**所有持久化数据都落在 `/data` 一个卷里**：

```
/data/.local/config.json          ← 含 API Key，务必当机密
/data/.local/gallery-index.json
/data/prompt-agent-history.json
/data/output/...                  ← 生成资产
```

这一点已实测验证（见第五节）。

## 二、容器化的四个真正的难点

### 1. 明文 HTTP 守卫：容器内必须显式放行

`server.mjs:266-278` + `lib/local-server-auth.mjs:57`：

```js
const serverHost = explicitHost || "127.0.0.1";
if (!allowed) throw new Error("非回环 HOST 不能直接使用明文 HTTP……");
```

也就是说：**绑定非回环地址 + 明文 HTTP = 直接启动失败**。

但容器端口要被映射出来，进程就必须监听非回环地址。二者冲突，结论是：

> **容器里 `IMAGE_STUDIO_ALLOW_INSECURE_REMOTE_HTTP=1` 是必需的，不是可选的。**

风险是可控的，因为明文那一段被限制在两种不会出网的路径上：

- 宿主机端口只发布到 `127.0.0.1`（默认配置）；
- 或仅暴露在 Compose 内部网络，由 Caddy 终结 TLS。

**唯一不能做的事**：把 `3600` 直接发布到 `0.0.0.0` 当成"远程访问"。那会让令牌、提示词和
生成结果全部以明文过网。需要远程访问就走 `--profile tls`。

### 2. 远程认证：Basic 认证 + 令牌，边界在应用里

`authorizeLocalServerRequest()` 的逻辑（`lib/local-server-auth.mjs:132`）：

1. 校验 `x-image-studio-token` 头 / `Bearer` / Basic(`studio` : 令牌) —— 通过则放行；
2. 否则若来源地址非回环 → `401` + `WWW-Authenticate: Basic realm="GPT-Image2-Studio"`；
3. 回环请求还要求 `Host` 头也是回环地址。

实测确认：令牌头注入、Basic 认证都能放行，错误令牌被拒。

由此得到一个关键设计决定：**反向代理只做 TLS，不注入令牌、不做认证**。
理由——如果在 Caddy 里 `header_up X-Image-Studio-Token`，等于把"能连到 443 的人"全部认证为合法用户，
反而绕过了应用自带的认证。保持单一认证边界更安全，代价只是浏览器弹一次账号密码框
（用户名 `studio`，密码 = `IMAGE_STUDIO_REQUEST_TOKEN`）。

顺带一个安全优势：应用判断来源用的是 **TCP 对端地址**，不是 `X-Forwarded-For`，
所以伪造 XFF 无法绕过鉴权。

### 3. DNS：容器里应当关掉应用自带的公共 DNS 兜底

`lib/node-dns-fallback.mjs:161` 会把 `223.5.5.5`、`1.1.1.1` **插到解析器列表最前面**，
并劫持 `dns.lookup` 做失败兜底。Docker 已经提供了可用解析器，
在容器里这个兜底只会带来两个问题：多一条慢路径；以及在国内某些网络/防火墙下这两个地址不可达时表现异常。

→ Compose 里固定 `IMAGE_STUDIO_DISABLE_DNS_FALLBACK=1`。

### 4. 反向代理的两个硬约束

- **SSE 不能缓冲**。生成进度走 `text/event-stream`（`server.mjs:2132/2244/2354`），
  所以 Caddy 侧 `flush_interval -1`，且 `encode` 只作用于静态资源后缀，绝不压缩 `/api`。
- **不能设读超时**。单个套图项上游超时默认 **20 分钟**（`IMAGE_STUDIO_CREATION_UPSTREAM_TIMEOUT_MS=1200000`），
  代理任何 `read_timeout` / `write_timeout` 都会掐断长流。Caddy 默认不设这两个值，正合适。
- 反之**请求体不能限制**：本地蒙版 50 MB、预览快照 32 MB。
  Caddy 默认无上限；**若换 nginx 必须 `client_max_body_size 0`**（nginx 默认 1 MB 会直接 413）。

## 三、镜像构建方案

两阶段，`node:22-bookworm-slim`：

```
stage deps     COPY package.json package-lock.json → npm ci --omit=dev
stage runtime  COPY --from=deps node_modules，再 COPY server.mjs/lib/public/extensions
```

要点：

- **`--omit=dev` 必须**：否则会拖进 electron / electron-builder（数百 MB，且是 Windows 安装包工具链）。
- **只 COPY 运行时真正读到的目录**。逐个 grep 验证过：`server.mjs` 与 `lib/*.mjs` 只读
  `public/`、`lib/`、`package.json`，以及 `extensions/product-image-collector`
  （`/api/product-image-collector/package` 会现场打包该插件）。
  `desktop/`、`scripts/`、`build/`、`test/`、`openspec/`、`docs/`、`examples/` 全部不需要。
- **`.dockerignore` 的匹配规则和 `.gitignore` 不一样，别照搬直觉**。Docker 是把模式拿去匹配
  **相对构建上下文根**的路径，且 `*` 不跨 `/`。所以裸写 `*.md` 或 `test` 本来就只作用于根目录，
  并不会误伤 `public/assets/portrait-accessories/ATTRIBUTION.md` 或
  `extensions/product-image-collector/README.md`；真正会出事的是带 `**` 的写法
  （`**/*.md` 就会把这两个随应用分发的文件一起排掉）。本仓库里的写法加了前导 `/`，
  只是为了把"仅根目录"这个意图写明白。已用脚本按 moby/patternmatcher 的语义逐条回归验证：
  14 个必须进上下文的路径全部保留，16 个必须排除的路径全部排除。
- **非 root 运行**：使用镜像自带的 `node` 用户（uid 1000），`/data` 与 `/app/artifacts` 预先 chown。
- **健康检查不依赖 curl/wget**：slim 镜像两个都没有，改用 Node 内置 `fetch` 打 `127.0.0.1:3600/`
  （容器内自访问是回环请求，不需要令牌）。

镜像体积预估 ≈ 330 MB（`public/` 175 MB + `node_modules` 154 MB 是主要部分，无法再压）。

## 四、三种部署形态

| 形态 | 命令 | 适用 |
| --- | --- | --- |
| A. 本机单机 | `docker compose up -d --build` | 只在自己机器上用，端口只发布到 `127.0.0.1` |
| B. 局域网 / 公网 + TLS | `docker compose --profile tls up -d --build` | 需要远程访问，Caddy 自动签发证书 |
| C. 已有入口 | 只跑 `studio`，把 `studio:3600` 接到现有 nginx/Traefik | 已有反代体系，注意第三节的两个硬约束 |

### 快速开始

```bash
cp deploy/env.example .env
# 填 IMAGE_STUDIO_REQUEST_TOKEN（openssl rand -hex 32）和 API Key
docker compose up -d --build
# 访问 http://127.0.0.1:3600
```

开启 TLS：

```bash
# 在 .env 中设置 STUDIO_DOMAIN（公网域名；本机自签填 localhost）
docker compose --profile tls up -d
# 访问 https://<STUDIO_DOMAIN>，浏览器弹框输入 studio / <令牌>
```

不用 Compose 直接跑（注意 `.env` 不会被自动读取，要显式 `--env-file`）：

```bash
docker build -t gpt-image2-studio .
docker run -d --name studio -p 127.0.0.1:3600:3600 \
  -v studio-data:/data \
  --env-file .env \
  gpt-image2-studio
docker logs studio | head          # 启动横幅会打印 远程访问令牌 / 配置路径 / 输出目录
```

> 若 `.env` 里 `IMAGE_STUDIO_REQUEST_TOKEN` 留空，应用会自己随机生成一个并打印在启动横幅里，
> 从 `docker logs` 取即可。

> 构建阶段用了 `RUN --mount=type=cache`（缓存 npm 下载），需要 BuildKit。
> `docker compose build` 与 Docker 23+ 的 `docker build` 默认就是 BuildKit，正常无需处理。

## 五、保留策略与 JSON 加固（本 fork 的源码改动）

前四节只动 Docker 配置；本节是**唯一的源码改动**，集中在 `docker/`、`lib/safe-json-file.mjs`
以及 6 个 store 的读写调用点。改动全部留在 fork 内，不向上游提 PR。

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
`creation-store.mjs` `resolveDedicatedCreationDirectory` / `removeVerifiedCreationDirectory`
和 `ppt-deck-store.mjs` `getPptDedicatedRelativeDir`。

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

**宽限期是必需的**：跳过最近 `GRACE_SEC` 内被写过的对象，否则可能把正在生成的套图删掉。
排序键：单图用文件 `mtime`（简单），集合用清单里的 `createdAt`（生成时间，不可变——
用 mtime 会被应用的"重命名"功能刷新而误判为最新）；宽限期判断则额外看目录与清单的 mtime，
因为那才代表"最后活动时间"。

### 5.4 删除前先改名（避开竞态）

`listManifests` 之类的读取路径是 `readdir` + `readFile`，目录在中间被 `rm -rf` 会抛错。
所以 GC 删除前先把目标 `rename` 成同卷内的临时名（同卷 `rename` 是原子的），再删临时名——
读取方**要么看到完整文件、要么看到不存在，不会看到半个**。

### 5.5 JSON 加固

**根因**（逐文件核过）：

| 文件 | 写入方式 | 解析失败时 |
| --- | --- | --- |
| `gallery-index.json` | temp + `rename` **原子** | 抛错 → 画廊 500 |
| sidecar `json/**/*.json` | **裸 `writeFile`** | 抛错 → **画廊 500** |
| 4 类集合清单 | **裸 `writeFile`** | 抛错 → 对应列表 500 |
| `config.json` | **裸 `writeFile`** | 抛错 → 配置读取整体失败 |

**非原子写 + 读取端只容忍 ENOENT** = 进程被 kill / 磁盘满留下截断文件后，对应功能**永久 500**，
直到有人手工删掉那个文件。这正是"真实出现过"的那个问题。

**三层修复**：

1. **读取端容错**（`lib/safe-json-file.mjs`）——新增一个小模块，`readJsonFileSafe` 把"存在但解析不了"
   当作缺失，并把坏文件**改名隔离**成 `<文件名>.corrupt`（固定后缀，不会无限累积）。
   `readJsonFileOrThrowMissing` 让"缺失"以 `ENOENT` 形式抛出，于是各 store **原有的
   `catch (error) { if (error.code === "ENOENT") ... }` 分支全部原样生效**，改动面最小。
2. **写入端原子化**——5 处裸 `writeFile` 全部换成 `writeJsonFileAtomic`（同目录 temp + `rename`）。
   这才是**消除**截断文件的手段；第 1 层只是让它可自愈。
3. **兜底**——GC 每轮顺带递归清理 `.tmp` 半成品和 `.gc-` 残壳（含 `dirname(OUTPUT_DIR)/.local`
   这个索引目录，它在资产树之外，需要单独一个清理根）。

**分文件策略（不能一刀切地"删掉重建"）**：

| 文件 | 策略 | 理由 |
| --- | --- | --- |
| `gallery-index.json` | 当作空、按需重建 | 纯派生缓存，重扫盘 + sidecar 即可完全重建 |
| sidecar | 当作缺失，随后被回写 | 索引里通常有同一份元数据，双份互为冗余 |
| 4 类集合清单 | **改名隔离，绝不删除** | 清单是该集合的**唯一记录**，删了就永久丢失 |
| `config.json` | **改名隔离 + 回退环境变量** | 删了会丢掉全部 API Key |

**一处有意的行为变更**：损坏清单在删除接口上原本返回 500（永久坏掉），现在被隔离并报
`notFound`，返回 200。`test/asset-record-delete-api.test.mjs` 里的断言已随之更新并注明了原因。
基线对照确认这是**本次唯一的行为变更**，其余测试结果与未修改的 `main` 完全一致。

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

GC 用带真实时间分布的夹具跑了 15 条断言（最老单图淘汰 + sidecar 连带、最老集合整体淘汰、
损坏清单隔离、路径逃逸拒绝、幂等、宽限期保护），并用 entrypoint 做了端到端：GC 与应用同进程组
运行时 `/`、`/api/config`、`/api/gallery`、`/api/creation/sets` 全程 200，6 张单图收敛到 3、
2 套收敛到 1、嵌套 `.tmp` 与 `.gc-` 残壳清零。

JSON 加固跑了 17 条断言：损坏 sidecar 不再让画廊 500 且被隔离后重建、损坏索引被隔离并重建、
损坏清单被隔离而非删除、损坏 `config.json` 回退环境变量、原子写不残留临时文件。

有一个缺陷是实测才发现的：`isManifestArea` 最初把**整个 `json/` 树**当成清单区（应用只保护
`json/{creation-sets,...}` 这 4 个具体目录），导致 sidecar 被拒绝删除、集合的元数据孪生目录解析为
`null` 从而所有集合都被跳过。已修正。

## 六、已验证 / 未验证

本机**没有 Docker**，所以镜像没有真正 build 过。为弥补这一点，做了如下等价验证：

**已验证**（用与 Dockerfile 完全相同的 COPY 集合在 `/tmp` 搭了一个"镜像文件系统"实测）：

- `npm ci --omit=dev` 成功，177 包 / 154 MB / 15 s；
- 以容器环境的变量启动服务成功，启动横幅输出正确，配置路径落在数据卷上；
- 路由全部 200：`/`、`/index.html`、`/styles.css`、`/app.js`、`/api/config`、`/site.webmanifest`、`/favicon.ico`；
- Dockerfile 里那条 healthcheck 命令实际执行 → exit 0；
- 认证行为：令牌头放行、Basic 放行、错误令牌拒绝、非回环 Host 无令牌 403；
- `HOST=0.0.0.0` 不带放行开关 → 按预期启动失败；
- **写隔离**：跑完整轮流量后（高频轮询 + 前后快照对比），应用目录零新增/零变更文件，
  写入只落在 `/data`（`.local/config.json`、`output/json/...`）。

- **回归对照**：完整测试套件（207 个文件）在改动前后各跑一次。改动前 5 个失败，其中
  `asset-record-delete-api` 是有意的行为变更（已更新断言，见 5.5），另外 4 个
  `product-image-*` / `native-host` 用例在**未修改的 main 上同样失败**——它们需要 Windows/MSVC。
  改动后结果与 main 基线逐文件一致，**净回归为零**。

**未验证**：镜像 build 与容器运行本身、Caddy 配置加载、Compose 端口/卷编排。

## 七、已知限制

1. **商品图采集插件在容器里不可用**。`/api/product-image-collector/package` 上游就写死了
   Windows 专属（实测返回 `500 商品图本地剪贴板助手只能在 Windows 上构建。`），
   它需要用 MSVC 编译一个 Windows `.exe` 原生宿主，Linux 容器无法复制。
   镜像里保留 `extensions/` 是为了让这个报错保持清晰（否则会变成难以理解的 ENOENT）。
2. **`xdg-open` 相关功能无效**。容器内没有该命令，"打开输出目录"这类按钮会失败；
   改为从宿主机的 `docker compose cp` 或直接看挂载目录。
3. **API Key 存在 `/data/.local/config.json`**：在界面里改的设置会落盘到卷。
   备份该卷等于备份密钥，注意权限。
4. 镜像基于 `node:22-bookworm-slim`；升级 Node 大版本前建议先跑一遍 `npm test`。

## 八、运维

```bash
docker compose logs -f studio          # 启动时会打印 远程访问令牌 / 配置路径 / 输出目录
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
| 容器反复重启，日志有"非回环 HOST 不能直接使用明文 HTTP" | 少了 `IMAGE_STUDIO_ALLOW_INSECURE_REMOTE_HTTP=1`，或被你在 `.env` 里把 `HOST` 覆盖成了空 |
| `docker compose config` 报 `set IMAGE_STUDIO_REQUEST_TOKEN in .env` | 令牌为空，按提示生成一个 |
| 浏览器一直弹认证框 | 用户名必须是 `studio`，密码是**令牌**，不是 API Key |
| 生成到一半连接断掉 | 前面还有一层自建代理设了读超时；本方案 Caddy 侧不设超时 |
| 上传大图 413 | 前面是 nginx 且没设 `client_max_body_size 0` |
| 生成结果重启后消失 | `/data` 没挂上卷，或改了 `OUTPUT_DIR` 却让它跑到卷外 |
| 卷一直涨、不收敛 | `STUDIO_RETENTION_ENABLED=0`，或数值非法被回落成了默认值（日志里会有警告） |
| 刚生成的图被删了 | `STUDIO_RETENTION_GRACE_SEC` 太小，调到大于单次最长生成时长 |
| 套图页面出现"清单里有、图没了" | 不应该发生——集合是整体淘汰的。若出现，说明有人手工删过目录 |
| 日志里出现 `quarantined unreadable JSON` | 该文件损坏过，已被隔离；应用会自动重建或降级，无需干预 |
