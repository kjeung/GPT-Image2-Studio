import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("镜像内嵌 git commit，供部署后核对实际运行的是哪份代码", async () => {
  // 事故背景：宿主机 git log 已是新提交、容器里跑的却还是 4 个提交之前的代码，
  // 线上 app.js 的 Last-Modified 停在旧日期。没有"镜像自述版本"就无从判断
  // 到底是构建没跑、缓存命中，还是容器没被替换 —— 只能靠猜。
  const dockerfile = await read("../Dockerfile");

  assert.match(
    dockerfile,
    /ARG\s+GIT_COMMIT/,
    "Dockerfile 必须接收 GIT_COMMIT 构建参数，否则镜像无法自述版本",
  );
  assert.match(
    dockerfile,
    /LABEL\s+org\.opencontainers\.image\.revision/,
    "镜像必须把 commit 写进标准 OCI revision 标签，部署后可用 docker inspect 核对",
  );

  // LABEL 必须出现在 COPY public 之前：Docker 从被引用处起向后失效缓存，
  // 放在 COPY 之后的话，即使 commit 变了也不会重建静态资源层 —— 那正是
  // 「重建了但线上还是旧 app.js」的成因。
  const labelIndex = dockerfile.search(/LABEL\s+org\.opencontainers\.image\.revision/);
  const copyPublicIndex = dockerfile.search(/COPY[^\n]*public\s+\.\/public/);
  assert.ok(copyPublicIndex !== -1, "Dockerfile 应包含 COPY public ./public");
  assert.ok(
    labelIndex < copyPublicIndex,
    "commit 标签必须排在 COPY public 之前，否则静态资源层不会随提交失效",
  );
});

test("start.sh 构建时传入当前 commit，并在启动后核对容器实际版本", async () => {
  const script = await read("../start.sh");

  assert.match(
    script,
    /git\s+rev-parse\s+(HEAD|--short\s+HEAD)/,
    "start.sh 必须取当前 commit，作为构建参数与核对基准",
  );
  assert.match(
    script,
    /--build-arg\s+GIT_COMMIT/,
    "start.sh 必须把 commit 传给 docker build，否则镜像无法自述版本",
  );
  assert.match(
    script,
    /org\.opencontainers\.image\.revision/,
    "start.sh 必须在启动后回读容器镜像的 revision 标签",
  );
  // 核心断言：版本不一致必须报错退出，而不是静默跑旧代码。
  assert.match(
    script,
    /不一致|不匹配|mismatch/i,
    "start.sh 发现运行版本与当前 commit 不一致时必须明确报错",
  );
});

test("start.sh 重新部署时会替换既有容器，而不是只重启它", async () => {
  const script = await read("../start.sh");

  // up -d 对已存在的容器只做「确保它在跑」，不会用新镜像替换容器。
  // 这是本次事故的直接成因之一，必须显式要求重建容器。
  assert.match(
    script,
    /--force-recreate/,
    "start.sh 必须用 --force-recreate 替换容器，否则新镜像不会生效",
  );
});

test("start.sh 会真正执行 chown，而不是只在警告文本里提一句", async () => {
  // 事故：数据目录从 docker volume 改成宿主绑定目录后，./data 由 docker 以 root
  // 创建，而容器以 uid 1000 运行，应用启动时 mkdir /data/output 报 EACCES，
  // 容器进入 Restarting 循环。原来的实现只在 warn 文本里写着
  // "sudo chown -R 1000:1000 data"，并不真正执行，等于放行了崩溃。
  //
  // 因此这个断言必须先剔除所有 warn/echo 行，再看剩下的代码里有没有 chown。
  // volume 时代不会出这个问题：docker 会把 volume 属主设成镜像里 /data 的属主。
  const script = await read("../start.sh");

  const executableLines = script
    .split("\n")
    .filter((line) => !/^\s*(warn|info|echo|#)/.test(line))
    .join("\n");

  assert.match(
    executableLines,
    /chown\s+(-R\s+)?[\"']?1000:1000/,
    "start.sh 必须真正执行 chown，只在 warn 里写提示不算修复",
  );
});

test("start.sh 修不了属主时会中止，而不是启动一个注定崩溃的容器", async () => {
  const script = await read("../start.sh");
  const executableLines = script
    .split("\n")
    .filter((line) => !/^\s*(warn|info|echo|#)/.test(line))
    .join("\n");

  // 非 root 且 chown 失败时必须 fail，不能继续 up 出一个 EACCES 循环。
  assert.match(
    executableLines,
    /fail\s+[\s\S]{0,200}(属主|chown|permission|EACCES)/i,
    "属主无法修正时必须中止启动",
  );
});

test("compose 不把数据目录写成 docker volume", async () => {
  // 用户明确要求持久化一律用宿主目录绑定，不用 docker volume。
  const compose = await read("../compose.yml");
  assert.doesNotMatch(
    compose,
    /^\s*-\s*studio-data:\/data/m,
    "数据目录不得回到 docker volume 形式",
  );
  assert.match(compose, /\$\{DATA_DIR:-\.\/data\}:\/data/, "数据目录应为 ${DATA_DIR:-./data} 绑定挂载");
});

test("STUDIO_CONTAINER_NAME 必须真正决定容器名，而不是被 compose 硬编码覆盖", async () => {
  // 事故：在 .env 里设 STUDIO_CONTAINER_NAME=aeboli-gpt-image2-studio 后毫无效果，
  // 因为 compose.yml 里 container_name 写死了 gpt-image2-studio。用户配了变量却
  // 不生效，比没有这个变量更糟 —— 会让人误以为已经切换过去了。
  const compose = await read("../compose.yml");

  assert.match(
    compose,
    /container_name:\s*\$\{STUDIO_CONTAINER_NAME:-/,
    "container_name 必须读 STUDIO_CONTAINER_NAME（带默认值），不能写死",
  );
  assert.doesNotMatch(
    compose,
    /^\s*container_name:\s*gpt-image2-studio\s*$/m,
    "container_name 不得硬编码为固定名字",
  );
  // 项目名同理：写死的话 两套部署仍然无法互相替换。
  assert.match(
    compose,
    /^name:\s*\$\{STUDIO_CONTAINER_NAME:-/m,
    "顶层 name 也应跟随 STUDIO_CONTAINER_NAME，否则项目名与容器名会分叉",
  );
});

test("start.sh 的版本核对与自检必须使用配置的容器名", async () => {
  // 事故：start.sh 里 docker inspect / docker exec 全部硬编码 gpt-image2-studio，
  // 于是即便容器真叫别的名字，校验也在查一个不相干的容器 —— 校验形同虚设。
  const script = await read("../start.sh");

  assert.doesNotMatch(
    script,
    /docker\s+inspect\s+gpt-image2-studio/,
    "docker inspect 不得硬编码容器名，必须用 STUDIO_CONTAINER_NAME",
  );
  assert.doesNotMatch(
    script,
    /docker\s+exec\s+gpt-image2-studio/,
    "docker exec 不得硬编码容器名，必须用 STUDIO_CONTAINER_NAME",
  );
});
