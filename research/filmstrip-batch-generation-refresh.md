# 「生成套图」完成后 filmstrip 不显示结果：套图 job 从未登记进本会话

- **基线**：HEAD `f71fff8`（`git rev-parse --short HEAD`），`package.json` 版本 `0.3.001`
  - `git diff --quiet 2bd521a..HEAD -- public/app.js` 通过 —— `public/app.js` 自 `2bd521a` 起逐字节未变，故本文行号对本笔记的 `fe27a8f`/`19e689d`/`f71fff8` 三个文档提交及 `2bd521a` 同时成立。
- **被研判对象**：`public/app.js` 中提示词模式 filmstrip 的取数、session 登记与结果回收（纯前端内存状态，无接口契约变更）。
- **触发入口**：提示词生图 → 提示词模板弹窗 → 「生成所选套图」（`public/index.html:3813` / 按钮绑定 `public/app.js:22888-22890`）→ `startPromptSetGeneration`（`public/app.js:9567-9617`）。

## 结论速览

1. **已证实**：filmstrip 的历史条目只取「打开页面时的 10 张基线」∪「本会话成功结果文件名」，`getFilmstripItems` 用这个并集过滤 `state.gallery`（`public/app.js:7444-7455`）；基线由 `capturePromptFilmstripBaseline` 在首次 `loadGallery` 捕获一次（`:7394-7407`、`:20173`）。
2. **已证实**：结果入列有闸门 —— `recordPromptFilmstripSessionResult`（`:7428-7436`）要求 `state.promptFilmstripSessionJobIds.includes(jobId)`，该数组**只有** `registerPromptFilmstripSessionJob`（`:7409-7414`）会写，全仓 grep 无第二个写入点。
3. **已证实**：套图路径 `:9597-9606` 建完 job 只有 `state.jobs.unshift(...jobs); jobs.forEach(recordJobQueued);`，**没有**登记；单发 `:21439-21440` 是 `registerPromptFilmstripSessionJob(job); state.jobs.unshift(job);`。这是两条路径唯一的能力差，两个终态写入点（`:21252`、`:20288`）都因闸门而丢弃套图结果。
4. **已证实**：于是呈现「生成中占位、完成后消失」：占位只依赖 `state.jobs`（`:7439-7443`），`removeJob`（`:21278`）后消失，画廊侧被 `visibleFilenames` 挡掉；而 `upsertGalleryItem`（`:8605`）照旧把图写进画廊，故「资产 → 瀑布画廊」看得到。用真实源码切片已复现（见「实测复现」）。
5. **已证实（原线索未覆盖）**：`promptFilmstripSessionFilenames` 另有一处**绕过 job 闸门**的直写 `:20095`（filmstrip 卡片「另存」未完成预览）。它需用户手点、只对未完成尝试卡生效，**覆盖不了**套图正常完成路径；顺带发现「单发失败→重试」也丢 filmstrip（`:19971-19996`）。
6. **已证实（与症状无关）**：`/api/gallery/metadata` 的 404 与 filmstrip 缺图**不同源**。`loadGallery` 先 `renderAll()`（`:20179`）再异步补元数据（`:20180`），`repairGalleryMetadataQueue`（`:2371-2388`）逐条 `try/catch` 只 `console.warn`。

## 逐条复核（对最初 4 条线索）

| # | 线索 | 复核 | 当前 HEAD 准确位置 |
| --- | --- | --- | --- |
| 1 | 套图建 job 后只 `unshift` + `recordJobQueued`，无登记 | **成立** | `public/app.js:9597-9606`（函数 `:9567`） |
| 2 | 单发路径有 `registerPromptFilmstripSessionJob(job)` | **成立** | `public/app.js:21439-21440` |
| 3 | 闸门要求 jobId 在 `promptFilmstripSessionJobIds`，该数组只由 `register…` 写 | **半成立**：`…JobIds` 确实只此一个写入点；但**结果集合** `promptFilmstripSessionFilenames` 还有 `:20095` 这条直写旁路 | `:7428-7436`、`:7411-7412`，对照 `:20095` |
| 4 | 历史来源 = baseline ∪ session；baseline 在 `loadGallery` 一次性捕获 | **成立**（原写 `:7441` 起 → 实为 `getFilmstripItems` 起于 `:7438`，`visibleFilenames` 在 `:7444-7447`，过滤在 `:7448-7455`） | `:7394-7407`、`:7444-7455`、`:20173` |

**四条线索没有一条是「复核不成立」**：逻辑全部对得上，只是行号普遍偏早 0–10 行（`startPromptSetGeneration` 实为 `:9567` 起步、`getFilmstripItems` 实为 `:7438`），唯一需要更正的是第 3 条的外延 —— `…JobIds` 确实只有 `register…` 写，但**结果集合**另有一条 `:20095` 直写。

