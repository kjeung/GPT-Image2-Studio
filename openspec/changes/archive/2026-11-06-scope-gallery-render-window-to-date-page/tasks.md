## 1. 纯决策

- [x] 1.1 在 `lib/gallery-organizer.mjs` 增加渲染窗口常量、`normalizeGalleryRenderLimit` 与页内窗口 `paginateGalleryRenderWindow`
- [x] 1.2 新增 `lib/gallery-window.mjs`，只放页内窗口与扩窗的纯决策（服务端分页轴撤掉后，合并/回填辅助函数一并删除，不留空转代码）
- [x] 1.3 把窗口与日期分页固定为正交顺序：先日期页、后页内窗口，并加结构回归断言防止串联写法回潮

## 2. 前端接入

- [x] 2.1 重写 `renderGalleryView`：日期轴先算，数量轴只作用于当前页
- [x] 2.2 新增工具栏「加载更多」，只做页内扩窗；本页画尽后让位给翻页
- [x] 2.3 日期表头与摘要同时报「已画 / 本页总数」，不再把 800 张说成 10 张
- [x] 2.4 切页与重置筛选把窗口宽度还原为默认值
- [x] 2.5 同步 `public/lib` 镜像与 `scripts/sync-public-lib.mjs` 名单

## 3. 验证与收尾

- [x] 3.1 运行串行全量测试（3045 例 0 失败）、镜像一致性、发布检查、OpenSpec 严格校验与空白/生成物检查
- [x] 3.2 同步主规格 `openspec/specs/gallery-history-browsing` 并归档本变更
