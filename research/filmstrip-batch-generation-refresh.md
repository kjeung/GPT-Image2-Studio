# 「生成套图」完成后 filmstrip 不显示结果：套图任务未登记进 session 集合

- **基线**：HEAD `2bd521a`，`package.json` 版本 `0.3.001`
- **被研判对象**：`public/app.js` 中提示词模式的 filmstrip（胶片条）取数与会话登记逻辑
- **触发入口**：提示词生图 → 提示词模板弹窗 → 「生成套图（N 张）」→ `startPromptSetGeneration`

## 结论速览

1. **已证实**：filmstrip 的历史条目只显示「本次会话生成的文件名」与「打开页面时捕获的历史基线」两部分；套图（批量）任务的 job 从未登记进 session 集合，所以它产出的文件名永远落不进 filmstrip。见 `public/app.js:7446-7452`（`visibleFilenames` 的来源）与 `public/app.js:7428-7436`（登记闸门）。
2. **已证实**：登记闸门 `recordPromptFilmstripSessionResult` 要求 `state.promptFilmstripSessionJobIds.includes(jobId)`，而这个数组**只有** `registerPromptFilmstripSessionJob` 会写入（`public/app.js:7409-7414`，全仓 grep 无第二个写入点）。套图路径 `public/app.js:9594-9606` 建完 job 后只做 `state.jobs.unshift(...jobs); jobs.forEach(recordJobQueued);`，**没有**调用 `registerPromptFilmstripSessionJob` — 这正是单发路径 `public/app.js:21440` 有、套图路径没有的那一行。
3. **已证实**：因此套图结果走的是「生成中占位可达、完成后消失」：生成期间 filmstrip 用 `state.jobs` 里的活动任务渲染占位（`public/app.js:7439-7445`），任务完成离开 `state.jobs` 后，画廊条目又被 `visibleFilenames` 过滤掉，于是 rail 里看不到任何东西；而 `upsertGalleryItem` 照旧把图写进画廊（`public/app.js:21251`、`20287`），所以「资产 → 瀑布画廊」能看到结果。
4. **已证实**：测试覆盖了单发路径与「必须先登记再记录结果」的语义，**没有**覆盖套图路径 —— `test/studio-preview-layout.test.mjs:851` 断言的是 `startGeneration` 里的 `registerPromptFilmstripSessionJob(job)`，`test/prompt-set.test.mjs` 只关心套图的 prompt/params，两条都没断言 `startPromptSetGeneration` 会登记 job。
5. **已证实（与症状无关）**：浏览器里的 `/api/gallery/metadata` 404 不是这个 bug 的原因。该路由存在（`server.mjs:7763-7765` → `handleGalleryMetadataRepair` `server.mjs:1684`），404 来自它对不存在文件的 `ENOENT` 分支（`server.mjs:1712-1717`），前端 `repairGalleryMetadataQueue` 逐条 `try/catch` 并只 `console.warn`（`public/app.js:2371-2389`），不会中断 `renderAll()`（同一批的 `loadGallery` 在 `public/app.js:20173` 已先 `renderAll()`，`:20174` 才异步补元数据）。
6. **推测（未证实）**：报告人环境的前端构建标识 `app.js?v=20261103-current-suite-1-batch-pills-1` 与旧镜像的 `/api/gallery/metadata` 404 可能提示「前后端版本错配」，但这解释不了 filmstrip 缺图 —— 当前 HEAD 的 `startPromptSetGeneration` 同样缺登记调用（`753dc40` 引入套图时就没有，`git show 753dc40:public/app.js` 的对应段落同样只有 `unshift` + `recordJobQueued`）。

## 证据细节

### 数据来源：filmstrip 只认「基线 + 本会话」

`public/app.js:7438` `getFilmstripItems()`：

- 活动任务：`getStablePreviewLoadingItems(state.jobs)`（`:7439-7445`）→ 生成中的占位。
- 历史条目：`visibleFilenames = baseline ∪ sessionFilenames`，再 `getPromptGenerationGalleryItems(state.gallery).filter(...)`（`:7446-7452`）。
- 基线：`syncPromptFilmstripBaseline()` 在首次 `loadGallery` 时快照，之后 `capturePromptFilmstripBaseline()` 只在未捕获时补做（`:7394-7407`、`:20173`）。

结论：**没有登记进 session 集合的 job，其结果永远进不了 filmstrip**，与画廊里有没有这张图无关。

### 闸门：只有登记过的 job 才算数

```js
// public/app.js:7428-7436
function recordPromptFilmstripSessionResult(job, item) {
  const jobId = String(job?.id || "").trim();
  const filename = String(item?.filename || "").trim();
  if (!jobId || !filename || !state.promptFilmstripSessionJobIds.includes(jobId)) {
    return;
  }
  recordPromptFilmstripSessionFilename(filename);
}
```

`state.promptFilmstripSessionJobIds` 的写入点全仓仅 `public/app.js:7411-7412`（`registerPromptFilmstripSessionJob`）。调用点全仓仅 `public/app.js:21440`（单发 `startGeneration`）。

### 两条路径的差异

| 路径 | 位置 | 是否登记 job |
| --- | --- | --- |
| 单发「开始生成」 | `public/app.js:21439-21441` | `registerPromptFilmstripSessionJob(job); state.jobs.unshift(job);` |
| 套图「生成套图」 | `public/app.js:9605-9606` | `state.jobs.unshift(...jobs); jobs.forEach(recordJobQueued);`（无登记） |

补充：`recordJobQueued` 不碰 filmstrip 会话（`public/app.js:6982-6991`），所以套图路径确实没有任何兜底。

### 结果写入点都一样，差的是闸门

两个终态写入点都调 `recordPromptFilmstripSessionResult`：流式 `SAVED` 事件 `public/app.js:21252`，轮询快照 `public/app.js:20288`。套图 job 到这里被 `includes(jobId)` 拦掉，函数直接 return，`promptFilmstripSessionFilenames` 不变。

### 测试空档

- `test/studio-preview-layout.test.mjs:851`：`assert.match(startGenerationBody, /const job = createJob\(\);\s*registerPromptFilmstripSessionJob\(job\); .../)` —— 只锁单发。
- `test/studio-preview-layout.test.mjs:663-711`：`prompt filmstrip registers only current-session saved task results` —— 验证「未登记 job 的结果被丢弃」，等于把套图的失败路径写成了期望行为。
- `test/prompt-set.test.mjs:1`（套图用例）：只断言 `createJob` 收到的 prompt/params/元数据。
- 结论：缺一条「`startPromptSetGeneration` 建立的每个 job 都进入 `promptFilmstripSessionJobIds`，且其完成结果进入 filmstrip」的用例。

### 规格依据

- `openspec/specs/gallery-history-browsing/spec.md:67-71`：filmstrip 属于「thumbnail-focused surface」，历史图必须在其中渲染（要求缩略图 URL，不代表可以缺失条目）。
- `openspec/specs/generation-loading/spec.md`（Unified generation loading indicator / Loading animation fills its host image slot）：胶片条与逐项占位的加载表现被点名要求一致；套图完成即从占位切换为结果，缺结果等于加载壳消失后没有接手的内容。
- `openspec/specs/image-soft-reveal/spec.md:6-14`：主预览的显现要求只谈「收到新图片地址」，未覆盖 filmstrip 的条目供给 —— 供给缺失在显现之前就发生了。

## 可能的位置（一句话）

给 `startPromptSetGeneration` 建立的每个 job 补上 `registerPromptFilmstripSessionJob(job)`（与 `public/app.js:21440` 对齐），并补一条覆盖套图路径的测试。
