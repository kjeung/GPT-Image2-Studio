## ADDED Requirements

### Requirement: 环境变量可预置通道与生成默认值

服务端 SHALL 支持用环境变量预置生图通道与生成默认值，使部署时只填一份环境配置即可开箱使用。共用默认值（`IMAGE_SIZE`、`IMAGE_FORMAT`、`GENERATION_START_DELAY_MS`、`GENERATION_CONCURRENCY`、`REASONING_EFFORT`、`IMAGE_QUALITY`）SHALL 同时对四个通道生效；通道专属开关（路由 a 的 `IMAGE_TOOL_MODEL_INCLUDE`、直连 b 的 `DIRECT_IMAGE_STREAM`）SHALL 只影响所属通道。

布尔类环境变量 SHALL 接受 `0`/`1`、`off`/`on`、`no`/`yes`、`false`/`true`，显式关闭 SHALL 被识别为有效值而非“未设置”。数值类环境变量 SHALL 沿用既有取值区间收敛，显式 `0` SHALL 视为已设置。

环境变量 SHALL 作为首次访问的初值：浏览器首次加载采用服务端返回的值，用户保存界面配置后以保存值为准。该语义下 MUST NOT 让环境变量在用户保存后继续覆盖界面配置。

#### Scenario: 一份环境配置即可启动

- **WHEN** 部署时设置 `IMAGE_ROUTE=b`、`DIRECT_IMAGE_BASE_URL`、`DIRECT_IMAGE_API_KEY`、`DIRECT_IMAGE_MODEL` 与 `DIRECT_IMAGE_STREAM=1`
- **THEN** 首次打开界面即处于直连通道并启用流式输出
- **AND** 用户无需进入设置页即可发起生成

#### Scenario: 共用默认值对全部通道生效

- **WHEN** 部署时设置 `IMAGE_SIZE`、`IMAGE_FORMAT`、`REASONING_EFFORT`、`GENERATION_CONCURRENCY`
- **THEN** 路由、直连、模型协议与 Grok 通道首次加载时都采用这套默认值

#### Scenario: 显式关闭的开关不被忽略

- **WHEN** 部署时设置 `IMAGE_TOOL_MODEL_INCLUDE=0` 或 `DIRECT_IMAGE_STREAM=off`
- **THEN** 对应开关在首次加载时为关闭状态
- **AND** 不会被当成“未设置”而回退到内置默认值

#### Scenario: 用户保存后以界面为准

- **WHEN** 环境变量设置了某项默认值，用户在设置页改为别的值并保存
- **THEN** 刷新后界面沿用用户保存的值
- **AND** 环境变量不再覆盖该值

#### Scenario: 越界数值收敛到合法区间

- **WHEN** 环境变量把批量延迟或并发设成越界值
- **THEN** 取值收敛到既有合法区间
- **AND** 生成请求不会因此失败
