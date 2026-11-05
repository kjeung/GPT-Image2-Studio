# Fork 版本身份：semver 优先级 / npm / git tag / shields.io

- **基线**：`v0.2.116` = 上游 `7b7f8f6`；本分支 HEAD `cc95929`（`legacy-v0.2.116`）
- **问题**：fork 在上游 `0.2.116` 之上叠补丁，需在 package.json、tag、release、UI badge 四处区分自己
- **本文只给事实与约束，不给推荐**。外部结论附一手来源，仓库内结论附文件行号或实测命令

## 0. 结论速览

| 拼写 | 合法 semver | 相对 `0.2.116` 的 precedence |
|---|---|---|
| `0.2.116-fork.1` | 是（pre-release） | **低于** → 更旧 |
| `0.2.116+fork.1` | 是（build metadata） | **相等** → 排序上不区分 |
| `0.2.117-fork.1` | 是（pre-release） | 高于 `0.2.116`，低于 `0.2.117` |
| `0.2.117` | 是（normal version） | **高于** → 更新 |

排序实测：`0.2.116-fork.1 < 0.2.116-fork.2 < 0.2.116 == 0.2.116+fork.1 < 0.2.117-fork.1 < 0.2.117`

**关键事实**：能让版本"变新"的只有 major/minor/patch 数字。连字符后辍是 pre-release，规范明文排在关联正式版**之前**；加号后辍是 build metadata，规范明文**不参与** precedence。

---

## 1. Semantic Versioning 2.0.0 规则 9 / 10 / 11

来源 <https://semver.org/>（规范正文 11 条，§1 = "MUST declare a public API"，故 pre-release 为 spec-item-9、build 为 10、precedence 为 11）：锚点 <https://semver.org/#spec-item-9>、<#spec-item-10>、<#spec-item-11>。

### 1.1 规则 9 —— 连字符 = pre-release

> "A pre-release version MAY be denoted by appending a hyphen and a series of dot separated identifiers immediately following the patch version. Identifiers MUST comprise only ASCII alphanumerics and hyphens [0-9A-Za-z-]. Identifiers MUST NOT be empty. Numeric identifiers MUST NOT include leading zeroes. **Pre-release versions have a lower precedence than the associated normal version.**"

`0.2.116-fork.1`：`fork` 是合法字母标识符，`1` 是合法无前导零数字标识符 → **合法 pre-release**，且按引文末句 **低于** `0.2.116`。

### 1.2 规则 10 —— 加号 = build metadata，且被 precedence 忽略

> "Build metadata MAY be denoted by appending a plus sign and a series of dot separated identifiers immediately following the patch or pre-release version. … Identifiers MUST NOT be empty. **Build metadata MUST be ignored when determining version precedence. Thus two versions that differ only in the build metadata, have the same precedence.**"

即 `0.2.116+fork.1` 与 `0.2.116` **precedence 相等**；排序器无法用加号后辍把 fork 认成"更新"。

规范附录 BNF 显示连字符段与加号段可并存：`<valid semver> ::= <version core> | <version core> "-" <pre-release> | <version core> "+" <build> | <version core> "-" <pre-release> "+" <build>` —— 但只有连字符段影响 precedence。

### 1.3 规则 11 —— precedence 算法

> "11.1 Precedence MUST be calculated by separating the version into major, minor, patch and pre-release identifiers in that order (**Build metadata does not figure into precedence**)."
> "11.2 … **Major, minor, and patch versions are always compared numerically.** Example: 1.0.0 < 2.0.0 < 2.1.0 < 2.1.1."
> "11.3 **When major, minor, and patch are equal, a pre-release version has lower precedence than a normal version**: Example: 1.0.0-alpha < 1.0.0."
> "11.4 … Digits are compared numerically; letters/hyphens are compared lexically in ASCII sort order; numeric identifiers always have lower precedence than non-numeric; a larger set of pre-release fields has higher precedence if all preceding identifiers are equal. Example: 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0."

### 1.4 node-semver 实测（npm 自带实现，非第三方）

```
node -e 'const s=require("/usr/local/lib/node_modules/npm/node_modules/semver"); ...'
```

| A | B | `compare`（规范） | `compareBuild`（把 build 当同分排序键） |
|---|---|---|---|
| `0.2.116-fork.1` | `0.2.116` | -1 | -1 |
| `0.2.116+fork.1` | `0.2.116` | **0** | +1 |
| `0.2.117-fork.1` | `0.2.116` | +1 | +1 |
| `0.2.117` | `0.2.117-fork.1` | +1 | +1 |