## 实测复现（仓库真实源码切片，未改任何文件）

把 `syncPromptFilmstripBaseline … getFilmstripItems` 原样 `new Function` 出来跑：基线 10 张 `history-01..10`；单发登记 `job-single` 并记录结果；套图两个 job（`job-b1`/`job-b2`）**不登记**、各自记录结果。

```text
套图进行中 filmstrip keys: job:job-b1, job:job-b2, file:history-01..10      ← 只有占位
套图完成后 filmstrip keys: file:single-01.png, file:history-01..10          ← 两张套图都不在
同时 state.gallery 里: batch-01.png, batch-02.png 都在                     ← 画廊有图
```

「占位有、完成后空、画廊有」三个现象一次复现，与报告人描述逐字吻合 —— **确定性**，不是时序 flaky。

另：`capturePromptFilmstripBaseline` 有 `if (!state.promptFilmstripBaselineCaptured)` 守卫（`:7404`），所以点「刷新画廊」重跑 `loadGallery`（`:23150-23151`）**不会**重算基线，套图结果依旧不出现；只有整页重载（状态清空、基线重算）后这些图才以「最近 10 张历史」身份出现。这解释了报告人「完成后为空」而非「从来就没有」。

### 线上实例旁证（2026-11-19，`http://aeboli-gpt-image2-studio:3600`）

用线上那份 `app.js`（sha256 `1897512e…2942a0`，与本仓库 `public/app.js` 逐字节相同、1084187 B / 23893 行）切同一段 helper 执行，31 张历史做基线：

```text
基线条目数: 10
登记过的 job: [ 'prompt-job-single' ]
session 文件名: [ 'single-1.png' ]
单发结果进 filmstrip: true
套图结果进 filmstrip: false false
```

线上 `registerPromptFilmstripSessionJob` 调用点仍只有 `:21440` 一处；`GET /api/gallery` 返回的 31 张里最新几条正是同一次套图产物 —— 生成、落盘、入库全好，坏的只是「供给 filmstrip 的那一步」。故**排除旧镜像/版本错配**。

## 证据细节

### 数据来源：filmstrip 只认「基线 ∪ 本会话」

`public/app.js:7438` `getFilmstripItems()`：

- 活动任务：`getStablePreviewLoadingItems(state.jobs)`（`:7439-7443`）→ 生成中占位。
- 历史条目：`visibleFilenames = baseline ∪ sessionFilenames`（`:7444-7447`），再 `getPromptGenerationGalleryItems(state.gallery).filter(...)`（`:7448-7455`）。
- 基线：`syncPromptFilmstripBaseline()` 把「按时间倒序的提示词条目去掉已知 session 文件名」取前 10（`:7394-7401`；`PROMPT_FILMSTRIP_INITIAL_HISTORY_LIMIT = 10`、`MAX = 50`，`:185`）；`capturePromptFilmstripBaseline()` 仅未捕获时调它（`:7403-7407`），唯一调用点 `:20173`。

结论：**没进 session 集合的文件名，无论画廊里有没有，都进不了 filmstrip**。

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

`state.promptFilmstripSessionJobIds` 写入点全仓仅 `:7411-7412`。`registerPromptFilmstripSessionJob` 全仓命中：定义 `:7409`、调用 `:21440`、测试 `test/studio-preview-layout.test.mjs:684,702,851`。

### 两条路径的差异

| 路径 | 位置 | 是否登记 job |
| --- | --- | --- |
| 单发「开始生成」 | `public/app.js:21439-21440` | `const job = createJob(); registerPromptFilmstripSessionJob(job); state.jobs.unshift(job);` |
| 套图「生成所选套图」 | `public/app.js:9597-9606` | `const jobs = templates.map((template) => createJob({...})); state.jobs.unshift(...jobs); jobs.forEach(recordJobQueued);` —— 无登记 |

`recordJobQueued`（`:6982-6991`）只写活动日志，不碰 filmstrip 会话，套图侧没有兜底。

终态写入点两条路径共用：流式 `GENERATION_STREAM_EVENTS.SAVED`（`:21219`）→ `upsertGalleryItem(payload.item); recordPromptFilmstripSessionResult(job, payload.item);`（`:21251-21252`），随后 `removeJob(job.id)`（`:21278`）；轮询 `applyGenerationTaskSnapshots` 的 completed 分支（`:20254`）→ `:20287-20288`。套图 job 在此被 `includes(jobId)` 拦掉。

