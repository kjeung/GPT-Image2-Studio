#!/usr/bin/env bash
#
# deploy-doctor.sh — 排查「重建了但页面还是旧的」
#
#   ./deploy-doctor.sh
#
# 只读，不改任何东西。把输出整段发回来即可定位。
#
# 为什么需要这个：容器部署有一条很隐蔽的失败路径 —— 构建、启动都不报错，
# 但实际跑的仍是旧镜像。此时 git log、git status 全都正常，只能从容器侧取证。

set -uo pipefail
cd "$(dirname "$0")"

CONTAINER="${STUDIO_CONTAINER_NAME:-gpt-image2-studio}"
section() { printf '\n\033[0;36m===== %s =====\033[0m\n' "$*"; }

section "1. 宿主机仓库"
echo "路径: $(pwd)"
echo -n "HEAD: "; git rev-parse HEAD 2>/dev/null || echo "(不是 git 仓库)"
echo -n "状态: "; git status --short 2>/dev/null | head -3 || true
echo -n "源码 createJob: "; grep -m1 '^function createJob' public/app.js 2>/dev/null || echo "(读不到)"
echo -n "源码 app.js 大小: "; stat -c%s public/app.js 2>/dev/null || echo "?"
echo -n "源码 app.js mtime: "; stat -c%y public/app.js 2>/dev/null || echo "?"

section "2. 容器清单（重点看有没有重复/旧的还在跑）"
docker ps -a --filter "name=${CONTAINER}" \
  --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}\t{{.Image}}' 2>/dev/null \
  || echo "docker 不可用"

section "3. 运行中容器的镜像与版本标签"
docker inspect "$CONTAINER" --format \
  '容器创建:  {{.Created}}
镜像 ID:   {{.Image}}
revision:  {{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null \
  || echo "容器 $CONTAINER 不存在"

section "4. 镜像清单"
docker images gpt-image2-studio --format \
  'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}\t{{.Size}}' 2>/dev/null \
  || echo "无该镜像"

section "5. 容器内实际文件（最硬的证据）"
if docker exec "$CONTAINER" true 2>/dev/null; then
  echo -n "app.js createJob: "
  docker exec "$CONTAINER" grep -m1 '^function createJob' /app/public/app.js 2>/dev/null || echo "(读不到)"
  echo -n "app.js 大小:     "
  docker exec "$CONTAINER" stat -c%s /app/public/app.js 2>/dev/null || echo "?"
  echo -n "app.js mtime:    "
  docker exec "$CONTAINER" stat -c%y /app/public/app.js 2>/dev/null || echo "?"
  echo -n "缩略图修复:      "
  if docker exec "$CONTAINER" grep -q "getGridThumbnailUrl" /app/public/app.js 2>/dev/null; then
    echo "有"
  else
    echo "缺失 ← 旧代码"
  fi
  echo -n "隐藏两栏 CSS:    "
  if docker exec "$CONTAINER" grep -q "prompt-template-body > .prompt-template-sidebar" /app/public/styles.css 2>/dev/null; then
    echo "有"
  else
    echo "缺失 ← 旧代码"
  fi
else
  echo "容器 $CONTAINER 不在运行，或无法 exec"
fi

section "6. 网络与端口"
docker port "$CONTAINER" 2>/dev/null || echo "(未发布端口，符合预期)"
echo -n "网络别名解析: "
docker exec "$CONTAINER" getent hosts "$CONTAINER" 2>/dev/null || echo "(容器内无法解析自身名)"

section "7. 结论提示"
cat <<'EOF'
对照第 1 节与第 5 节：
  - 源码是带参 createJob、容器内是无参  → 镜像未更新（构建没生效/容器没换）
  - 两边都是带参，但浏览器仍旧          → 浏览器缓存，硬刷新
  - 第 2 节出现两个同名容器             → 旧容器还在跑，新容器没起来
EOF
