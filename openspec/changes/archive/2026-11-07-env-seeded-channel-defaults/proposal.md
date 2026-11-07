## Why

部署时希望只填一份 `.env` 就能开箱即用，但通道与生成默认值里有几项无法用环境变量表达，只能启动后进设置页手点：

- 直连通道是否流式输出、路由模式是否发送 `tools[].model` 两个开关在 `DEFAULT_CONFIG` 里写死。
- 尺寸、格式、批量节奏（启动延迟与并发）也没有环境变量入口。

另外环境变量语义需要说清楚：它是首次访问的初值，不是持续强制的策略。

## What Changes

补齐七组环境变量，并按「共用项用全局名、通道专属项带通道前缀」命名：

- `IMAGE_SIZE`、`IMAGE_FORMAT`、`GENERATION_START_DELAY_MS`、`GENERATION_CONCURRENCY`：四个通道共用的生成默认值。
- `IMAGE_TOOL_MODEL_INCLUDE`：路由模式 `tools[].model` 开关，只在路由 a 消费。
- `DIRECT_IMAGE_STREAM`：直连通道流式输出开关，只在直连 b 消费。
- `REASONING_EFFORT` 与 `IMAGE_QUALITY` 本来就有，本次一并写入文档。

布尔变量必须支持显式 false（`0`/`off`/`no`/`false`），不能因为空串语义把「关闭」当成「未设置」。

环境变量保持「首次访问初值」语义：服务端每次启动按 env 计算配置，浏览器首次加载采用，此后以用户保存的界面配置为准。不改变 `mergeSavedConfigWithEnvironment` 对已保存通道字段的现有覆盖规则。

## 不在本次范围

- 不引入「服务器强制锁定」模式（用户已明确选择以界面为准）。
- 不改动各通道的 baseUrl / key / model 变量命名。
- 不改动批量调度的取值范围与收敛规则。
