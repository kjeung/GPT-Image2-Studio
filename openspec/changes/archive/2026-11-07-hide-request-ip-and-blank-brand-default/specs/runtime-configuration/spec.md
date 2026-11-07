## REMOVED Requirements

### Requirement: 当前参数摘要显示请求发起 IP

请求发起 IP 不再于当前参数摘要中展示。服务端配置响应仍 SHALL 返回当前的 `requestIp` 字符串字段（表示 Studio 服务端通过上游 HTTP transport 查询到的公网出口 IP，MUST NOT 从浏览器请求头或入站 socket 地址推导；查询失败时返回空字符串），该字段 SHALL NOT 写入浏览器私有 API 配置。桌面端或浏览器端的当前生图参数摘要 SHALL NOT 显示该值。

#### Scenario: 配置接口返回当前请求地址

- **WHEN** 客户端请求 `/api/config`
- **THEN** 响应包含服务端查询到的公网出口 IP，或在查询不可用时包含空字符串
- **AND** 响应值不取自浏览器请求头或浏览器到 Studio 的连接地址

#### Scenario: 当前摘要不显示请求发起 IP

- **WHEN** 客户端加载配置并渲染生图参数摘要
- **THEN** 摘要不显示 Studio 本机当前公网出口 IP
- **AND** 摘要其余字段（路由模式 / 模型 / Url 链接）仍正常显示

## MODIFIED Requirements

### Requirement: 当前参数摘要显示生图请求 URL

当前生图参数摘要 SHALL 在文本模型信息之后显示 `Url :` 一行，其值 SHALL 为所选生图通道服务地址的 origin，仅包含协议、域名和必要端口，MUST NOT 包含 /v1、接口路径、查询参数、片段或凭据。有效 HTTP(S) 地址 SHALL 是指向该 origin 的链接，在新标签页打开；桌面端 SHALL 沿用已有外链处理。地址不可用时 SHALL 显示“未记录”且不可点击。长域名 SHALL 在摘要值区域内自动换行。

#### Scenario: 切换当前生图通道

- **WHEN** 用户选择路由、直连、Gemini 或 Grok 生图通道
- **THEN** Url 行显示所选生图服务的协议和域名
- **AND** 直连通道使用生图 API 地址，而非文本或视觉 API 地址

#### Scenario: 修改地址或协议后缀

- **WHEN** 用户修改当前通道基础地址、完整地址或协议后缀
- **THEN** Url 行保持与当前生图服务的 origin 一致
- **AND** 不显示 /v1 和其他接口路径

#### Scenario: 点击服务地址

- **WHEN** 用户点击 Url 行中的有效地址
- **THEN** 浏览器新标签页打开显示的服务 origin
- **AND** 不跳转至生图接口路径
