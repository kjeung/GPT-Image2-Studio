# clipboard-image-files 与 studio-enhancements 在 v0.2.116 基线上的存活研判

- **基线**：上游 `v0.2.116`（`7b7f8f6`，`public/app.js` 22352 行 / 1016996 B）；本地 `legacy-v0.2.0`（`bba3694`，`public/app.js` 18133 行 / 737149 B）
- **研判对象**：`lib/clipboard-image-files.mjs`（84 行，本地独有）、`lib/studio-enhancements.mjs`（136 行，本地独有）
- **上游同名模块**：均无（`git ls-tree v0.2.116 --name-only lib/ public/lib/ | grep -c clipboard-image-files` → 0）
- 上游所有行号均指 `v0.2.116:public/app.js`，本地行号指 `legacy-v0.2.0:public/app.js`。两版行号不能照抄。

---

# 第一件：`prepareClipboardImageFiles` 与上游剪贴板路径

## 结论：**互补，且存在一处真实回归需要一并处理**

不是重复。上游的 `clipboardData` 处理与本地这个模块**根本不在同一个抽象层**：上游读的是*文本清单*和*系统剪贴板 API*，本地做的是*粘贴事件的图片文件加固*。但两者确实共用「从 `ClipboardEvent` 取图片文件」这一步，而那一步上游也有，本地只是照抄后**用自己的全局路由取代了上游三个分场景 handler**——这在重建时会丢一个能力（见下节「回归」）。

### 上游那条路径到底处理什么

上游 `public/lib/product-image-import-controller.mjs` 里 `clipboardData` 命中 4 处，但它们是**一个功能，不是三个**：

| 位置 | 内容 | 场景 |
|---|---|---|
| `:77-78` | `readProductImageImportPaste(clipboardData)`，只读 `getData("text/plain")` | 粘贴**文本清单** |
| `:712` | `handlePaste(event)` | 同上，事件入口 |
| `:715` | `const manifest = readProductImageImportPaste(event.clipboardData)` | 同上 |
| `:801` | `documentRef.addEventListener("paste", handlePaste)` | 绑定 |

这条路径处理的是**商品图收集器（浏览器扩展）→ Studio 的清单交接**：只有当剪贴板里是 `PRODUCT_IMAGE_IMPORT_MAGIC` 开头的文本时才 `preventDefault` 并打开导入弹窗；取不到清单就 `return`，**一张图片文件都不处理**。它的守卫是 `canHandlePaste`，上游接线处写死为：

```js
// v0.2.116 app.js:19284
canHandlePaste: () => state.activeView === "creation" && !isCreationLogoBatchBranch()
```

同一模块还有第二条**与粘贴事件无关**的路径：`readProductImageImportClipboard`（`:46`）走 `navigator.clipboard.read()`（`:28 readNativeClipboardImageFiles`），服务于弹窗里的「从剪贴板导入」按钮（`:239` → `#creationClipboardImportButton`，`index.html:1482`；点击处理 `:684 importFromClipboard` / `:693`）。这是**商品图导入器专用的按需读取**，带剩余槽位、重复张数、溢出张数结算。

### 上游另有第三条路径：通用图片粘贴（本地替换掉的就是它）

上游 `app.js` 有 4 处 `paste` 绑定 + 控制器内 1 处：

| 位置 | handler | 作用域 |
|---|---|---|
| `app.js:20352` | `getClipboardImageFiles(clipboardData)` | 取 `items`/`files` 里的 image File |
| `app.js:20362` | `handlePromptAgentImagePaste` | **prompt-agent 弹窗打开时** |
| `app.js:20364` | `handleStudioImagePaste` | prompt 输入框 / 风格迁移输入框焦点上 |
| `app.js:20378` | `handleCreationReferenceImagePaste` | creation 视图（**带 `event.defaultPrevented` 守卫**） |
| `app.js:20478` / `:21455` / `:21459` | 绑定上述 handler | — |

上游这条路径**只取文件、直接交给下游 `apply*` 函数**，没有快照、没有校验、没有解码重试。

### 本地这条路径做的是什么

