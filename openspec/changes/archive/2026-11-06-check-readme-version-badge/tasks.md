## 1. 恢复徽章模板

- [x] 1.1 在 `scripts/version-facts.mjs` 的 `MAINTAINED_VERSION_FACT_TEMPLATES` 里恢复 README 与 README.zh-CN 的 `version-v{version}-2563eb.svg` 模板，沿用上游子串形式
- [x] 1.2 核实 `findVersionFactDrift` / `replaceVersionFacts` 无需改动（模板表是唯一接缝）

## 2. 测试覆盖

- [x] 2.1 `test/version-facts.test.mjs`：模板必须对两份 README 注册
- [x] 2.2 陈旧徽章必须被判为漂移，且报出命中的子串
- [x] 2.3 测试夹具补徽章行，`release:patch` 后徽章随升版更新
- [x] 2.4 反例验证：把真实 README 徽章改回旧版本，`check:release` 必须打红

## 3. 验证与收尾

- [x] 3.1 运行 `npm run verify:ci` 八道关卡
- [x] 3.2 同步主规格 `openspec/specs/project-maintenance` 并归档本变更
