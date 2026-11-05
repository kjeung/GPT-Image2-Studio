import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectRootDir = resolve(scriptsDir, "..");

const windows = process.platform === "win32";
const MIN_POWERSHELL_VERSION = [7, 4];

/**
 * Linux 预期跳过清单。
 *
 * 上游 CI 跑 `windows-latest`，本仓库跑 Linux，这是唯一实质差异。以下测试在 Linux 上**必然**无法执行，
 * 全部用 `{ skip: !windows }` 表达，因此它们在 TAP 里是 `# SKIP` 而不是失败——`npm test` 的失败数
 * 于是重新有意义：**任何失败都是真回归**。
 *
 * 这些项不改成「条件编译后假装通过」，因为它们断言的是 Windows 专有产物：
 *
 * 1. PowerShell 七例：`pwsh.exe` 是 Windows 命令，脚本本身声明 `#Requires -Version 7.4` 且断言
 *    `$IsWindows`、注册表路径与 `.cmd` 包装器转发。Linux 上既无 `pwsh.exe` 也无注册表，
 *    **不改则永远无法通过**（除非换平台，而换平台不是代码改动能解决的）。
 * 2. 原生剪贴板宿主三例：`lib/product-image-native-host-build.mjs` 在非 win32 上直接
 *    `throw new Error("商品图本地剪贴板助手只能在 Windows 上构建。")`。它要调用 Windows 的 C#
 *    编译器与 `Clipboard.SetFileDropList` / STA 线程模型，**不改则永远无法通过**。
 * 3. 采集包两例（API 端点与归档）：两者都间接调用同一个 `buildProductImageClipboardHost`，
 *    归档里必须内嵌 `native-host/ProductImageClipboardHost.exe`。API 例的失败甚至不是它自己的
 *    断言——端点返回 500 JSON，JSZip 再去解这个 JSON 才报 "Can't find end of central directory"。
 *    即三例与两例共因，不是五个独立缺陷。
 *
 * 增删本清单必须与测试文件里的 `skip` 同步：脚本会校验实际跳过集合与本清单**逐项相等**，
 * 多一个（可能掩盖真回归）或少一个（清单过期）都会打红。
 */
export const EXPECTED_LINUX_SKIPS = [
  {
    name: "owned PowerShell scripts parse and declare the Windows 7.4 boundary",
    reason: "依赖 pwsh.exe 解析 *.ps1 的 AST 并断言 #Requires -Version 7.4",
  },
  {
    name: "CMD wrappers forward quoted arguments, preserve failures and reject missing prerequisites",
    reason: "依赖 Windows .cmd 包装器与 cmd.exe 参数转发",
  },
  {
    name: "launcher executes discovery, environment isolation, readiness and error paths without opening a browser",
    reason: "依赖 Windows 启动器脚本与 pwsh.exe",
  },
  {
    name: "launcher resolves relative Root after Set-Location and starts a healthy Node child",
    reason: "依赖 Windows 启动器脚本与 pwsh.exe",
  },
  {
    name: "Native Messaging install and uninstall use isolated filesystem and intercepted registry calls",
    reason: "依赖 Windows 注册表与 PowerShell 安装脚本",
  },
  {
    name: "asset generator works from another directory and reports missing output and Node failure",
    reason: "依赖 Windows 资产生成脚本与 pwsh.exe",
  },
  {
    name: "installer fallback uses PS7 and expands quoted paths without executing path contents",
    reason: "依赖 Windows 安装器回退脚本与 pwsh.exe",
  },
  {
    name: "local collector package endpoint returns a valid attachment ZIP",
    reason: "端点内嵌 Windows 原生宿主；非 Windows 返回 500 JSON，JSZip 解包即失败",
  },
  {
    name: "extension ZIP contains reviewable sources and the exact shared import protocol",
    reason: "归档必须内嵌 ProductImageClipboardHost.exe，构建器在非 win32 拒绝",
  },
  {
    name: "compiled native host dispatches clipboard work to STA after asynchronous preparation",
    reason: "需编译并运行 .exe，构建器在非 win32 拒绝",
  },
  {
    name: "compiled native host rejects non-copy commands through the framed protocol",
    reason: "需编译并运行 .exe，构建器在非 win32 拒绝",
  },
];