本地 `app.js:16784 handleGlobalImagePaste` 是**单一全局监听**（`:16815`），先用 `:16683 getClipboardImageFiles`（与上游 `:20352` **逐字相同**，唯一差异是收尾一处 `}`）取文件，然后经模块加固，再按当前视图路由到 6 个投放区之一：

```js
// 本地 app.js:16784-16797
function handleGlobalImagePaste(event) {
  const imageFiles = getClipboardImageFiles(event.clipboardData);
  const routeContext = getActiveImagePasteRouteContext();
  if (imageFiles.length === 0 || !routeContext) {
    return;
  }
  event.preventDefault();
  void prepareClipboardImageFiles(imageFiles, {
    decodeImageFile: decodeClipboardImageFile,
    retryDelayMs: 60,
  }).then(({ acceptedFiles, rejectedFiles }) => { /* :16745 routeImagePasteToActiveDropzone */ });
```

`lib/clipboard-image-files.mjs` 在这条链上补了三件上游没有的事：

1. **快照化**（`:38 snapshotClipboardImageFile`）：`await file.arrayBuffer()` 读字节后用 `new File` 重建（`:58`）。`ClipboardEvent` 给的 File 在回调结束后可能被回收，直接透传会在异步预览阶段读到空内容——这是「粘贴偶发失败」的根因。
2. **校验与部分失败**（`:43-51`）：非 `image/`、0 字节直接拒；失败项进 `rejectedFiles`（`:76-79`）而**不拖累同批其它图**，上层还能拼出「已粘贴 N 张，另有 M 张失败」的提示。
3. **解码重试**（`:19 decodeWithRetry`）：首解失败等 `retryDelayMs`（本地接 60ms）再试一次，两次都败才判失败；并把首次错误抛出（`:33`）。

上游没有任何等价物：`lib/gallery-thumbnail.mjs` 是服务端，`createImageBitmap` 在 `app.js` 的三处（`:1704`、`:1776`）都用于**压缩/缩放**，不是粘贴校验。

### 判定与移植改造点

模块本身：**可移植，且必须移植**——它是通用粘贴路径的稳定性加固，上游从没有过这一层。

但**不要连同本地的全局路由一起搬过去**，否则会丢能力：

- **回归 **：本地把上游的 3 个分场景 handler 全替换成了 1 个全局 handler，`handlePromptAgentImagePaste` 在本地**已不存在**（`grep -c` → 0；`handleStudioImagePaste` 同样 0）。本地路由上下文（`:16730`）只认 `activeView ∈ {studio, style-transfer, reference-analysis, image-decomposition, creation, portrait}`，而 prompt-agent 是**覆盖在 studio 之上的弹窗、不是视图**：弹窗打开时 `activeView === "studio"`，粘贴会被路由成 `applyReferenceFiles`，**进 Studio 参考图而不是 prompt-agent 预览框**。上游对此有独立 handler，还有测试守着（`v0.2.116:test/studio-preview-layout.test.mjs:1354`）。
- 本地全局 handler 也丢了上游 `handleCreationReferenceImagePaste`（`:20378`）里的 `event.defaultPrevented` 守卫，多监听共存时会重复消费同一次粘贴。

**推荐改造**：保留 `lib/clipboard-image-files.mjs` 原样，把 `prepareClipboardImageFiles(...)` 下沉成上游 3 个 handler 内部共用的一步（即 handler 取到 files 后先过加固再 `apply*`），**而不是**把 3 个 handler 合并成全局路由。这样既拿到快照/校验/重试，又保住 prompt-agent 弹窗与 `defaultPrevented` 语义。上游 `product-image-import-controller`（文本清单 + `navigator.clipboard.read`）与本地模块**无重叠，两者并存**。

---

# 第二件：`studio-enhancements` 逐函数判定

## 先更正两处工单口径

1. 工单写「10 个导出函数」，实际文件有 **11 个** `export`（`grep -c "^export "` → 11）。除工单列的 10 个外，还有 `saveGalleryItemsIndividually`（`:108`），它是批量下载的执行器，被 `test/gallery-batch-download.test.mjs` 直接测。
2. 上游**并非把其中一部分内联**——按名字检索 11 个全为 0 命中。但「名字没有」不等于「能力没有」：有 3 个在上游被**内联/模块化成了删除路径的实现**，且其中 1 个是可复用的导出。这才是逐项研判要看的东西。

