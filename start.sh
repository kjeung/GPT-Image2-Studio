#!/usr/bin/env bash
#
# GPT-Image2-Studio — 部署入口
#
#   cp .env.example .env    # 填好真实值
#   ./start.sh
#
# 职责固定为：读 .env → 渲染 traefik-dynamic.yml → 校验无残留占位符 →
# 前置检查 → 建数据目录 → docker compose up -d。
#
# 为什么渲染要和启动绑在一起：真实域名、Authentik 地址只存在于本地 .env，
# 入库的是带 __占位符__ 的模板。把渲染做成独立步骤，人就容易忘记重跑，
# 结果 Traefik 拿着一份过期路由 —— 那种故障表现为「502 或者认证莫名失效」，
# 很难一眼看出是配置没刷新。绑进 start.sh 就不会漏。

set -euo pipefail

cd "$(dirname "$0")"

TEMPLATE="traefik-dynamic.yml.example"
RENDERED="traefik-dynamic.yml"
ENV_FILE=".env"

# ---- 输出小工具 ------------------------------------------------------------
info()  { printf '\033[0;36m[start]\033[0m %s\n' "$*"; }
warn()  { printf '\033[0;33m[warn]\033[0m %s\n' "$*"; }
fail()  { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 前置检查 --------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "找不到 docker 命令。"
docker compose version >/dev/null 2>&1 || fail "找不到 docker compose（v2 插件）。"

[ -f "$ENV_FILE" ] || fail "缺少 $ENV_FILE。先执行：cp .env.example .env 然后填写真实值。"
[ -f "$TEMPLATE" ] || fail "缺少模板 $TEMPLATE（应当随仓库提供）。"

# .env 必须被 git 忽略：里面有密钥。
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  if ! git check-ignore -q "$ENV_FILE"; then
    fail "$ENV_FILE 没有被 .gitignore 忽略，拒绝继续 —— 里面有密钥，绝不能进版本库。"
  fi
fi

# ---- 读取 .env --------------------------------------------------------------
# 自己解析而不是 source：source 会执行文件里的任意 shell 代码，.env 不该是
# 可执行脚本；而且值里的空格/引号也更安全。
get_env() {
  local key="$1"
  # 取最后一条同名赋值（后写覆盖先写），去掉可能的引号与行尾注释。
  local line
  line=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" | tail -n1 || true)
  [ -n "$line" ] || return 0
  local value="${line#*=}"
  # 去掉 CRLF
  value="${value%$'\r'}"
  # 去掉成对引号
  if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# ---- 渲染动态配置 ----------------------------------------------------------
# 占位符 → 值。缺任何一个必需变量就报错，而不是渲染出一份半成品路由：
# 那份配置在 Traefik 侧通常表现为路由不生效，排查成本远高于这里直接失败。
info "渲染 $TEMPLATE → $RENDERED"

required_vars=(
  STUDIO_DOMAIN
  TRAEFIK_ENTRYPOINT
  TRAEFIK_CERT_RESOLVER
  AUTHENTIK_FORWARD_AUTH_URL
)

missing=()
for var in "${required_vars[@]}"; do
  value=$(get_env "$var")
  if [ -z "$value" ]; then
    missing+=("$var")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  fail "以下变量在 $ENV_FILE 中为空：${missing[*]}
请在 .env 里补全（可参考 .env.example 的注释）。"
fi

# 容器名与内部端口有默认值，允许不填。
STUDIO_CONTAINER_NAME_VALUE=$(get_env STUDIO_CONTAINER_NAME)
STUDIO_CONTAINER_NAME_VALUE="${STUDIO_CONTAINER_NAME_VALUE:-gpt-image2-studio}"
STUDIO_INTERNAL_PORT_VALUE=$(get_env STUDIO_INTERNAL_PORT)
STUDIO_INTERNAL_PORT_VALUE="${STUDIO_INTERNAL_PORT_VALUE:-3600}"

# sed 用 | 作分隔符：域名和 URL 里都有 /，用 / 会打架。
render() {
  local content
  content=$(cat "$TEMPLATE")
  content="${content//__STUDIO_DOMAIN__/$STUDIO_DOMAIN_VALUE}"
  content="${content//__TRAEFIK_ENTRYPOINT__/$TRAEFIK_ENTRYPOINT_VALUE}"
  content="${content//__TRAEFIK_CERT_RESOLVER__/$TRAEFIK_CERT_RESOLVER_VALUE}"
  content="${content//__AUTHENTIK_FORWARD_AUTH_URL__/$AUTHENTIK_FORWARD_AUTH_URL_VALUE}"
  content="${content//__STUDIO_CONTAINER_NAME__/$STUDIO_CONTAINER_NAME_VALUE}"
  content="${content//__STUDIO_INTERNAL_PORT__/$STUDIO_INTERNAL_PORT_VALUE}"
  printf '%s\n' "$content"
}

STUDIO_DOMAIN_VALUE=$(get_env STUDIO_DOMAIN)
TRAEFIK_ENTRYPOINT_VALUE=$(get_env TRAEFIK_ENTRYPOINT)
TRAEFIK_CERT_RESOLVER_VALUE=$(get_env TRAEFIK_CERT_RESOLVER)
AUTHENTIK_FORWARD_AUTH_URL_VALUE=$(get_env AUTHENTIK_FORWARD_AUTH_URL)

render > "$RENDERED"

# ---- 校验：不能有残留占位符 ------------------------------------------------
# 残留说明模板里有个占位符没在 .env 里对应上，或者渲染逻辑漏了一个。
# 这种配置交给 Traefik 不会报错，只会静默失效，所以在这里拦死。
if grep -qE '__[A-Z0-9_]+__' "$RENDERED"; then
  leftovers=$(grep -oE '__[A-Z0-9_]+__' "$RENDERED" | sort -u | tr '\n' ' ')
  fail "渲染后的 $RENDERED 仍有占位符未替换：$leftovers
请检查 start.sh 的 render 分支与 $TEMPLATE 是否一一对应。"
fi
info "占位符已全部替换。"

# 渲染产物同样绝不能进版本库：里面是真实域名。
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  if ! git check-ignore -q "$RENDERED"; then
    fail "$RENDERED 没有被 .gitignore 忽略 —— 它含真实域名，绝不能进版本库。"
  fi
fi

# ---- 数据目录 --------------------------------------------------------------
# 容器以 node(1000) 运行。数据目录用宿主绑定（不用 docker volume），就必须自己
# 保证属主：docker volume 会自动继承镜像里 /data 的属主（node），而宿主目录不会——
# 目录由 root 创建时，应用启动阶段 mkdir /data/output 直接 EACCES 崩溃，容器进入
# Restarting 循环。这就是"重建了但页面还是旧的"最常见的形态之一，所以这里必须
# 真正修好，而不是打一句警告就往下走。
DATA_DIR_VALUE=$(get_env DATA_DIR)
DATA_DIR_VALUE="${DATA_DIR_VALUE:-./data}"
info "数据目录：$DATA_DIR_VALUE"
mkdir -p "$DATA_DIR_VALUE"

DATA_OWNER_UID=$(stat -c '%u' "$DATA_DIR_VALUE" 2>/dev/null || echo "")
if [ "$DATA_OWNER_UID" != "1000" ]; then
  info "修正数据目录属主为 1000:1000 ..."
  if chown -R 1000:1000 "$DATA_DIR_VALUE" 2>/dev/null; then
    info "属主已修正。"
  elif command -v sudo >/dev/null 2>&1 && sudo -n chown -R 1000:1000 "$DATA_DIR_VALUE" 2>/dev/null; then
    info "已通过 sudo 修正属主。"
  else
    fail "无法把 $DATA_DIR_VALUE 的属主改成 1000:1000（当前 $(stat -c '%u:%g' "$DATA_DIR_VALUE" 2>/dev/null)）。
容器以 uid 1000 运行，属主不对会导致启动时 mkdir /data/output 报 EACCES 并反复重启。
请手动执行后重试：
  sudo chown -R 1000:1000 $DATA_DIR_VALUE"
  fi
fi

# ---- 网络检查（不创建，只提示）---------------------------------------------
TRAEFIK_NET_VALUE=$(get_env TRAEFIK_NET)
TRAEFIK_NET_VALUE="${TRAEFIK_NET_VALUE:-traefik_net}"
if ! docker network inspect "$TRAEFIK_NET_VALUE" >/dev/null 2>&1; then
  warn "docker 网络 $TRAEFIK_NET_VALUE 不存在。本仓库不创建它，请先："
  warn "  docker network create $TRAEFIK_NET_VALUE"
  warn "（或者把 .env 里的 TRAEFIK_NET 指向你已有的 Traefik 网络。）"
fi

# ---- 构建并启动 ------------------------------------------------------------
# 取当前 commit：既作为构建参数写进镜像标签，也作为启动后核对的基准。
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  GIT_COMMIT=$(git rev-parse HEAD)
else
  GIT_COMMIT="unknown"
  warn "当前目录不是 git 仓库，无法核对运行版本。"
fi
info "当前提交：${GIT_COMMIT:0:12}"

# --force-recreate 是必需的，不是保险：`up -d` 对已存在的容器只做「确保它在跑」，
# 即使镜像换了也**不会**用新镜像替换容器。曾因此出现「宿主机已 pull 到新提交、
# 页面仍是旧代码」，而 git log 看起来一切正常，极难排查。
info "构建镜像..."
docker compose build --build-arg GIT_COMMIT="$GIT_COMMIT"

info "启动容器（强制替换既有容器）..."
docker compose up -d --force-recreate

# ---- 核对：容器里跑的到底是不是当前提交 ------------------------------------
# 不核对就只是「我以为部署好了」。这一层挡住的是「构建成功但镜像没换」
# 「容器没被替换」这类静默失败 —— 它们不会报错，只会安静地跑旧代码。
if [ "$GIT_COMMIT" != "unknown" ]; then
  running_revision=$(docker inspect "$STUDIO_CONTAINER_NAME_VALUE" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo "")
  if [ -z "$running_revision" ] || [ "$running_revision" = "<no value>" ]; then
    warn "容器镜像没有 revision 标签，无法核对运行版本（可能是旧镜像）。"
  elif [ "$running_revision" != "$GIT_COMMIT" ]; then
    fail "运行版本与当前提交不一致：容器=${running_revision:0:12} 当前=${GIT_COMMIT:0:12}
镜像没有真正更新。请检查构建日志，或执行：
  docker compose build --no-cache --build-arg GIT_COMMIT=$GIT_COMMIT
  docker compose up -d --force-recreate"
  else
    info "运行版本校验通过：容器与当前提交一致（${GIT_COMMIT:0:12}）。"
  fi
fi

# ---- 静态资源自检 ----------------------------------------------------------
# 再硬核一层：直接从容器里读 app.js 的关键指纹。版本标签可能因为各种原因
# 与实际文件不符，读文件不会骗人。
if docker exec "$STUDIO_CONTAINER_NAME_VALUE" test -f /app/public/app.js 2>/dev/null; then
  if docker exec "$STUDIO_CONTAINER_NAME_VALUE" grep -q "getGridThumbnailUrl" /app/public/app.js 2>/dev/null; then
    info "静态资源自检通过。"
  else
    warn "容器内 app.js 缺少预期的新代码（getGridThumbnailUrl）。"
    warn "很可能是镜像未重建，或 public/ 未随提交更新。"
  fi
fi

info "完成。"
echo
echo "  动态配置已渲染到：$(pwd)/$RENDERED"
echo "  把它纳入 Traefik 的 file provider 监听目录（或软链过去）后，"
echo "  访问 https://<你的域名> 并完成 Authentik 登录。"
echo
echo "  提示：容器本身没有鉴权，同网络内的其他容器可以绕过 Authentik 直连它。"
echo "  浏览器请硬刷新（Ctrl+Shift+R）以丢弃缓存的旧 app.js / styles.css。"
