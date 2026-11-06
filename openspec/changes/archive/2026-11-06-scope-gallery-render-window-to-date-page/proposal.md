## Why

上游画廊的日期分页只约束「看哪些天」，不约束「一页画多少张」：分页单位是日期分组（5 天/页），
section 内没有数量上限。于是「单日 800 张」时一页就是 800 个瓦片，`totalPages` 退化成 1。

本地曾引入一套 10 张渲染窗口来堵这个口子，但把它**前置**于日期分页，两级都在切同一份列表：
10 张跨 10 个日期时当前页只画 5 张，已经加载到手的条目又被「下一页」藏掉一半。这是本地实现自身的语义缺陷，
原样搬进 v0.2.116 基线会把缺陷一起搬过来。

同时本地那半套**服务端**限流（`?limit=N` + `X-Gallery-Has-More`）与上游「客户端全量筛选」架构正面冲突：
只给 10 条会让搜索搜不到、日期筛选计数塌缩、`totalPages` 从 7 掉到 1~2。本地窗口模型真正有价值的成分是
**客户端渲染预算**，不是**服务端有界返回**。

## What Changes

- 把窗口与日期分页改为**两级正交**，顺序固定为「先日期页，后页内窗口」：日期轴（上游，5 天/页）决定看哪些天，
  数量轴（本地）只决定当前这一页画多少张。**不得**再把窗口前置。
- 新增页内窗口纯函数 `applyGalleryRenderWindowToSections`：按日期从新到旧发放预算，发完即停；
  每个日期保留完整条数（`count`）与被画出的条数（`windowCount`），表头据此说「10 / 800」而不是把 800 说成 10。
- 新增工具栏「加载更多」控件：只做**页内扩窗**（10 → 20 → 30，纯客户端重画，不碰网络与磁盘）。
  本页画尽后按钮隐藏、状态行改指翻页，页内扩窗与翻页两个「前进」动作**不同时**出现在工具栏。
- 删除「窗口先切、再按月分页」的串联写法；**不引入**任何服务端 `?limit` 限流：`/api/gallery` 保持全量返回，
  `state.gallery` 重新持有全库，搜索/筛选/`totalPages` 基于全库。
- 瓦片密度仍按**完整**日期分组计算（`getGalleryHistorySectionLayouts(allSections)`），
  点「加载更多」不改变列数，格子不跳尺寸。
- 切换日期页与重置筛选把窗口宽度还原为默认值，页内扩窗的效果不跨页泄漏。

## Capabilities

### New Capabilities

<!-- 无新增能力。 -->

### Modified Capabilities

- `gallery-history-browsing`: 日期页不再保证「这些日期的每张图都在本页」，改为「本页画出这些日期的前 N 张，
  N = 页内窗口宽度，默认 10、可增至 20/30」；新增页内扩窗与翻页互斥的交互要求。

## Impact

- 纯决策：`lib/gallery-window.mjs`（新增）、`lib/gallery-organizer.mjs`（渲染窗口常量与页内窗口函数），
  及其 `public/lib` 镜像与 `scripts/sync-public-lib.mjs` 同步名单。
- 前端接入与摘要：`public/app.js`、`public/index.html`、`public/styles.css`。
- 测试：新增 `test/gallery-window.test.mjs`；`test/gallery-organizer.test.mjs` 增加窗口用例；
  `test/asset-workspace-layout.test.mjs` 增加「两级不串联」结构回归。
- 不修改服务端 API、图片数据、删除与灯箱语义，也不回退上游的 5 天/页与两日期分组密度算法。
- 已知取舍：窗口只省**渲染量**，不省首屏扫描（全量返回的 2.5–3.0s 仍在）。这是换回正确搜索/筛选/分页语义的主动选择。