### 第二写入点：另存未完成预览（绕过闸门，但覆盖不了套图）

```js
// public/app.js:20052 savePromptAttemptPreview(deckKey, attemptIndex)
markPromptAttemptSaved(state.promptAttemptDecks, { deckKey, attemptIndex, filename: payload.filename });
if (payload.item) {
  upsertGalleryItem(payload.item);
  recordPromptFilmstripSessionFilename(payload.item.filename);   // :20095
}
```

判定：**不能覆盖套图**。① 唯一入口是 filmstrip 卡片上的「另存」按钮（`:7737`），该按钮仅 `card.status !== COMPLETED` 时渲染（`:7726-7739`）；② 套图正常完成走 `:21251-21252`，与此无关；③ 它连 `…JobIds` 都不看，属「另一个 bug 面」而非兜底 —— 拿它当兜底会把会话边界彻底打开。

### 附带发现：单发「重试」同样丢 filmstrip（原线索未涉及）

`retryFailedJob`（`:19971-19996`）先 `removeJob(jobId)`（`:19976`），再用**新 id** 重建 job（`:19979`）并 `state.jobs.unshift(retryJob)`（`:19991`），既没登记新 job 也没迁移旧 jobId 的登记。所以「单发失败 → 点重试 → 成功」结果同样进不了 filmstrip —— 同根因的第二个症状面，修复宜一并覆盖。

### 测试空档（逐条到断言原文）

- `test/studio-preview-layout.test.mjs:834-859`（`studio prompt filmstrip keeps its session boundary across direct and polled completion`）：`:836-840` 只切出 `getFilmstripItems` / `startGeneration` / `loadGallery` / `applyGenerationTaskSnapshots` / `runGeneration` 五段；唯一锁登记行为的断言在 `:851`：
  `assert.match(startGenerationBody, /const job = createJob\(\);\s*registerPromptFilmstripSessionJob\(job\); state\.jobs\.unshift\(job\);/);`
  —— `startGenerationBody` 来自 `:837`，**只覆盖单发**。
- `test/studio-preview-layout.test.mjs:663-711`（`prompt filmstrip registers only current-session saved task results`）：`:702-704` 断言「登记 job-1、结果来自 other-job → `deepEqual(sessionFilenames, [])`」，`:706-708` 断言同一 job 重复记录只留一条。它把「未登记 job 的结果被丢弃」写成**期望行为**，等于给套图失败路径背书。
- `grep -c startPromptSetGeneration test/studio-preview-layout.test.mjs` → **0**；`test/prompt-set.test.mjs` 里 `filmstrip`/`promptFilmstrip` 命中 **0**（该文件只锁 `createJob` 契约：`:101-161`、`:226-268`）。
- 空档实测：`node --test test/studio-preview-layout.test.mjs test/prompt-set.test.mjs test/prompt-attempt-deck-integration.test.mjs` → **tests 212 / pass 212 / fail 0**（在本 HEAD 复跑确认）。bug 存在而测试一条不红。
- 结论：缺一条「`startPromptSetGeneration` 的每个 job 进入 `promptFilmstripSessionJobIds`、其结果进入 filmstrip」的用例。

### 规格依据

**最直接的一条**：`openspec/specs/creation-mode/spec.md:1658-1701`「提示词模式胶片条使用页面会话展示窗口」原文（`:1660`）：

> 提示词模式胶片条首次成功载入 SHALL 只展示最近 10 张提示词模式历史图片，并把这 10 张作为当前页面会话的初始基线。**当前页面提交的有效提示词生成任务 SHALL 只在其图片成功保存后加入该基线**；系统 MUST NOT 为了填满窗口而加入基线之外、更早的历史图片。…最多 50 张历史缩略图的滚动窗口…运行中任务占位 SHALL 与历史图片窗口分开计数…

配套场景 `:1668-1673`「当前页面继续生成」：「5 个提示词生成任务均成功保存图片 → 胶片条展示这 5 张当前会话结果和原有 10 张基线图片，共 15 张历史缩略图」。套图批量任务属于「当前页面提交的有效提示词生成任务」，现实是进去 0 张 —— **规格第一句即违规**（该要求由 `openspec/changes/archive/2026-08-08-fix-prompt-filmstrip-session-window` 引入，套图路径 `753dc40` 落地时就没接这条）。

其余相关：