## 逐函数判定表

| # | 函数（本地行） | 判定 | 上游对应物 / 依据 |
|---|---|---|---|
| 1 | `isRetryableStudioJob`（`:8`） | **可移植** | 上游无同名、无 `retryable` 字样。上游是**正交**的另一套：`lib/upstream-fatal-error.mjs:78 isFatalUpstreamError`（判定*不可重试*的账号级错误，被 `creation-auto-repair.mjs` / `creation-suite-queue.mjs` / `server.mjs` 使用）。**但要注意**：上游用 `prompt-attempt-deck` 把失败尝试的卡片留了下来（`app.js:18791 isPromptDeckJob`、`:18795 sealPromptDeckOnFailure`、`:7168 getTerminalPromptAttemptDecks` 渲染成「未完成」条目），其覆盖的模式集合（排除 ref-analysis / image-decomposition / image-edit / quick-blend）**几乎等于**本地的 `RETAINABLE_FAILURE_MODES = {"", "prompt", "style-transfer"}`。所以「失败尝试可见」上游已有，「一键重试按钮」上游没有（`previewRetryButton` 上游 0 处，本地 `index.html:398` + `app.js:15283 retryFailedJob`）。本地这个函数是重试门的**唯一出口**，仍需保留。 |
| 2 | `normalizePromptTemplateParams`（`:13`） | **可移植** | 上游 `normalizePromptTemplate`（`app.js:8020`）只归一 `{id, name, prompt}`，**模板根本不带参数**（`params` 全仓 0）。本地模板多两字段 `params` + `analyzeTitle`（本地 `app.js:7086-7087`、`createJob` 用 `:15051`）。纯函数、无依赖。 |
| 3 | `canApplyItemConfig`（`:32`） | **可移植** | 上游 0。最近的活动作是 `app.js:3497 addCurrentPreviewToReferences`（预览→「添加到参考图」按钮 `:21728`），**只把图加回参考图，不还原 prompt/ratio/size**。本地这条是「载入配置」的准入判定（`app.js:5586`、`:6128`、`:17962`；按钮 `index.html:398`、`:2473`），上游无此闸门。 |
| 4 | `toggleSelectionValue`（`:43`） | **上游已内联** | 等价实现在 `v0.2.116:lib/asset-record-delete-controller.mjs:141 updateCheckedRecordIds`（`checked && id ? add : delete`，返回数组）。**但它闭包私有**（只在 `:365` 的返回对象上暴露，不 export），无法 import；且上游用它维护的是**删除**勾选。本地用它维护 gallery 与 filmstrip 的**下载**勾选（`app.js:6466`、`:6615`）。→ 语义等价、无法复用，保留本地版本。 |
| 5 | `areAllItemsSelected`（`:56`） | **上游已内联** | `app.js:12877`：`filteredIds.length > 0 && filteredIds.every((setId) => selectedIds.has(setId))`；`app.js:13365`：`selectedCount === filteredIds.length`。两处都是行内表达式，**没有抽成函数**，也无法 import。上游这两处判的是 creation 记录（`setId`），本地判的是图库/胶片条的 `filename`。→ 保留本地版本（可测的纯函数）。 |
| 6 | `selectGalleryItemsByFilenames`（`:61`） | **上游已内联（且已模块化、可复用）** | `v0.2.116:lib/asset-record-delete.mjs:39 getAssetRecordDeleteTargets`（**exported**），配合 `asset-record-delete-controller.mjs:53` 的 `getId: (item) => item?.filename`，做的就是「勾选的 filename 集合 → 记录数组」。这是本表里**唯一真正可以改调上游**的一项：`getAssetRecordDeleteTargets({ mode: "selected", records: state.gallery, getId: (i) => i.filename, checkedIds })`。→ 建议改调上游，避免长期双实现；若上游那套删除模型不落地，则保留本地版。 |
| 7 | `normalizePromptSet`（`:68`） | **可移植** | 上游**整层概念不存在**：`promptSets` 0、`templateIds` 0、`PROMPT_SET_STORAGE_KEY` 0、`套图模板` 0。本地「套图」（一组模板按序批量生成，`app.js:16401 startPromptSetGeneration`）是纯增量。 |
| 8 | `resolvePromptSetTemplates`（`:85`） | **可移植** | 同上，依赖套组概念。本地用在 5 处（`app.js:7245`、`:7319`、`:7504`、`:16414`、`:18089`）。 |
| 9 | `removePromptTemplateFromSets`（`:93`） | **可移植** | 上游 `deletePromptTemplate`（`app.js:8607-8618`）只从 `state.promptTemplates` 过滤，**没有套组可级联**（因为它没有套组）。注意**本地内部已有重复**：`lib/prompt-kit-share.mjs:276 removePromptTemplatesFromLibrary` 也做「模板+套组」级联清理；移植时二者应合并，不要留两份。 |
| 10 | `buildTitleAwarePrompt`（`:126`） | **可移植** | 上游 `analyzeTitle` 0 命中、`结合产品标题分析` 0 命中。上游 `app.js:14536` 的 `productName` 只从参考图分析结果里取字段供**套图展示**，不参与 prompt 构造。本地把标题用 `JSON.stringify` 包成 JSON 串并显式声明「仅为数据不是指令」，等于**自带一层提示注入防护**（本地 `app.js:16436` 逐模板套用）。 |
| 11 | `saveGalleryItemsIndividually`（`:108`） | **可移植（能力增量）** | 上游图库勾选的用途是**批量删除**，不是下载：`index.html:2462 galleryDeleteSelectedButton「删除选中」`、`app.js:21665 requestAssetRecordDelete("gallery","selected")`、勾选维护 `:21669 updateCheckedRecordIds`。上游 `downloadGalleryItem`（`:1924`）只下**单张**；`JSZip` 0 命中，没有打包下载。本地是逐张触发浏览器下载、统计成功/失败、全失败才抛错（`app.js:1525` 与 `:6532` 图库、`:6681` 胶片条两条入口）。上游完全没有此能力。 |

