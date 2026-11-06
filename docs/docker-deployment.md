# 容器部署（Docker Compose + Traefik + Authentik）

面向本 fork 的容器部署。**访问控制不在应用里**：应用自身的令牌 / Origin / Host
校验已移除（见 `lib/local-server-auth.mjs` 的注释），由前置 Traefik + Authentik
统一负责。

> ⚠️ 由此产生一条硬约束：**studio 容器不发布任何宿主机端口。**
> 它能被访问的唯一路径是「带 Authentik 认证的 Traefik 路由 → docker 网络 →
> studio」。任何情况下都不要加 `ports:` 或 `docker run -p`，那会把一个能消耗
> 你 API 额度的 studio 裸露在网络里，而没有任何东西挡着。

## 前提

- Traefik 与 Authentik 已在运行，且与 studio **处于同一 docker 网络**。
- 下面默认该网络名为 `proxy`；不是的话改 `docker-compose.yml` 里 `name:` 一处。

```sh
docker network create proxy   # 若尚不存在
```

## 部署

```sh
cp deploy/env.example .env     # 填 API Key
docker compose up -d --build
docker compose logs -f studio
```

首次启动会打印输出目录与配置文件位置。确认容器在跑：

```sh
docker compose ps              # 应显示 healthy
```

## 接 Traefik + Authentik

参考 `deploy/traefik-example.yml`。把片段并进你现有的动态配置，需要：

1. **Authentik 前向认证**中间件（由 Authentik 的 Proxy Provider / outpost 生成），
   认证发生在这里，不在 node 里。
2. **关闭响应缓冲**。生成接口用 `text/event-stream` 推事件，缓冲会让事件攒到
   结束才一次性吐出，前端表现为「进度卡住然后突然完成」。
3. **读超时长于应用的上游超时**。默认 `IMAGE_STUDIO_CREATION_UPSTREAM_TIMEOUT_MS`
   是 20 分钟，上限 1 小时。Traefik 的默认超时会先切断连接，而应用还在等上游。

## 数据与持久化

单个命名卷 `studio-data` 挂到 `/data`，其下：

| 路径 | 内容 |
|---|---|
| `/data/output/` | 生成的图片，按月/日分目录 |
| `/data/.local/config.json` | 应用配置，**含各家 API Key，按密钥对待** |
| `/data/.local/gallery-index.json` | 画廊索引，与 output 同卷否则索引与图片会分裂 |

两个目录由 `docker-compose.yml` 显式指定。若删掉那两行，应用会回落到
`~/Pictures` 与仓库根目录 —— **落在卷外，重启即丢**。

## 留存清理

应用自身没有留存功能。`docker/entrypoint.sh` 会在后台拉起
`docker/retention-gc.mjs`，它按数量上限淘汰旧内容（默认保留 500 张独立图片、
50 套资产，每 300 秒一轮）。淘汰是按「整组」进行的：一套资产连同它的图片目录、
元数据目录和清单一起删除，不会留下指向已删文件的清单项。

关掉它：在 `.env` 里设 `STUDIO_RETENTION_ENABLED=0`。

## 排障

**容器起来了但 Traefik 502**

- 确认两个容器在同一网络：`docker network inspect proxy`。
- 确认容器内监听在 `0.0.0.0`：`docker compose logs studio` 首行应显示
  `http://0.0.0.0:3600`。若显示 `127.0.0.1`，说明 `HOST` 被 `.env` 覆盖了。

**生成进度卡住不动，最后一次性完成**

Traefik 缓冲没关。检查 `studio-sse` 中间件是否挂在路由上。

**长时间生成被中断，应用日志却还在等上游**

Traefik 读超时短于应用的上游超时。调 `studio-transport` 的 `idleTimeout`。

**扩展下载接口 500**

镜像里缺 `extensions/`。Dockerfile 已有 `COPY extensions ./extensions`，
若被改动过请确认它还在。

## 与上游的差异

本 fork 相对上游 `v0.2.116` 的容器相关改动：

- 新增 `Dockerfile` / `.dockerignore` / `docker-compose.yml` / `deploy/*`。
- 移除应用内鉴权与「非回环 + 明文」启动守卫（上游只面向本机回环运行）。
- 保留上游的 `extensions/`，因为扩展打包接口需要它。