- `openspec/specs/generation-loading/spec.md:178-192`「Generation completion and cleanup」，`:182-186`：「生成任务返回完整图片 → 计时器清理、加载组件从预览容器移除并显示图片」。filmstrip 的落空形态正是「加载壳消失后没有任何内容接手」。
- `openspec/specs/generation-loading/spec.md:16-20`、`:55-61`、`:141-156`：套图逐项占位/心跳/排队态被点名要求与单发一致；占位阶段实际达标（`:7439-7443` 确实渲染），缺的只是终态接手。
- `openspec/specs/operation-loading-feedback/spec.md:32-40`：胶片条占位动态「SHALL NOT 改变胶片条的选择、滚动或**图片结果呈现行为**」。
- `openspec/specs/gallery-history-browsing/spec.md:64-70`：filmstrip 属 thumbnail-focused surface，只约束用 `thumbnailUrl`；**不含**「哪些条目该出现」，不能单独作为本 bug 的规格依据（易误引，注明）。

### `/api/gallery/metadata` 404：**无关**

- 路由存在：`server.mjs:7763-7765` → `handleGalleryMetadataRepair`（`server.mjs:1684-1721`）。
- 404 来源：`repairGeneratedAssetMetadata` 找不到图片时抛 `ENOENT`（`lib/gallery-store.mjs:1254-1267`；`createNotFoundError` `:1072-1076` 设 `error.code = "ENOENT"`），`server.mjs:1712-1717` 翻成 404 `{message:"Not found"}`。语义是「浏览器缓存里有、outputDir 里已没有这个文件」—— 缓存陈旧。
- 不中断渲染：`loadGallery` 先 `renderAll()`（`:20179`）再 `void repairGalleryMetadataQueue(...)`（`:20180`）；后者逐条 `try/catch`，失败只 `console.warn`（`:2371-2388`）。
- 反向验证：即便整条链路删掉，套图结果仍进不了 filmstrip（闸门 `:7431` 是纯 jobId 集合判断，不看任何元数据）。**结论：无关。**
- 可留作独立小问题：陈旧缓存条目会每次 `loadGallery` 触发一次 404，值得单独清理，与本 bug 无优先级关系。

## 推测（未证实）

1. 套图路径还缺单发路径的队列上限守卫（单发 `:21432-21435` 有 `hasReachedGenerationQueueLimit("prompt", ...)`，套图 `:9567-9617` 无）。若一次勾选超过 `MAX_PROMPT_QUEUE_SIZE = 15`（`public/lib/studio-constants.mjs:8`），套图会把队列撑破；上游/调度在 >15 时的实际表现未验证。与 filmstrip 无因果。
2. 报告人若在套图完成后手动点过某张未完成卡的「另存」，filmstrip 会**多出那一张**（走 `:20095` 旁路）。是否发生过未验证；但即使发生，也解释不了「整批都不显示」。

## 附：完整调用链

| 环节 | 位置 |
| --- | --- |
| 按钮绑定 | `public/app.js:22888-22890`（`#generatePromptSetButton`，`public/index.html:3813`） |
| 批量提交 | `public/app.js:9597-9606`（`templates.map(createJob)` → `state.jobs.unshift(...jobs)` → `jobs.forEach(recordJobQueued)`，**无登记**） |
| 收尾渲染 | `public/app.js:9607-9612`（选中项 → 关弹窗 → `setActiveView("studio")` → `renderAll()` → `scheduleGenerationQueue()`） |
| 调度 / 执行 | `:21099-21113` → `runGeneration` `:21115` |
| 流式成功 | `SAVED` `:21219` → `:21251` `upsertGalleryItem` + `:21252` `recordPromptFilmstripSessionResult`（被闸门拦）→ `:21278` `removeJob` |
| 轮询成功 | completed `:20254` → `:20287` `upsertGalleryItem` + `:20288` `recordPromptFilmstripSessionResult`（同样被拦） |
| 渲染 | `renderAll` `:8563` → `renderActiveView` `:8547` → `renderStudio` `:8518` → `renderFilmstrip` `:7910` → `getFilmstripItems` `:7438` → `renderFilmstripEntries` `:7745` |

filmstrip 取数是从 `state.gallery` **现算**的（无独立 store、无自定义事件；全仓 `dispatchEvent` 仅 `:9282`/`:9286` 两处且与生图无关）。所以「不刷新」不是渲染问题：`renderAll()` 每次都跑到了，是 `getFilmstripItems` 的过滤集合里没有这些文件名 —— 这也正好解释「画廊看得到、filmstrip 看不到」。

## 可能的位置（一句话）

在 `startPromptSetGeneration` 建完 `jobs` 后补 `jobs.forEach(registerPromptFilmstripSessionJob);`（与 `:21440` 对齐，落在 `:9605` 前后），一并修 `retryFailedJob` 的登记迁移，并补一条覆盖套图路径的回归用例 —— 现有 `test/studio-preview-layout.test.mjs:851` 只锚单发，改与不改都绿。