### 汇总

- **8 项可移植**（#1、#2、#3、#7、#8、#9、#10、#11），理由分三类：上游无此概念（套组三件套、标题分析、模板参数）、上游选错方向（可重试模式 vs 致命错误）、上游缺能力（图库批量下载）。
- **2 项上游已内联但不可复用**（#4、#5）：等价逻辑在 `asset-record-delete-controller.mjs:141`、`app.js:12877` / `:13365`，都是闭包私有或行内表达式，无法 import；且上游服务的是删除语义，本地服务下载语义。
- **1 项建议改调上游**（#6）：`getAssetRecordDeleteTargets` 是导出、签名够用。
- **0 项判弃**。没有一项是「上游已经用更好的形式做了同样的事，本地可以直接删」。

### 一处必须预先决策的冲突

上游与本地对「图库勾选」这件事**同名不同用途**，重建后必然撞车：

| | 上游 v0.2.116 | 本地 legacy-v0.2.0 |
|---|---|---|
| 状态 | `galleryCheckedFilenames: []`（数组，`app.js:796`）+ `gallerySelectionMode`（`:797`） | `gallerySelection: new Set()`（`app.js:469`）+ `gallerySelectionMode`（同名字段） |
| 按钮 | `gallerySelectionModeButton「勾选图片」`→ `galleryDeleteSelectedButton「删除选中」`（`index.html:2459`/`:2462`）、`galleryDeleteCurrentButton「删除当前」` | `gallerySelectToggle「批量下载」`→ `galleryBatchDownloadButton「下载所选」`（`index.html:2217`/`:2221`），另有 `gallerySelectAllButton` / `gallerySelectClearButton` / `gallerySelectionCount` |
| 落地后果 | 本地**丢了「删除选中 / 删除当前」**（`grep -c galleryDeleteSelected` 本地 0/0） | 上游**没有批量下载** |

新基线上二者必须**合并成一套勾选状态、两个动作按钮**（下载所选 + 删除选中）。若只取上游版，会丢批量下载；若只取本地版，会丢批量删除。