// 匹配 TAP 结果行时同时允许缩进（嵌套子测试）与 `# SKIP 理由` 这种带理由的跳过，
// 否则带理由的跳过两边都不算，会被当成普通通过——正是本清单要防的静默放行。
const TAP_RESULT_LINE = /^\s*(?:not )?ok\s+\d+\s+-\s+(.*)$/u;

function tapResults(tap) {
  const ok = [];
  const notOk = [];
  const skipped = [];
  const todo = [];
  for (const line of tap.split(/\r?\n/u)) {
    const match = TAP_RESULT_LINE.exec(line);
    if (!match) {
      continue;
    }
    const notOkLine = /^\s*not ok\s+/u.test(line);
    // 去掉 `# SKIP 理由` / `# TODO` 这类指令，只留测试名做身份比对。
    const directive = /\s+#\s+(SKIP|TODO)\b\s*(.*)$/u.exec(match[1]);
    const name = (directive ? match[1].slice(0, directive.index) : match[1]).trim();
    if (directive) {
      (directive[1] === "SKIP" ? skipped : todo).push(name);
    }
    if (notOkLine) {
      notOk.push(name);
    } else {
      ok.push(name);
    }
  }
  return { ok, notOk, skipped, todo };
}

function tapFailures(tap) {
  return tapResults(tap).notOk;
}

function tapSummary(tap, field) {
  const match = new RegExp(`^# ${field} (\\d+)$`, "mu").exec(tap);
  return match ? Number(match[1]) : null;
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: projectRootDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || error.message || ""),
    };
  }
}

function describeFailure(result) {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  const line = text
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith("npm warn") && !entry.startsWith("npm notice"));
  return line ? line.slice(0, 400) : `退出码 ${result.code}`;
}

async function checkPowerShellRuntime() {
  const version = await run("pwsh", ["--version"]);
  if (version.code !== 0) {
    return {
      status: "not-applicable",
      detail: "Linux 上无 pwsh.exe；上游这道关卡在本平台不可执行，非代码缺陷",
    };
  }
  const parsed = /(\d+)\.(\d+)/u.exec(version.stdout);
  if (!parsed) {
    return { status: "fail", detail: `无法解析 pwsh 版本：${describeFailure(version)}` };
  }
  const actual = [Number(parsed[1]), Number(parsed[2])];
  const ok = actual[0] > MIN_POWERSHELL_VERSION[0]
    || (actual[0] === MIN_POWERSHELL_VERSION[0] && actual[1] >= MIN_POWERSHELL_VERSION[1]);
  return ok
    ? { status: "pass", detail: `pwsh ${version.stdout.trim()}` }
    : { status: "fail", detail: `pwsh ${version.stdout.trim()} 低于 7.4` };
}

