# GPT-Image2-Studio (legacy branch) — production container image
#
# The application is a plain Node.js ESM HTTP server (server.mjs) that serves
# the pre-built front end straight out of public/. There is no bundler, no
# transpiler and no native addon in the production dependency tree, so
# "install production dependencies" is the entire build.
#
# This legacy branch has NO authentication of its own (no request token, no
# Basic auth, no non-loopback plaintext guard) and does not support a HOST
# bind address — server.listen(port) binds every interface. The only access
# boundary is therefore the Compose port publish (host loopback) plus your
# own TLS-terminating reverse proxy for remote access. See
# docs/docker-deployment.md, "零认证" below.

# ---------------------------------------------------------------------------
# Stage 1 — production dependencies
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Only the manifests, so the slow dependency layer stays cached and is not
# invalidated every time application source changes.
COPY package.json package-lock.json ./

# --omit=dev keeps the Windows desktop toolchain out of the runtime image.
# This branch's production tree is pure JS (jszip, pptxgenjs) — no native
# modules, so no build tools are needed in the runtime stage either.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# PORT is read by server.mjs. The plaintext-HTTP acknowledgement flag and the
# HOST bind address from the newer branch do NOT exist here: this server has
# no plaintext guard to acknowledge and no HOST to set. Do not add them.
ENV NODE_ENV=production \
    PORT=3600 \
    IMAGE_STUDIO_OUTPUT_DIR=/data/output \
    IMAGE_STUDIO_LOCAL_DATA_DIR=/data \
    IMAGE_STUDIO_DISABLE_DNS_FALLBACK=1

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# "type": "module" plus the entry point and everything server.mjs imports.
# public/ is the whole front end. This branch ships no extensions/ directory
# (the product-image-collector plugin is a newer-branch, Windows-only feature).
COPY --chown=node:node package.json ./
COPY --chown=node:node server.mjs generate-image.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

# Deployment-side entrypoint plus the retention GC that runs beside the studio.
COPY --chown=node:node docker ./docker

# /data          generated images, gallery index and .local/config.json
#                (config.json holds the provider API keys — treat it as secret)
# /app/artifacts scratch space, created so it can be a tmpfs and the root
#                filesystem made read-only. Nothing on Linux writes here.
RUN install -d -o node -g node /data/output /app/artifacts \
 && chmod +x /app/docker/entrypoint.sh

USER node

EXPOSE 3600

# Declared so a bare `docker run` without -v still persists state; Compose
# overrides it with the named volume.
VOLUME ["/data"]

# Uses Node's built-in fetch: the slim image carries no curl or wget. The probe
# hits the server from inside the container, where the request is loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||3600)+"/").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

# Starts the retention GC in the background, then execs the CMD below so the
# application still becomes PID 1. Retention limits come from the environment;
# docker/retention-gc.mjs holds the defaults and deploy/env.example lists them.
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "server.mjs"]