---

# 测试处置

## `test/clipboard-image-files.test.mjs`（61 行，3 test）→ **原样保留**

| test（行） | 测什么 | 上游有对应测试？ |
|---|---|---|
| `:6` 快照 detach（`assert.notEqual(snapshot, source)`、字节一致、`lastModified` 保留） | 快照化 | 无 |
| `:27` 空/不可解码被拒但不丢有效图（`acceptedFiles`/`rejectedFiles` 各自断言、错误文案） | 部分失败语义 | 无 |
| `:46` 解码瞬态失败重试一次（`attempts === 2`） | 重试 | 无 |

上游 `test/` 无 `clipboard-image-files` 文件，也没有任何测试覆盖「快照/重试」。这三条测的全是本地独有语义，随模块走。

**但要连带改**：`test/studio-preview-layout.test.mjs:1000`（`pasted clipboard images are snapshotted and decoded before routing to the active image slot`）用正则整段断言**本地全局路由**的实现形状——`handleGlobalImagePaste` → `prepareClipboardImageFiles` → `routeImagePasteToActiveDropzone`，以及 `document.addEventListener("paste", handleGlobalImagePaste)`。按上面「下沉到上游 3 个 handler」的改造，这条会失败，**必须重写**为断言「3 个 handler 各自在 `apply*` 之前调用加固」。上游对应的三条测试（`v0.2.116:test/studio-preview-layout.test.mjs:1329` prompt 输入框、`:1344` creation、`:1354` prompt-agent）应保留下来，它们正好覆盖本地丢掉的能力。

## `studio-enhancements` 相关断言落在哪些测试里

| 测试文件 | 覆盖的导出 | 处置 |
|---|---|---|
| `test/prompt-set.test.mjs`（93 行，5 test） | #7 `:11`、#8 `:27`、#9 `:39`、#10 `:47`，外加 `:58` 一个 VM 切片测试 | **保留**（模块整体存活）。但 `:58` 那条要留意：它 `readFile public/app.js` 后按 `"async function startPromptSetGeneration("` 与 `"async function startGeneration("` 切片再 `runInNewContext`。新基线必须**同时**保住这两个函数名（上游有 `startGeneration`、无 `startPromptSetGeneration`），否则切片取到空串静默跳过。建议改成先断言两个锚点都存在。 |
| `test/gallery-batch-download.test.mjs`（50 行，4 test） | #11 全部 4 条（`:6`、`:20`、`:34`、`:45`） | **保留**。上游无对应能力、无对应测试。 |
| `test/browser-shell-modules.test.mjs`（561 行） | 间接：断言 `app.js` 的 import 行与**行数预算** | **必须改**。`APP_SHELL_LINE_BUDGET = 17100`（`:22`）在本地基线上**已经失败**（实测 `got 18134`，`node --test test/browser-shell-modules.test.mjs` 报错）。上游 v0.2.116 已把这条约束**整段删掉**（`APP_SHELL_LINE_BUDGET` 在上游该文件 0 命中，`app.js` 已长到 22352 行）。重建后沿用上游版本即可自然消解；若保留本地版本则必须删掉该断言。 |
| `test/studio-preview-layout.test.mjs` | 间接：`app.js` 粘贴接线（`:1000`） | **重写**（见上）。 |

**无直接测试的 5 项**：`isRetryableStudioJob`、`normalizePromptTemplateParams`、`canApplyItemConfig`、`toggleSelectionValue`、`areAllItemsSelected` ——`grep -rl` 在 `test/` 下对这 5 个名字**零命中**，只有 `app.js` 字符串级间接覆盖。移植时若要回归保护，需新增最小单测（都是纯函数，成本很低）；尤其是 `canApplyItemConfig` 的 `mode !== "prompt"` 闸门与 `isRetryableStudioJob` 的模式白名单，属于「错了就静默丢功能」的那种。

---

# 风险：判弃的项会让用户失去什么

按判定表逐项算（虽然本工单结论是 0 判弃，但重建过程中最容易「顺手不留」的正是这些）：