export async function verifyCiGates({ install = false } = {}) {
  const packageJson = JSON.parse(await readFile(join(projectRootDir, "package.json"), "utf8"));
  const testScript = String(packageJson.scripts?.test || "");
  const concurrencyAligned = testScript.includes("--test-concurrency=1");

  const results = [];

  // 默认只做 --dry-run：`npm ci` 会先删掉 node_modules 再装，装失败会把后面的关卡全部打成无关的红。
  // 需要真正重装时传 --install。共享工作树里绝不要顺手跑一次真装。
  const installArgs = ["ci", "--no-audit", "--no-fund", ...(install ? [] : ["--dry-run"])];
  const installResult = await run("npm", installArgs);
  results.push({
    gate: "Install locked dependencies",
    ...(installResult.code === 0
      ? { status: "pass", detail: install ? "npm ci 完成" : "锁文件与依赖一致（--dry-run；传 --install 可真正重装）" }
      : { status: "fail", detail: describeFailure(installResult) }),
  });

  const powerShell = await checkPowerShellRuntime();
  results.push({ gate: "Check PowerShell runtime", ...powerShell });

  const dependenciesReady = await run("node", ["-e", "require.resolve('jszip')"]);
  if (dependenciesReady.code !== 0) {
    results.push({
      gate: "Run serial test suite",
      status: "blocked",
      detail: "node_modules 不可用，测试无法执行；先修好依赖安装再判定本关卡",
    });
  } else {
  const tests = await run("node", [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=tap",
    "./test/*.test.mjs",
  ]);
  const parsed = tapResults(tests.stdout);
  const failures = parsed.notOk;
  const skips = parsed.skipped;
  const total = tapSummary(tests.stdout, "tests");
  const expected = windows ? [] : EXPECTED_LINUX_SKIPS.map((entry) => entry.name);
  const unexpectedSkips = skips.filter((name) => !expected.includes(name));
  const missingSkips = expected.filter((name) => !skips.includes(name));
  // 退出码同样是判据：TAP 文本里逃过解析的异常（崩溃、语法错、子进程被杀）只能靠退出码发现。
  const exitMismatch = tests.code !== 0 && failures.length === 0;
  const suiteOk = failures.length === 0
    && unexpectedSkips.length === 0
    && missingSkips.length === 0
    && !exitMismatch;
  const detail = suiteOk
    ? `${total} 例，0 失败，${skips.length} 例按清单跳过${parsed.todo.length ? `，${parsed.todo.length} 例 TODO` : ""}`
    : [
      failures.length ? `失败 ${failures.length} 例：${failures.join("；")}` : "",
      unexpectedSkips.length ? `清单外跳过：${unexpectedSkips.join("；")}` : "",
      missingSkips.length ? `清单内未跳过：${missingSkips.join("；")}` : "",
      exitMismatch ? `退出码 ${tests.code} 但 TAP 未见失败：${describeFailure(tests)}` : "",
    ].filter(Boolean).join(" | ");
  results.push({ gate: "Run serial test suite", status: suiteOk ? "pass" : "fail", detail });
  }

  const sync = await run("npm", ["run", "sync:public-lib", "--", "--check"]);
  results.push({ gate: "Check shared browser modules", ...(sync.code === 0
    ? { status: "pass", detail: sync.stdout.trim().split(/\r?\n/u).pop() || "同步检查通过" }
    : { status: "fail", detail: describeFailure(sync) }) });

  const release = await run("npm", ["run", "check:release"]);
  results.push({ gate: "Check release facts", ...(release.code === 0
    ? { status: "pass", detail: release.stdout.trim().split(/\r?\n/u).pop() || "发布检查通过" }
    : { status: "fail", detail: describeFailure(release) }) });

  const openspec = await run("npx", ["--no-install", "openspec", "validate", "--all", "--strict"]);
  results.push({ gate: "Validate OpenSpec", ...(openspec.code === 0
    ? { status: "pass", detail: openspec.stdout.trim().split(/\r?\n/u).pop() || "OpenSpec 校验通过" }
    : { status: "fail", detail: describeFailure(openspec) }) });

  const whitespace = await run("git", ["diff", "--check"]);
  results.push({ gate: "Check whitespace", ...(whitespace.code === 0
    ? { status: "pass", detail: "无空白错误" }
    : { status: "fail", detail: describeFailure(whitespace) }) });

  const drift = await run("git", ["diff", "--exit-code"]);
  results.push({ gate: "Reject tracked generated drift", ...(drift.code === 0
    ? { status: "pass", detail: "无生成物漂移" }
    : { status: "fail", detail: describeFailure(drift) }) });

  return {
    results,
    concurrencyAligned,
    failures: results.filter((entry) => entry.status === "fail"),
    blocked: results.filter((entry) => entry.status === "blocked"),
    notApplicable: results.filter((entry) => entry.status === "not-applicable"),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    const report = await verifyCiGates({ install: process.argv.includes("--install") });
    for (const entry of report.results) {
      const marker = { pass: "✓", fail: "✗", blocked: "⊘" }[entry.status] || "—";
      console.log(`${marker} ${entry.gate}：${entry.detail}`);
    }
    if (!report.concurrencyAligned) {
      console.error("package.json 的 test 脚本必须保留 --test-concurrency=1（与上游一致）");
      process.exitCode = 1;
    }
    if (report.failures.length || report.blocked.length) {
      const parts = [];
      if (report.failures.length) parts.push(`${report.failures.length} 道关卡失败`);
      if (report.blocked.length) parts.push(`${report.blocked.length} 道关卡无法判定`);
      console.error(`\n${parts.join("，")}`);
      process.exitCode = 1;
    } else {
      const note = report.notApplicable.length
        ? `（${report.notApplicable.map((entry) => entry.gate).join("、")} 在本平台不适用）`
        : "";
      console.log(`\n八道关卡通过${note}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
