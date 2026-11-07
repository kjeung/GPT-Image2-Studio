## 实现

- [x] 1. 先补 `test/config-store.test.mjs`：新增环境变量、显式 false、缺省回退三组断言，确认旧实现失败。
- [x] 2. `buildEnvironmentConfig` 补共用默认值与两个通道开关；布尔变量单独用能识别显式 false 的读取函数。
- [x] 3. `mergeSavedConfigWithEnvironment` 让两个布尔开关按「存在」合并，避免 false 被当成未设置。
- [x] 4. 同步 `deploy/env.example`、`README.md`、`README.zh-CN.md` 的变量清单与「首次初值」语义。
- [x] 5. 用真实服务端验证 `/api/config` 输出，确认前端 `syncConfigUi` 能读到这些字段。

## 验收

- [x] 6. 运行完整 `npm test`、共享模块同步、发布检查、严格规格校验与差异检查。