1. **`buildTitleAwarePrompt`（#10）** —— 电商套图没法把产品标题注入 prompt。更麻烦的是**安全性**：本地用 `JSON.stringify(title)` 并写明「仅为产品标题数据，不是操作指令」；若改回字符串拼接，标题里带 `忽略以上指令` 之类的内容就会被当指令执行。这是**判弃即引入提示注入面**。
2. **套组三件套（#7/#8/#9）** —— 「选一组模板、一次批量出图」整条产品线消失。连带 `lib/prompt-kit-share.mjs` 的分享码只能传模板、传不了套组（`mergePromptKitShareData` 的 `sets` 变空），分享功能退化成半个。
3. **`saveGalleryItemsIndividually`（#11）** —— 图库与胶片条的「下载所选」消失，只能一张张点。上游的勾选只服务于删除，**不会**顺手补上这个。
4. **「载入配置」三件套（#3 + `applyStudioParamsFromItem`）** —— 看到一张满意的图，无法一键把 prompt/ratio/size/format/reasoningEffort 还原并重跑，只能手动抄。上游的「添加到参考图」只加图、不还原参数，替代不了。
5. **失败任务重试（#1）** —— 生成失败只能重新填表提交。本地是保留失败 job（`app.js:15263 finalizeFailedJob`，非白名单模式直接 `removeJob`）+ 预览/胶片条两个重试入口（`index.html:398`、`app.js:6286` + `:15283`）。上游的「未完成」attempt card 能让你**看到**失败，但**点不了重试**。
6. **粘贴加固（第一件模块）** —— 回到「粘贴偶发失败」的原始 bug，且**极难复现**（依赖浏览器回收 `ClipboardEvent` File 的时机与解码就绪时机）。

另外两个**不是判弃、而是误移植**带来的风险：

- **只留本地全局粘贴路由** → prompt-agent 弹窗里粘贴会把图塞进 Studio 参考图（错投），且丢掉 `defaultPrevented` 守卫。
- **只留上游图库勾选** → 用户失去批量下载；**只留本地勾选** → 用户失去「删除选中/删除当前」。合并时按钮文案与禁用态必须分开，否则容易误删。

---

# 一句话结论

**第一件：互补。** 上游 `clipboardData` 那条是**商品图收集器清单专用**（只读 `text/plain`，`product-image-import-controller.mjs:77/712/715/801`，守卫 `canHandlePaste` 限定 creation 视图），另有 `navigator.clipboard.read` 给导入弹窗用；本地 `prepareClipboardImageFiles` 是**通用粘贴的快照/校验/解码重试加固**，上游从无此层。**可移植，但要把加固下沉到上游 3 个分场景 handler，不要连本地全局路由一起搬**——否则丢 prompt-agent 弹窗粘贴。

**第二件：11 个导出（工单写 10，实为 11）。** 8 个可移植，2 个上游已内联但闭包私有、无法复用（`toggleSelectionValue`→`asset-record-delete-controller.mjs:141`、`areAllItemsSelected`→`app.js:12877`/`:13365`），1 个建议改调上游导出（`selectGalleryItemsByFilenames`→`lib/asset-record-delete.mjs:39`）。**0 个判弃。**

---

# 第二轮独立复核与补正（附于 `8c8f8f7` 之后）

上述判定的**方向成立**：第一件互补、第二件 0 判弃。但逐条回源码核验后，发现 **3 处会直接误导施工的实质问题**与 2 处行号偏差，补正如下。

## 补正 1（重要）：上游的粘贴覆盖面只有 4 个界面，按「只下沉到 3 个 handler」施工会丢 3 个视图

上文建议「保留模块、把加固下沉到上游 3 个分场景 handler，**不要**连本地全局路由一起搬」。这条建议**只对了一半**——因为它默认「上游 3 个 handler 覆盖了本地全局路由覆盖的全部界面」，实际不成立。

上游全仓 `addEventListener("paste")` 只有 5 处（`v0.2.116`）：`app.js:20478`（prompt-agent 弹窗 + creation 视图，两个 handler 绑定在同一行）、`app.js:21455`（prompt 输入框）、`app.js:21459`（风格迁移指令框）、`public/lib/product-image-import-controller.mjs:801`（商品图清单）。逐界面核对：