`compareBuild` 是 node-semver 的非规范扩展（README："The same as `compare` but considers `build` when two versions are equal"），**默认排序用的是 `compare`**。

### 1.5 `v` 前缀不是 semver

semver.org FAQ <https://semver.org/#is-v123-a-semantic-version>：

> "No, 'v1.2.3' is not a semantic version. However, prefixing a semantic version with a 'v' is a common way … Example: `git tag v1.2.3 -m "Release version 1.2.3"`, in which case 'v1.2.3' is a tag name and the semantic version is '1.2.3'."

---

## 2. npm 的 `version` 字段

来源：npm CLI package.json 文档（官方仓库 markdown 源）
<https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/package-json.md>（站点页 <https://docs.npmjs.com/cli/v10/configuring-npm/package-json>）

> "**Version must be parseable by node-semver**, which is bundled with npm as a dependency."
> "If you don't plan to publish your package, the name and version fields are optional."

npm **不自定义格式**，校验完全委托 node-semver；后者接受 pre-release 与 build metadata（README 文法 `qualifier ::= ( '-' pre )? ( '+' build )?`，<https://github.com/npm/node-semver#readme>）：

> "Prerelease identifiers use `nr` … which disallows leading zeros (e.g. `1.2.3-00` is invalid). Build metadata identifiers allow any alphanumeric string including leading zeros (e.g. `1.2.3+00` is valid)."

**归一化实测**（这是加号后辍的实际风险）：

| 输入 | `semver.valid()` | `semver.clean()` |
|---|---|---|
| `0.2.116` | `0.2.116` | `0.2.116` |
| `0.2.116-fork.1` | `0.2.116-fork.1` | `0.2.116-fork.1` |
| `0.2.116+fork.1` | **`0.2.116`** | **`0.2.116`** |

node-semver 认为 `+fork.1` 合法，但其规范形式**丢掉 build metadata**。任何"写盘前先归一化"的工具链会把加号后辍抹平；连字符后辍被完整保留。

**本仓库是否受 npm registry 规则约束**：`package.json:4` `"private": true`；npm 文档同页 `## private` 段 "npm will refuse to publish it"；`npm run` 无 publish 脚本；`.github/workflows/ci.yml` 只跑 `npm run check:release`；`grep -rn 'npm publish|publishConfig' .github scripts package.json` 无命中。→ **不发 npm，registry 规则不约束分发**；但 node-semver 可解析性仍是通用前提。

---

## 3. git tag 与 GitHub Release 字符规则

### 3.1 git-check-ref-format

来源 <https://git-scm.com/docs/git-check-ref-format>（tag 存于 `refs/tags/`）。原文规则：

> "They cannot have **two consecutive dots `..`** anywhere."
> "They cannot have ASCII control characters (i.e. bytes whose values are lower than \040, or \177 DEL), space, tilde `~`, caret `^`, or colon `:` anywhere."
> "They cannot have **question-mark `?`, asterisk `*`, or open bracket `[`** anywhere."
> "They cannot begin or end with a slash `/` or contain multiple consecutive slashes."
> "They cannot **end with a dot `.`**."
> "They cannot contain a sequence **`@{`**."
> "They cannot be the single character `@`."
> "They cannot contain a backslash **`\`**."

禁止项不含 `-`、`+`、`_`。

### 3.2 本机实测（git 2.39.5）

```
git check-ref-format refs/tags/v0.2.116-fork.1   → OK
git check-ref-format refs/tags/v0.2.116+fork.1   → OK
git check-ref-format refs/tags/v0.2.117          → OK
git check-ref-format refs/tags/v0.2.116_fork.1   → OK
```

四个候选全部合法。

### 3.3 GitHub Release

<https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>：

> "**Releases are based on Git tags**, which mark a specific point in your repository's history."

创建即 `gh release create TAG`（<https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository>）。GitHub 不额外加字符限制，也不解释 semver 优先级——tag 就是字符串。

### 3.4 tag 默认排序不是 semver

