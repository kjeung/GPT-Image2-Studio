# Linux 上的 CI 关卡与预期跳过清单

上游 `aEboli/GPT-Image2-Studio` 的 `.github/workflows/ci.yml` 跑 `windows-latest`。本仓库的开发与验证在 Linux 上进行，**平台差异是唯一实质差异**。这份文档记录八道关卡在本平台的实际结果，以及每一例预期跳过的原因。

判定口径：**失败数恒为 0**。任何失败都是真回归，不再有「已知的 4 个红」这种需要人工比对的状态。

## 一条命令跑完八道关卡

```bash
npm run verify:ci           # 默认：关卡 1 只做 npm ci --dry-run，不动 node_modules
npm run verify:ci -- --install   # 真重装依赖后跑完整八道关卡
```

脚本逐道执行上游 CI 的关卡，打印通过/失败，并把三种非通过状态分开：

- `fail`：真回归，退出码非 0。
- `blocked`：前置条件缺失（如 `node_modules` 不可用），本关卡无法判定，同样退出码非 0。
- `not-applicable`：本平台不可执行，不算失败，但会单独列出。

**关卡 1 默认用 `npm ci --dry-run`**，因为它会先删掉 `node_modules` 再装：装失败时，后面每道关卡都会跟着红成一片无关噪音，把「哪道关卡真的坏了」淹掉。`--dry-run` 仍然校验锁文件与 `package.json` 一致，足以承担这道关卡的本意；要真正重装依赖时显式传 `--install`。

**关卡 8 要求工作树干净**，因为它比对索引与工作树。所以「八道关卡全绿」只在提交之后成立；有未提交改动时它必然红，这是关卡本身的设计，不是缺陷。

## 八道关卡逐条结果

| # | 上游 CI 关卡 | 本平台执行 | Linux 结果 |
|---|---|---|---|
| 1 | Install locked dependencies | `npm ci --dry-run`（`--install` 可真装） | 通过 |
| 2 | Check PowerShell runtime | `pwsh --version` ≥ 7.4 | **不适用**（无 `pwsh`，见下） |
| 3 | Run serial test suite | `npm test` + TAP 解析 | 通过，0 失败，11 例按清单跳过 |
| 4 | Check shared browser modules | `npm run sync:public-lib -- --check` | 通过（134 模块） |
| 5 | Check release facts | `npm run check:release` | 通过 |
| 6 | Validate OpenSpec | `npx --no-install openspec validate --all --strict` | 通过 68/68 |
| 7 | Check whitespace | `git diff --check` | 通过 |
| 8 | Reject tracked generated drift | `git diff --exit-code` | 通过（需工作树干净） |

### 第 2 道关卡为什么是「不适用」而不是「失败」

上游在 `windows-latest` 上断言 `$PSVersionTable.PSVersion` ≥ 7.4，且 CI 的每个 step 都以 `pwsh` 为 shell。Linux 上没有 `pwsh.exe`，这道关卡**不可执行**，而不是执行后失败。把它记成失败会让「八道关卡是否通过」这个问题失去答案；把它记成通过则是假的。脚本用第三种状态 `not-applicable` 表达，并要求其余七道全部通过。

若在 Linux 上装了 PowerShell 7.4+ 且 `pwsh --version` 可正常执行，这一道会自动转为真实校验。

## 预期跳过清单

全部用测试框架的 `{ skip: !windows }` 表达，与仓库既有的 `test/windows-powershell.test.mjs` 用法一致。它们在 TAP 里是 `# SKIP`，**不计入失败**。

### 一、PowerShell 七例（`test/windows-powershell.test.mjs`）

依赖 `pwsh.exe` 解析 `*.ps1` 的 AST、断言 `#Requires -Version 7.4`、`$IsWindows`、注册表路径，以及 `.cmd` 包装器的参数转发。

**不改则永远无法通过**：这些断言的被测对象是 Windows 专有的，Linux 上既无 `pwsh.exe` 也无注册表。不是「跑得慢」或「环境没装好」，是平台不存在。

### 二、原生剪贴板宿主三例

| 测试文件 | 测试名 |
|---|---|
| `test/product-image-native-host.test.mjs` | compiled native host dispatches clipboard work to STA after asynchronous preparation |
| `test/product-image-native-host.test.mjs` | compiled native host rejects non-copy commands through the framed protocol |
| `test/product-image-extension-package.test.mjs` | extension ZIP contains reviewable sources and the exact shared import protocol |

`lib/product-image-native-host-build.mjs` 在非 win32 上直接抛 `商品图本地剪贴板助手只能在 Windows 上构建。`。它要调用 Windows 的 C# 编译器，产物 `ProductImageClipboardHost.exe` 依赖 `Clipboard.SetFileDropList` 与 STA 线程模型。

**不改则永远无法通过**：需要 Windows 编译期与运行期 API。

### 三、采集包 API 端点一例（`test/product-image-api.test.mjs`）

`local collector package endpoint returns a valid attachment ZIP`

**与上面三例同因**，不是第四个独立缺陷：端点 `/api/product-image-collector/package` 内嵌同一个 `.exe`，构建失败后返回 **500 JSON**，测试把这段 JSON 交给 JSZip，于是报 `Can't find end of central directory`。表面上是「ZIP 解包失败」，实质仍是同一个 Windows 构建门。

**不改则永远无法通过**：同一个构建门。

## 维护规则

增删跳过项必须**同时**改测试文件里的 `skip` 与 `scripts/verify-ci-gates.mjs` 的 `EXPECTED_LINUX_SKIPS`。脚本会校验实际跳过集合与该清单**逐项相等**：

- 清单外出现跳过 → 打红（可能掩盖真回归）
- 清单内没有跳过 → 打红（清单过期，或有人去掉了 `skip`）

这条约束是「失败数有意义」的保障：它不允许悄悄新增跳过，也不允许清单与代码脱节。

脚本解析 TAP 时，同时盯住四类行，任一异常都打红：

- `not ok N - 名字`（含嵌套子测试、含带 `# TODO` 的失败）
- `ok N - 名字 # SKIP`，**含 `# SKIP 理由` 写法**——早先的实现用 `^...$` 锚定，带理由的跳过两边都不算，会被当成普通通过，这是本清单要防的静默放行，已修
- 缩进的嵌套结果行
- 测试进程退出码非 0 但 TAP 里没有失败行（崩溃、语法错、子进程被杀只能靠退出码发现）

## 已核对但无需改动的一项

工单 Notes 提到「顺带把 `package.json` 的 `test` 脚本对齐上游的 `--test-concurrency=1`」。实测**上游 `aEboli/GPT-Image2-Studio` 的 `package.json` 与本仓库 `package.json:23` 已逐字一致**，无需改动。脚本会校验该参数仍然存在，防止将来被误删。