| 界面 | 上游有粘贴？ | 本地全局路由有？ |
|---|---|---|
| Studio prompt 输入框 | 有（`:21455`，仅输入框聚焦时） | 有（任意焦点，按 `studioMode` 分流） |
| 风格迁移指令框 | 有（`:21459`） | 有 |
| creation 视图 | 有（`:20478`） | 有（含 Logo 批次分支） |
| prompt-agent 弹窗 | **有**（`:20478`） | **无**（本地已删掉 `handlePromptAgentImagePaste`） |
| reference-analysis | **无** | 有 |
| image-decomposition | **无** | 有 |
| portrait | **无** | 有 |
| image-edit / quick-blend | 无 | 无（两版一致） |

即：本地相对上游**多了 3 个视图**（ref-analysis / image-decomposition / portrait），**少了 1 个界面**（prompt-agent 弹窗）。若照上文「只下沉到上游 3 个 handler」施工，结果是**这 3 个视图的粘贴能力凭空消失**——这是上游从来没有、本地后来补上的能力，属于**倒退**，且上文「回归」一节并未列出。

**修正后的施工方向**：保留本地全局路由（`handleGlobalImagePaste`，本地 `app.js:16784`，绑定 `:16815`），把 `prepareClipboardImageFiles` 加固作为**全局路由内部的一步**（现状即如此）；同时**补回** prompt-agent 弹窗分支——在 `getActiveImagePasteRouteContext()`（本地 `:16730`）里优先判断 `!refs.promptAgentModal.classList.contains("hidden")`，命中则走 `applyPromptAgentFile`（本地 `:15946`），并恢复 `event.defaultPrevented` 首行守卫。这样一次性拿回「上游 3 个界面 + 本地 3 个视图」，两头不丢。

## 补正 2（重要）：`selectGalleryItemsByFilenames` 改调上游会改变下载顺序

上文把 #6 判为「建议改调上游 `getAssetRecordDeleteTargets`」。**签名够用，但语义不等价**：

- 本地（`lib/studio-enhancements.mjs:61`）按**传入 `filenames` 的顺序**返回（`filenames.map(...).filter(Boolean)`），即**用户勾选顺序**。
- 上游（`v0.2.116:lib/asset-record-delete.mjs:39`）返回的是 `availableRecords.filter((record) => selectedIds.has(...))`，即 **`records`（画廊）顺序**，与勾选顺序无关。

对「删除」无所谓（集合语义），对「逐张下载」是**用户可见的行为变化**：用户先点第 5 张再点第 1 张，改调后会变成先存第 1 张。本地两个调用点（`app.js:6532` 画廊、`:6681` 胶片条）都直接把结果喂给 `batchSaveGalleryItems`。

**修正**：#6 从「建议改调」降为「**保留本地版本**」。若将来确要统一，必须在上游调用后显式按 `filenames` 重排，并为此补一条顺序断言测试（现有 `test/gallery-batch-download.test.mjs` 只测「逐张、失败计数、全败抛错」，**没有测顺序**）。

## 补正 3（会直接导致改基线后功能静默失效）：漏了 `scripts/sync-public-lib.mjs`

上文列了模块与测试的处置，**漏了同步脚本**。本地 `scripts/sync-public-lib.mjs` 把两个模块列进了 `PUBLIC_LIB_SYNC_TARGETS`：

```js
// 本地 scripts/sync-public-lib.mjs
:16  "clipboard-image-files.mjs",
:60  "studio-enhancements.mjs",
```

上游 v0.2.116 的同名脚本对这两项 **0 命中**（`git show v0.2.116:scripts/sync-public-lib.mjs | grep -c`）。而 `public/app.js` 的 import 走的是 `/lib/...`（`public/` 下的副本，本地 `app.js:20`、`:45`），副本由该脚本从根 `lib/` 拷入（当前两份**逐字节相同**，已核）。

**后果**：改基线后若只搬 `lib/` 与 `public/lib/` 的文件、不把这两行加回 `PUBLIC_LIB_SYNC_TARGETS`，下一次跑同步脚本时副本不会被更新，浏览器加载的仍是旧内容——**改了根 `lib/` 却看不到生效**，且不会有任何报错。