本仓库 `git tag -l 'v0.2*'` 实测输出 `v0.2.10, v0.2.106, v0.2.11, v0.2.116, v0.2.12 …` = **refname 字典序**。<https://git-scm.com/docs/git-tag> 原文："Sort order defaults to the value configured for the `tag.sort` variable if it exists, or **lexicographic order** otherwise." 要版本序须显式 `--sort=v:refname`（"tag names are treated as versions"），且该排序器按数字段比较，不实现 semver 的 pre-release/build 规则。
现状：`v0.2.116` 指向 `7b7f8f6`；本分支 HEAD `cc95929` 上 `git tag --points-at HEAD` 为空。

---

## 4. shields.io 静态 badge 转义

来源 <https://shields.io/badges/static-badge>：

> "The static badge accepts a single required path parameter which encodes either: **Label, message and color separated by a dash `-`**… Message and color only, separated by a dash `-`."

转义表（同页 "URL input / Badge output"）：

> "**Underscore `_` or `%20`** → Space"
> "**Double underscore `__`** → Underscore `_`"
> "**Double dash `--`** → Dash `-`"

即 path 里 `-` 是字段分隔符，字面连字符须写 `--`。现有 README badge `…/badge/version-v0.2.116-2563eb.svg` 正是 label=`version` / message=`v0.2.116` / color=`2563eb` 三段。

**实测（直接请求 img.shields.io，读渲染出的 SVG `<text>`）**：

| badge path | 渲染 |
|---|---|
| `version-v0.2.116-fork.1-2563eb` | **404 "badge not found"** |
| `version-v0.2.116--fork.1-2563eb` | message `v0.2.116-fork.1` ✅ |
| `version-v0.2.116+fork.1-2563eb` | message `v0.2.116+fork.1` ✅ |
| `version-v0.2.116%2Bfork.1-2563eb` | message `v0.2.116+fork.1` ✅ |

→ 含连字符的版本串**必须**写 `--`，否则 404；`+` **无需转义**（字面或 `%2B` 均可）。

---

## 5. 主流 fork 的真实命名先例

下列 ref 均由 `git ls-remote --tags` 实测取得，可用 URL 复核。

| 项目（fork 关系） | 实际 tag | 手法 | 证据 |
|---|---|---|---|
| **k3s**（fork of Kubernetes） | `v1.29.8+k3s1`、`v1.29.9-rc2+k3s1` | patch 数字 + **加号 build metadata**；pre-release 置于加号之前 | <https://github.com/k3s-io/k3s/releases/tag/v1.29.8%2Bk3s1> |
| **RKE2**（fork of Kubernetes） | `v1.37.2+rke2r1`、`v1.37.2-rc1+rke2r1` | 同上，加号后辍带 fork 名与计数 | <https://github.com/rancher/rke2/releases> |
| **Git for Windows**（fork of Git） | `v2.49.1.windows.1` | **点追加 fork 段**（避开连字符，避免变 pre-release） | <https://github.com/git-for-windows/git/releases> |
| **VSCodium**（fork of VS Code） | `1.99.32846` | **在 patch 位后追加构建号** | <https://github.com/VSCodium/vscodium/releases> |
| **Forgejo**（fork of Gitea） | `v9.0.3`、`v9.0.0-dev` | **另起主版本号线**，不挂后辍 | <https://codeberg.org/forgejo/forgejo> |

可观察分布：五例中三例（k3s、RKE2、Git for Windows）刻意**不用**连字符标识"同上游版本之上的 fork 补丁"——与 §1 的规范结论一致。Forgejo 换主版本线以获得真正的"更新"；VSCodium 牺牲 semver 精度换数值递增。

---

## 6. 本仓库既有的硬性契约（事实）

| 约束 | 位置 | 内容 |
|---|---|---|
| 版本正则 | `scripts/versioning.mjs` `VERSION_PATTERN` | `^(\d+)\.(\d+)\.(\d{1,3})$` —— **任何后辍直接 throw** |
| 三位补零 | 同文件 `formatVersion` | `padStart(3,"0")`；`patch > 999` 抛错 |
| 发布就绪 | `scripts/check-release-readiness.mjs:259` | `assertCanonicalVersion(version)`（version 取自 package.json） |
| 锁文件 | 同上 `:264-265` | `package-lock.json` 的 `version` 与 `packages[""].version` 必须一致 |
| 版本事实行 | 同上 `:269-297` | `README.md` / `README.zh-CN.md` 的 `Current version:` / `当前版本：` 必须等于 `v<version>`；`docs/releases/v<version>.md` 必须存在且首行标题匹配 |
| 事实正则 | 同上 | 事实行/exe 名/发布链接的捕获组为 `[0-9A-Za-z.+-]+`，可容后辍 |
| 徽章事实 | `scripts/version-facts.mjs` | README 模板仅 `[v{version}](./docs/releases/v{version}.md)` 与 `v{version}` GitHub Release 两条；**shields badge 行不在模板内** |
| UI 徽章 | `public/index.html:129` | `<small class="app-version" aria-label="当前版本 v0.2.116">v0.2.116</small>`；`requireWorkbenchVersionElement` 要求文本逐字等于 `v<version>` |
| 规范 | `openspec/specs/application-versioning/spec.md` | "SHALL use `major.minor.patch` … `patch` rendered as exactly three digits"；scenario 要求非规范版本"fails with a version-format error" |
| tag 现状 | `git rev-parse v0.2.116^{commit}` | `7b7f8f6`（上游提交）；`cc95929` 无 tag |
| 分发 | `package.json` | `"private": true`，无 publish 脚本，CI 无发布 |

