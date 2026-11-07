# GPT-Image2-Studio — 容器镜像
#
# 应用是纯 Node.js ESM HTTP 服务（server.mjs）：直接 serve 预构建的 public/，
# 没有打包器、没有转译器、生产依赖里也没有原生模块（jimp / exceljs / @jsquash/webp
# 全是纯 JS 或 WASM），所以「装生产依赖」就是整个构建。
#
# ⚠️ 访问控制不在镜像里。
# 本 fork 移除了应用自身的令牌 / Origin / Host 校验（见 lib/local-server-auth.mjs），
# 访问控制整体交给前置的 Traefik + Authentik。因此：
#   - 这个镜像只应挂在 Traefik 所在的 docker 网络里，不要直接向宿主机发布端口；
#   - 容器对外唯一的入口必须是带 Authentik 认证的 Traefik 路由。

# ---------------------------------------------------------------------------
# 阶段 1 — 生产依赖
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# 只先拷清单：依赖层能长期命中缓存，不会因为改业务代码而失效。
COPY package.json package-lock.json ./

# --omit=dev 把 devDependencies（openspec 工具链）挡在运行镜像外。
# 生产树纯 JS，无需 build-essential / python。
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# 阶段 2 — 运行
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# HOST 必须是 0.0.0.0：容器内只监听 127.0.0.1 时宿主/网桥接不进来。
# 应用侧的「非回环 + 明文」启动守卫已按本 fork 的设计移除（TLS 终结在 Traefik）。
# 两个目录必须显式指到 /data 下，否则默认会写 ~/Pictures 和仓库根目录，
# 落在卷外 —— 重启即丢。
ENV NODE_ENV=production \
    PORT=3600 \
    HOST=0.0.0.0 \
    IMAGE_STUDIO_OUTPUT_DIR=/data/output \
    IMAGE_STUDIO_LOCAL_DATA_DIR=/data \
    IMAGE_STUDIO_DISABLE_DNS_FALLBACK=1

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules

COPY --chown=node:node package.json ./
COPY --chown=node:node server.mjs generate-image.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
# 采集器扩展的打包接口从 extensions/ 读源文件；缺了它，扩展下载接口会 500。
COPY --chown=node:node extensions ./extensions

# 部署侧入口与被动的留存清理（应用自身没有留存功能，它跑在应用旁边）。
COPY --chown=node:node docker ./docker

# /data  生成图片、画廊索引与 .local/config.json
#        （config.json 里存着各家 API Key —— 按密钥对待）
# /app/artifacts  扩展打包的临时落点，建出来便于以后改 read_only 时挂 tmpfs
RUN install -d -o node -g node /data/output /app/artifacts \
 && chmod +x /app/docker/entrypoint.sh

USER node

EXPOSE 3600

# 声明卷：不带 -v 的裸 `docker run` 也能持久化状态；compose 用绑定目录覆盖。
VOLUME ["/data"]

# 用 Node 自带 fetch 探活：slim 镜像里没有 curl/wget。
# 容器内走 127.0.0.1 属于同一网络命名空间，因此这条不受 HOST 影响。
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||3600)+"/").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

# entrypoint 在后台拉起留存清理，然后 exec 交棒给 CMD，让应用成为 PID 1
# 并直接接收 `docker stop` 的信号。留存上限走环境变量，
# docker/retention-gc.mjs 里有默认值（keep 500 images / 50 sets，每 300s 一轮）。
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "server.mjs"]