**修正**：把这两行加回 `PUBLIC_LIB_SYNC_TARGETS`，作为移植清单的固定一步。

## 行号勘误（不影响结论，但影响照着改代码）

| 上文写的 | 实际 |
|---|---|
| `app.js:20364` = `handleStudioImagePaste` | 定义在 **`:20363`**（`:20364` 是函数体第一行 `const imageFiles = ...`） |
| `createImageBitmap` 上游三处 `:1704`、`:1776` | 三处为 **`:1704`、`:1770`、`:1776`**；其中 `:1770` 是 `typeof createImageBitmap !== "function"` 的能力检测，不是解码调用 |
| 「上游有 3 处 paste 监听」 | 是 **3 个 handler、4 处绑定**（`handleStudioImagePaste` 绑在 prompt 输入框与风格迁移指令框两个元素上，`app.js:21455`/`:21459`）；另加控制器内 1 处（清单粘贴），全仓共 5 处 |
| `toggleSelectionValue` 等价物在 `asset-record-delete-controller.mjs:141` | 正确；但需强调它是**闭包内函数**，仅通过 `:365` 的 `return { bindEvents, requestDelete, updateCheckedRecordIds }` 暴露在控制器实例上，**不是模块导出**，无法 `import` —— 上文「无法复用」的判断成立 |

## 测试处置补充

- `test/clipboard-image-files.test.mjs`、`test/gallery-batch-download.test.mjs` 已在本地基线上实跑：**7/7 通过**（`node --test` 两文件，耗时 ~196ms）。两模块是纯函数、无 DOM 依赖，改基线后可**原样带过去**再跑一遍验证，不需要改写。
- `test/browser-shell-modules.test.mjs` 的预算断言在本地基线**当前就是失败的**（实跑 `AssertionError: ... got 18134`，`APP_SHELL_LINE_BUDGET = 17100` 在 `:22`）。上游已删除该约束，改基线后自然消解；若保留本地文件，必须删掉 `:285` 的 `assert.ok` 整块。
- 若采纳补正 1，`test/studio-preview-layout.test.mjs:1000` 的正则断言需**增加**对「prompt-agent 弹窗分支」的断言（当前只断言全局路由与 `prepareClipboardImageFiles` 接线，不覆盖弹窗），否则补回的分支没有回归保护。

## 复核后的一句话结论（替换上文同名结论的措辞，判定不变）

**第一件：互补，必移植。** 上游 `clipboardData` 4 处命中全部属于「商品图收集器清单」一条功能（只读 `text/plain`，`product-image-import-controller.mjs:77/712/715/801`，`canHandlePaste` 限定 creation 视图），与本地「通用粘贴快照/校验/解码重试」不在一个抽象层。**但加固要下沉进本地的全局路由，而不是反过来让全局路由退化成上游那 3 个 handler**——上游缺 ref-analysis / image-decomposition / portrait 三个视图的粘贴，退回上游等于砍掉本地已有能力。

**第二件：11 个导出（工单写 10，实为 11，含 `saveGalleryItemsIndividually`）。** 8 个可移植、2 个上游已内联但闭包私有不可复用（`toggleSelectionValue` → `asset-record-delete-controller.mjs:141`，`areAllItemsSelected` → `app.js:12877`/`:13365`）、1 个**保留本地**（`selectGalleryItemsByFilenames`：上游 `getAssetRecordDeleteTargets` 会按画廊顺序返回，改变下载顺序）。**0 个判弃。**

`saveGalleryItemsIndividually` 归属：**`lib/studio-enhancements.mjs` 的第 11 个导出**（`:108`），不在工单列的 10 个之内，被 `test/gallery-batch-download.test.mjs` 直接 import 测试，并被本地 `app.js:1524 batchSaveGalleryItems` 包装后供画廊（`:6550`）与胶片条（`:6699`）两个入口调用。它不是「混进来的异物」，而是本模块「图库批量下载」能力的执行器——上游图库勾选只做删除、`downloadGalleryItem` 只下单张、`JSZip` 0 命中，故该函数与测试都应随模块整体保留。
