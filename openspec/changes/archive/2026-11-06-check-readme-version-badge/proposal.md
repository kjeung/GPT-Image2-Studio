## Why

上游 v0.2.116 的 `scripts/version-facts.mjs` 用两条模板守 README 徽章：`version-v{version}-2563eb.svg` 与安装包/免安装 ZIP 文件名。T1 的重建把整个桌面线剥掉时，这两条安装包模板连带徽章模板一起被删了——**徽章与桌面线毫无关系**，却因为和它挤在同一个数组元素里而被误删。

后果是 README 首屏那句「version v0.2.116」成了全仓唯一没人守的版本事实：`check:release` 查不出它过期，`release:patch` 也不会改它。实测把徽章改回 `v0.2.116`、其余版本事实全为 `v0.3.000`，`check:release` 仍然报绿；本次 `release:minor` 升到 `v0.3.000` 时徽章也确实留在旧值上，必须手工补。

## What Changes

- 在 `MAINTAINED_VERSION_FACT_TEMPLATES` 里把 README 徽章模板恢复回来，两份 README 各一条。
- 模板沿用上游的**子串形式** `version-v{version}-2563eb.svg`（不含 `https://img.shields.io/badge/` 前缀），这样与上游逐字一致，后续 rebase 不会在同一个数组元素上再冲突一次。
- `test/version-facts.test.mjs` 补三段覆盖：模板必须注册（两份 README）、陈旧徽章算漂移、`release:patch` 后徽章跟随更新；测试夹具补一行徽章，让端到端断言真的走到这条模板。

## Capabilities

### New Capabilities

<!-- 无新增能力。 -->

### Modified Capabilities

- `project-maintenance`: 「Release facts are checked consistently」里列举受检事实的那句，从「可见工作台标签、两份 README、Windows 分发文档、当前发行说明」改为显式包含 **README 的 shields.io 徽章**，并新增一条「徽章陈旧时释放一致性检查必须失败」的场景。

## Impact

- `scripts/version-facts.mjs`：恢复 README / README.zh-CN 两条徽章模板。
- `test/version-facts.test.mjs`：模板覆盖、漂移检出、升版跟随三段断言与夹具。
- 不修改 `scripts/versioning.mjs`、`scripts/check-release-readiness.mjs` 或 `scripts/release-patch.mjs`：模板表是唯一接缝，`findVersionFactDrift` / `replaceVersionFacts` 已按表工作。
- 边界：徽章颜色仍是 `2563eb`，模板写死颜色；将来换色要同步改模板，否则漂移检查会因颜色不匹配而失配——这一点已写进场景，不做颜色无关的宽松匹配（宽松匹配会退化成「任何 shields badge 都算」，反而漏掉真实漂移）。