**两处口径不一致（陈述事实）**：
1. 版本事实行的捕获组 `[0-9A-Za-z.+-]+` 容得下后辍，但同一个检查里 `package.json version` 用的 `VERSION_PATTERN` 不容——前半段允许、后半段禁止。
2. `README.md` 的 shields.io badge 不在维护模板中，`check:release` **不会**因 badge 写着旧版本而报错（`version-facts.mjs` 顶部注释说明该模板是为修 v0.2.10 的漂移而设，但 badge 始终未纳入）。

---

## 7. 任何决策都必须满足的事实约束

1. **"更新"只能靠数字**：规则 11.2 只让 major/minor/patch 数值差异提高 precedence；连字符后辍（规则 9）**降低**、加号后辍（规则 10）**不参与**。要求"排序上比上游新"⇒ 字符串须落在 `>= 0.2.117` 一侧；`0.2.116-…` 与 `0.2.116+…` 都不满足（后者仅 `compareBuild` 扩展下微新）。
2. **package.json 是双重门**：既要能被 node-semver 解析（npm docs），又要过本仓库 `VERSION_PATTERN`（纯三位 `X.Y.Z`）。两者重叠区只有纯三段数字。
3. **改 package.json 连锁三处**：`package-lock.json` 两处 version、`public/index.html` 的 `app-version` 文本与 aria-label、`docs/releases/v<version>.md` 文件名与首行标题；缺一即 `check:release` 失败。
4. **tag 字符不是瓶颈**：四个候选全过 `git check-ref-format`；真限制是 `v0.2.116` 已被上游 `7b7f8f6` 占用，同名不能再指 fork HEAD。
5. **GitHub Release 跟随 tag**，不做字符串加工，也不替你解释 semver 顺序。
6. **badge 必须转义连字符**：`v0.2.116-fork.1` 直写 path 会 404，须写 `v0.2.116--fork.1`；`+` 免转义。且 badge 不受 `check:release` 覆盖。
7. **`v` 前缀不属于 semver**：`v0.2.116-fork.1` 只是 tag/徽章标签名，semver 本体是不带 v 的那串。
8. **npm registry 规则不约束本仓库**（`private: true`、无 publish）；可解析性仍是通用前提。
9. **归一化风险不对称**：`semver.valid()` 会把 `+fork.1` 抹成 `0.2.116`，不会抹 `-fork.1`。
10. **UI 徽章逐字比对**：后辍会直接进入用户可见字符串与 aria-label。

---

## 附：一手来源清单

- SemVer 2.0.0 —— <https://semver.org/>（<#spec-item-9> / <#spec-item-10> / <#spec-item-11>；`v` 前缀 FAQ <#is-v123-a-semantic-version>）
- npm package.json —— <https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/package-json.md>（站点页 <https://docs.npmjs.com/cli/v10/configuring-npm/package-json>）
- node-semver —— <https://github.com/npm/node-semver#readme>
- git check-ref-format —— <https://git-scm.com/docs/git-check-ref-format>；git tag —— <https://git-scm.com/docs/git-tag>
- GitHub Releases —— <https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>、<https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository>
- shields.io —— <https://shields.io/badges/static-badge>
- 先例 —— <https://github.com/k3s-io/k3s/releases/tag/v1.29.8%2Bk3s1>、<https://github.com/rancher/rke2/releases>、<https://github.com/git-for-windows/git/releases>、<https://github.com/VSCodium/vscodium/releases>、<https://codeberg.org/forgejo/forgejo>
