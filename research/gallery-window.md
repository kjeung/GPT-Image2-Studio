# Gallery 10 张窗口模型在上游分页架构下的存活研判

- **基线**：`v0.2.116`（`7b7f8f6`）
- **被研判对象**：本地独有 `lib/gallery-window.mjs`（`research/gallery-window` 基于本地 HEAD `bba3694`）
- **上游同名模块**：无（`git show v0.2.116:lib/gallery-window.mjs` → `fatal: path ... does not exist`）

> **先更正工单里的一个事实**：`lib/gallery-window.mjs` 实际是 **126 行**，不是 424 行。
> `git log` 显示它只在两个提交里存在：`e58e83e` 起建 103 行，`bba3694` 补到 126 行。
> 工单里"424 行左右"的说法与仓库不符，后文一律以实测 126 行为准。

---

## 结论

### 需重做（**不是**可移植，也**不是**判弃）

判定分两步，两步结论方向相反，必须分开说：

**第一步：上游的日期分页并没有覆盖窗口模型想解决的问题，所以不能判弃。**
上游 5 天/页的分页单位是**日期分组**，不是**图片数量**；`paginateGallerySections` 只切 section 的个数，
**每个 section 内部不做任何数量上限**——`createGallerySection` 把 `section.items` 全量塞进 masonry
（`public/app.js:7778`），`getGallerySectionLayout` 也只按**总条目数**算列数、不截断（`lib/gallery-organizer.mjs:354-364`）。
因此"一页"的瓦片数完全由"这 5 天里堆了多少张图"决定，没有上界。实测（用上游自己的模块跑）：

| 场景 | 上游 page 1 实际画的瓦片数 |
|---|---|
| 3000 张挤在 2 个日期 | **3000 / 3000**（`totalPages = 1`） |
| 3000 张，26 个日期，其中一天突发 800 张 | **1240 / 3000** |
| 单日突发 800 张 | **800** |

本地提交 `e58e83e` 里那句"一页仍等于整个库"的断言是**成立的**，不是自说自话。
所以窗口模型面对的是一个上游至今仍在的真缺陷 → **判弃会直接丢掉能力**。

**第二步：但它不能原样移植，因为本地当前的实现已经和上游分页语义打架了。**
本地 `renderGalleryView` 是"**先窗口、后日期页**"的两级串联：

```js
// public/app.js:6899-6908（本地）
const renderWindow = paginateGalleryRenderWindow(visibleItems, state.galleryRenderLimit);
const allSections = renderWindow.sections;
const pagination = shouldPaginateHistory
  ? paginateGallerySections(allSections, state.galleryHistoryPage)
  : getSearchGalleryPagination(allSections);
const sections = pagination.sections;
```

`paginateGalleryRenderWindow` 先把全量截成 10 张（`lib/gallery-organizer.mjs:301-320`），
再用 10 张里生成的日期分组去过一次 `paginateGallerySections`。这是**两个互相竞争的上界**，不是正交的两级。
实测这个组合会吃掉已经加载好的数据：

```
窗口 = 10 张，恰好跨 10 个日期 → page 0 只画 5 张（另 5 张被"下一页"藏起来），totalPages = 2
```

已经 fetch 到手的 10 张里有一半要用户再点一次"下一页"才看得到——这是本地实现自身的语义 bug，
原样搬到新基线会把这个 bug 一起搬过去。所以是**需重做**。

### 重做后的新模型：「两级正交」——日期页选"哪些日期"，窗口限"当前页画多少张"

两个轴必须**正交**，而不是串联：

1. **日期轴（保留上游）**：`buildGallerySections` → `paginateGallerySections(allSections, page)`，
   5 天/页不变，`getGallerySectionLayout` / `getGalleryHistorySectionLayouts` 的自动列数/行列分配全部保留
   （本地把这套整块丢了，见下文"遗失项"）。
2. **数量轴（来自本地）**：窗口上限作用于**当前日期页之内**，不作用于全库。
   `paginateGalleryRenderWindow` 的入参从"全量 items"改成"当前页的 items"，并且**不再二次套 `paginateGallerySections`**。
3. **加载更多**：先在本页把窗口从 10 涨到 20、30…；本页日期分组画尽后，再翻到下一日期页。
   顺序是"先页内扩窗、后翻页"，取代本地现在的"先窗口、后翻页"。
4. **数据轴**：`/api/gallery` **回到全量**（见"必须撤掉的服务端限流"），`state.gallery` 重新持有全库。

#### 要改的函数（精确到导出名）

| 处置 | 位置 | 函数 / 说明 |
|---|---|---|
| **改签名** | `lib/gallery-organizer.mjs:301-320` | `paginateGalleryRenderWindow(items, limit)` → 入参改为"当前日期页的 items"；`nextLimit` 保留；`sections` 字段要么去掉、要么改成描述页内分组 |
| **保留** | `lib/gallery-organizer.mjs:289-296` | `normalizeGalleryRenderLimit` 原样可用 |
| **保留** | `lib/gallery-window.mjs:58-66` | `resolveNextGalleryRenderLimit` 原样可用（纯窗口宽度递推，与日期页无关） |
| **保留** | `lib/gallery-window.mjs:81-103` | `mergeGalleryWindowItems` 原样可用（按 filename 去重 + newest-first） |
| **改语义** | `lib/gallery-window.mjs:24-54` | `resolveGalleryLoadMoreState`：删掉 `needsServerPage` 分支与"加载更多（读取磁盘）"文案，`hasMoreOnServer` 入参移除；改为区分"页内还能扩窗" vs "该翻日期页"两种文案 |
| **改语义** | `lib/gallery-window.mjs:109-117` | `shouldBackfillGalleryWindow`：去掉 `hasMoreOnServer` 条件，只按"已加载 < 窗口宽"判断（删除后回填变成纯本地行为） |
| **保留但重解释** | `lib/gallery-window.mjs:122-126` | `resolveBackfillGalleryLimit` = `renderLimit + 1`，`+1` 从"探测服务端是否还有"改述为"补齐缺口的探测位"，逻辑不变 |
| **删除** | `lib/gallery-window.mjs:69-77` | `shouldFetchMoreGalleryFromServer`：全库在内存后没有"服务端分页"这个轴，整个函数失去意义 |
| **删除** | `lib/gallery-window.mjs:15`、`:41` | `GALLERY_UNKNOWN_TOTAL_LABEL`（"…"）：totalCount 恒已知，占位符没必要存在 |
| **重写** | `public/app.js:6892-6934` | `renderGalleryView`：去掉"窗口 → 日期页"串联，改成"日期页 → 页内窗口" |
| **重写** | `public/app.js:15358-15375` | `fetchGalleryWindow`：不再发 `?limit=N`、不再读 `X-Gallery-Has-More` |
| **重写** | `public/app.js:15401-15441` | `loadMoreGallery`：删掉 server fast-path，改为"页内扩窗 / 翻页"二选一 |
| **简化** | `public/app.js:15443-15472` | `backfillGalleryWindowAfterDelete`：去掉 `hasMoreOnServer` 分支，本地回填即可 |
| **简化** | `public/app.js:15785-15830` | `clearHistory`：`fetchAllGalleryItemsForDelete`（`:15834-15846`）可删，因为 `state.gallery` 又持有全库 |
| **必须恢复** | `lib/gallery-organizer.mjs`（本地缺失） | 上游 `getGallerySectionLayout`（`v0.2.116:328-365`）、`getGalleryHistorySectionLayouts`（`:367-377`）及常量 `:3-6`，本地整块没移植 |
| **必须恢复** | `public/app.js:6852-6890`（本地 `createGallerySection`） | 现在用 `Math.min(section.items.length \|\| 1, getGalleryColumnCount())`（`:6877`）自算列数；应改回接受 `columnCount` 入参（对齐上游 `:7752-7789`） |

#### 必须撤掉的服务端限流（这是重做的核心，不是附赠项）

本地把 `/api/gallery` 改成有界返回，这是窗口模型的**数据侧配套**，而它和上游的前端架构正面冲突：

- `server.mjs:656` `GALLERY_DEFAULT_LIMIT = 10`；`:661-675` `parseGalleryLimit`；`:681-707` `handleGalleryGet` 返回 `X-Gallery-Has-More`
- `lib/gallery-store.mjs:1257` `listGalleryItems({ limit })` 收满即停

上游前端的所有筛选/分页 UI 都假定**全库在手**：`getVisibleGalleryItems` 直接 `filterGalleryItems(state.gallery, …)`
（`v0.2.116:7641-7643`），`buildGalleryTimeFilterOptions` / `buildGallerySizeFilterOptions` 也在全量上算计数
（`v0.2.116:7692-7694`），`paginateGallerySections` 的 `totalPages` 依赖全库的日期数（`:306`）。
一旦服务端只给 10 条，本地就会出现这些**已有**的静默退化（这是 `e58e83e` 引入的回归，不是既有行为）：

- 搜索只搜已加载的 10~20 张 → 用户搜"猫"在 3000 张库里搜不到（`public/app.js:17818-17822` 直接重渲染，不重取）
- 日期筛选器的 `count` 数字只统计窗口内的图
- 日期分页器 `totalPages` 从 7 掉到 1~2 页
- `clearHistory` 被迫补一次全量重取（`:15799`），等于把刚省下的 2.5s 又花回去（只在清空时）

**结论性判断**：本地窗口模型真正有价值的成分是**纯客户端的渲染预算**（DOM 瓦片数上限），
而不是**服务端的有界返回**。后者为了省一次首屏扫描，把上游整套"客户端全量筛选"架构的地基抽掉了。
重做应当**只保留渲染预算，撤掉服务端限流**。

---

## 依据：两套分页语义对照

### 上游 v0.2.116

**`buildGallerySections`（`lib/gallery-organizer.mjs:505-522`）——按日期分区，不按数量**

```js
 505  export function buildGallerySections(items, referenceNow = new Date()) {
 506    const sections = new Map();
 508    for (const item of sortGalleryItemsByCreatedAtDesc(items)) {
 509      const sectionKey = toDateKey(item.createdAt) || "未标记日期";
 511      current.push(item);
 515    return [...sections.entries()].map(([key, sectionItems]) => ({
 516      key,
 519      count: sectionItems.length,
 520      items: sectionItems,      // ← 该日期的全部条目，无截断
```

**`paginateGallerySections`（`:299-322`）——分页单位是 section 个数**

```js
   2  export const DEFAULT_GALLERY_HISTORY_DAYS_PER_PAGE = 5;   // 5 个日期 / 页
 299  export function paginateGallerySections(sections, page = 0, pageSize = DEFAULT_GALLERY_HISTORY_DAYS_PER_PAGE) {
 306    const totalPages = Math.max(1, Math.ceil(sourceSections.length / resolvedPageSize));
 309    const pagedSections = sourceSections.slice(startIndex, startIndex + resolvedPageSize);
```

**`getGalleryHistorySectionLayouts`（`:367-377`）——每 2 个日期成组算行列，与数量上限无关**

```js
 371    const groupSize = Math.max(1, Math.floor(Number(options.groupSize) || DEFAULT_GALLERY_LAYOUT_SECTION_GROUP_SIZE));
 373    for (let index = 0; index < sourceSections.length; index += groupSize) {
 374      layouts.push(...getGallerySectionLayout(sourceSections.slice(index, index + groupSize), options));
```

`getGallerySectionLayout`（`:328-365`）用 `itemCount / allocatedRows` 反推列数（`:357`），**没有 `slice`**：
`columnCount = ceil(itemCount / allocatedRows)` 恰好保证"所有条目都必须有位置"。单日 800 张 → `columnCount=18`、`rowCount=45`。

**渲染链（`public/app.js`）**

```js
 7791  function renderGalleryView() {
 7793    const visibleItems = getVisibleGalleryItems();          // 全库筛选
 7794    const allSections = buildGallerySections(visibleItems);
 7796    const pagination = shouldPaginateHistory
 7797      ? paginateGallerySections(allSections, state.galleryHistoryPage)
 7798      : getSearchGalleryPagination(allSections);
 7803    const displayedCount = getGallerySectionItemCount(sections);
 7806    const historyLayouts = shouldPaginateHistory && layoutMode === "desktop" ? getGalleryHistorySectionLayouts(allSections) : [];
 7878      refs.gallerySections.appendChild(createGallerySection(sections[index], layout.columnCount));
```

一次画多少张 = **本页所有日期的全部条目之和**，无上限；"加载更多"在画廊里**不存在**，
只有上一页/下一页（`:7673-7677`、`:21717-21720`）。删除后不做回填（`:19352` 只 `filter` + `renderAll`），
因为它从不缺位置——页面永远是"某些日期的全部"。这一点反过来证明上游根本没有数量窗口的概念。

**上游真正的解药是缩略图，不是限流**：`lib/gallery-thumbnail.mjs:10-11`
（`THUMBNAIL_MAX_EDGE = 512`、`THUMBNAIL_QUALITY = 72`）+ `/api/gallery/thumbnail`（`server.mjs:7462-7464`），
tile 用 `getThumbnailUrl`（`public/app.js:7586-7587`）。**本地没有这套**（`git ls-tree v0.2.0 lib/` 无 thumbnail，
本地 `lib/` 也无），本地 tile 用的是全尺寸 `getImageUrl`（`public/app.js:6440-6441`）。
所以上游在"每张 tile 变便宜"上做了一半，在"tile 个数有界"上**没做**。

### 本地

**`paginateGalleryRenderWindow`（`lib/gallery-organizer.mjs:301-320`）——全局 newest-first 数量窗口**

```js
   7  export const DEFAULT_GALLERY_RENDER_LIMIT = 10;
   8  export const GALLERY_RENDER_LIMIT_STEP = 10;
 301  export function paginateGalleryRenderWindow(items, limit = DEFAULT_GALLERY_RENDER_LIMIT, referenceNow = new Date()) {
 306    const sortedItems = sortGalleryItemsByCreatedAtDesc(items);
 308    const visibleItems = sortedItems.slice(0, resolvedLimit);
 313      sections: buildGallerySections(visibleItems, referenceNow),   // ← 窗口内的日期分组
 316      hiddenCount: Math.max(0, totalCount - visibleItems.length),
```

`gallery-window.mjs` 的六个决策函数（`:24-54`、`:58-66`、`:69-77`、`:109-117`、`:122-126`）全是纯函数，
围绕"窗口宽度 / 是否要再读磁盘 / 删除后回填"三件事，与日期无关：

```js
  37    const needsServerPage = Boolean(hasMoreOnServer) && !hasHiddenLocally;
  65    return Math.max(current + resolvedStep, current, normalizeCount(knownCount));   // 只增不减
 116    return Boolean(hasMoreOnServer) && resolvedKnown < resolvedLimit;              // 删除后回填
 125    return normalizeGalleryRenderLimit(renderLimit, DEFAULT_GALLERY_RENDER_LIMIT) + 1;
```

`+1` 探针是这套模型的精妙处：`renderLimit + 1` 既补齐删除造成的缺口，又顺带告诉前端"窗口之外还有没有"。

### 语义对照表

| 维度 | 上游 v0.2.116 | 本地 |
|---|---|---|
| 分页单位 | **日期分组**（5 天/页） | **图片数量**（10 张/窗口） |
| 一页瓦片上界 | **无**（取决于这些日期堆了多少张） | **有**，10 → 20 → 30 递增 |
| 日期分组是否保留 | 是，页内按日分组 | 是，但只对窗口内的 10 张分组（`organizer.mjs:313`） |
| 翻页控件 | 上一页/下一页（`app.js:7673`） | "加载更多（10 张）"+"下一页"**并存**（本地 `index.html:2232-2235` 与 `galleryPagination` 同时存在） |
| 删除后 | 不处理（从不缺位） | 回填 `renderLimit + 1`（`app.js:15443-15472`） |
| 服务端 | 全量返回（`server.mjs:1406-1413`） | `?limit=N` + `X-Gallery-Has-More`（`server.mjs:681-707`） |
| 单张 tile 成本 | 512px webp 缩略图 | 全尺寸原图（`app.js:6440-6441`） |
| 自动列数/行列分配 | `getGallerySectionLayout` + `getGalleryHistorySectionLayouts` | **丢弃**，改用 `min(items.length, presetColumns)`（`app.js:6877`） |

**能否共存？** 能，但**不能串联**。本地现在把窗口当"第一级上界"、日期页当"第二级上界"（`app.js:6899-6908`），
两级都在切同一份列表，于是已加载数据被二次隐藏（实测 10 张跨 10 天 → 只画 5 张）。
共存的正法是**正交**：日期页决定"看哪些天"，窗口决定"当前这页画多少张"。这样上游的 5 天/页、
自动列数、搜索模式单页全都原样保留，而"单日 800 张"由窗口挡在 10/20/30。两者互补，不是替代。

**本地的窗口模型是否多余？** 不**多余**——上游的日期分区解决的只是"跨天的浏览组织"，
没有解决"同一天堆几千张"的渲染量；实测 3000 张挤 2 天时上游一页画 3000 张。
但它**有一半是多余的**：服务端 `?limit` 那半边与上游"客户端全量筛选"架构冲突，应当撤掉；
客户端渲染预算那半边是有价值的，应当留下。

---

## 测试处置

### `test/gallery-window.test.mjs`（169 行，10 个 test）→ **改写保留**

10 个 test 分两类，处置不同：

| test（行号） | 断言内容 | 处置 |
|---|---|---|
| `:14-28` 窗口在未画完时显示加载更多 | `hiddenCount=2990`、`needsServerPage=false`、`totalCount="…"` | **改**：去掉 `totalCount`/`GALLERY_UNKNOWN_TOTAL_LABEL` 与 `needsServerPage` 断言，保留 `shouldShow`/`hiddenCount` |
| `:30-39` 已画完才找服务端 | `buttonText="加载更多（读取磁盘）"` | **删**：服务端分页轴取消，测试对象消失 |
| `:41-50` 全库刚好装下时隐藏控件 | `totalCount="3"` | **改**：保留 `shouldShow=false`、`statusText=""`，`totalCount` 改为恒真值断言 |
| `:52-60` 加载中禁用 | `disabled=true` | **原样保留** |
| `:62-68` 下一窗口只增不减 | 10→20、10/known45→45、0→20 | **原样保留**（核心不变量） |
| `:70-92` 由 renderWindow 而非原始计数决定取服务端 | 三个 `shouldFetchMoreGalleryFromServer` | **删**：函数本身要删 |
| `:94-112` 合并按 filename 去重且 newest-first | 顺序 + 元数据覆盖 | **原样保留** |
| `:114-131` 删除开洞时回填 | `hasMoreOnServer` 三态 | **改**：去掉 `hasMoreOnServer` 入参，保留"9/10 回填、10/10 不回填"两态，删掉"9/10 + 无更多 → 不回填"这条 |
| `:133-160` 连续删除不得误报空态 | 12 步循环 | **改**：`hasMoreOnServer` 固定移除；`knownCount` 下界改为 0 时停止回填的语义需重定义（全库在手时窗口会自然吃满，这条要按新模型重写） |
| `:162-168` 回填请求宽 = renderLimit+1 | 11 / 21 / 0→11 | **原样保留**（`+1` 语义不变，只是不再读盘） |

另需**新增**一条本地现在没有、而重做必须钉住的测试：
**"窗口不得二次吞掉已加载数据"** —— 构造 10 张跨 10 个日期的窗口，断言
`paginateGalleryRenderWindow` 之后不再被 `paginateGallerySections` 二次切分，
即当前页应画满 10 张、`totalPages` 不回退。这条测试正是本地 `app.js:6899-6908` 那个 bug 的回归防护。

### `test/gallery-batch-download.test.mjs`（50 行，4 个 test）→ **与本工单无关，随功能走**

必须先说明：这个文件 **不测窗口模型**。它 `import { saveGalleryItemsIndividually } from "../lib/studio-enhancements.mjs"`
（`:4`），测的是"批量下载逐张保存 / 统计失败 / 全失败抛错 / 容忍非数组"四件事（`:6`、`:20`、`:34`、`:45`）。
而 `lib/studio-enhancements.mjs` 是**本地独有模块**（`git cat-file -e v0.2.116:lib/studio-enhancements.mjs` → 不存在），
由本地提交 `4a5376b`（"carry the workbench improvements…"）带入，并已登记进 `scripts/sync-public-lib.mjs:60`。

所以：
- **判弃窗口模型不会牵连它**，**移植窗口模型也不需要它**。二者只是同目录相邻。
- 它的处置应当**跟随 `lib/studio-enhancements.mjs` 这个模块的去留**，而后者属于"本地独有能力逐个研判"的另一张工单，
  不在本研判范围内。
- 建议：原样随 `studio-enhancements.mjs` 一起移植；若该模块被判弃，则本测试文件一并删除。
  **不要把它的存废和窗口模型的结论绑在一起**。

### 附带：`test/gallery-organizer.test.mjs` 也要跟着改

本地版 379 行 / 18 test，上游版 365 行 / 18 test，数量相同但**内容已正交分裂**：

- 本地新增 3 条窗口测试（`:316` 默认 10 张、`:350` 窗口增长、`:368` 非法 limit 回落）
- 本地**丢掉了**上游 3 条布局测试（`v0.2.116:322` 三行放大稀疏日期、`:334` 跨页两日尺寸、`:354` 三行装不下时保留完整日期）
- 两边共有但已改写 1 条（`paginates waterfall history by five dated sections`，本地去掉了 "complete" 语义）

重做后应：保留本地 3 条窗口测试（改造成"页内窗口"）、**恢复上游 3 条布局测试**、
共有那条恢复 "complete" 语义。

---

## 风险

### 如果判弃（把窗口模型整个扔掉）

用户会重新吃回 `e58e83e` 里实测的那组数字，而且是**在上游缩略图只能部分缓解**的情况下：

1. **首屏与服务器压力**：`/api/gallery` 回到全量扫描。本地实测 3000 张 = 5.85MB / 2.5–3.0s（首次 6.2s），
   而且 `listGalleryItems` 是逐文件 `stat` + 侧车元数据读取（`lib/gallery-store.mjs` 循环体），
   上游 `handleGalleryGet`（`server.mjs:1406-1413`）没有任何缓存或分片。
   上游的缩略图省掉的是**图片字节**，省不掉**目录扫描与逐文件 IO**。
2. **DOM 与请求数**：单日堆几百上千张时，一页仍是几百上千个 `<img>`。
   `loading="lazy"` 挡不住预取（`e58e83e` 已实测 3001 tile 触发 1003 个图片请求），
   缩略图把 17.2MB 压小，但不改变"1000 个请求 + 1000 个 DOM 节点"这件事。
   低端机与移动端会重新卡顿，滚动/面板高度同步（`app.js:7881-7882`）会跟着抖。
3. **删除后的空态幻觉**：上游删除不补位（`v0.2.116:19352`），而它的页面是"日期的全部"，
   删空某一天会整段消失、日期页数从 N 变 N-1，`state.galleryHistoryPage` 可能越界后被 `Math.min` 夹回（`:307`），
   用户会看到"页码跳变 + 当前页内容突变"——本地 `bba3694` 修的那类问题在上游是**换一种形式存在**。

### 如果按本文重做

要付出的是**一个新窗口期的回归面**，且这些点都是用户直接可见的：

1. **首屏变慢**：撤掉 `?limit` 后首屏必定回到全量扫描，2.5–3.0s 的等待会回来。
   缓解手段只有上游缩略图（省字节）+ 可能的增量索引缓存，都不在本次重做范围内。
   这是**为了换回正确的搜索/筛选/总页数**而主动做的取舍，必须在 PR 说明里写清。
2. **筛选/搜索功能短暂不可用**：在"全库回内存"落地前，若先上线页面内窗口，
   搜索仍然只能搜到已加载部分。建议**同一次提交内**把数据轴与渲染轴一起改完，不要分两步发。
3. **`clearHistory` 的行为要重新验证**：`fetchAllGalleryItemsForDelete`（`app.js:15834-15846`）删掉后，
   清空历史依赖 `state.gallery` 是完整的；若中途有并发新增/删除，需要确认不会漏删。
   这是破坏性路径，回归成本高。
4. **翻页与扩窗的交互复杂化**：现在有两个"前进"动作（页内扩窗、翻日期页），
   按钮文案与禁用态的组合从本地现有的 1 个（`resolveGalleryLoadMoreState`）变成 2 个，
   UI 状态数与测试组合数都会上升。本地现有的"加载更多（10 张）"文案必须重写，
   否则用户会看到"加载更多"和"下一页"两个语义重叠的按钮（本地 `index.html:2232-2235` 与 `galleryPagination` 已经并存）。
5. **丢失的自动列数需要补回**：本地 `app.js:6877` 的 `min(items.length, presetColumns)` 是退化实现，
   恢复上游 `getGalleryHistorySectionLayouts` 会改变现有瓦片密度观感（`v0.2.116:336-338` 的 3 行上限、
   4~18 列区间），用户会察觉排版变化。

### 一句话风险总结

**判弃** = 用"首屏 2.5s + 上千 DOM 节点"换"代码少一个模块"，代价是用户每次打开画廊都要付；
**重做** = 用"一次可控的首屏变慢回归"换"搜索/筛选/分页语义正确 + 渲染量有界"，代价集中在一次发版窗口内。
两者都会让首屏变慢——差别在于**判弃是永久的，重做是一次性的**。

---

## 附：工单事实勘误

| 工单说法 | 实测 |
|---|---|
| `lib/gallery-window.mjs` 424 行左右 | **126 行**（`e58e83e` 103 行 → `bba3694` 126 行） |
| 上游同名命中 0 | 成立（`v0.2.116` 无该路径；`lib/` 下 gallery 相关仅 4 个模块） |
| `grep 确认 buildGallerySections 命中 3 处` | 若限定"`public/app.js` 内的 import + 调用" 加 `lib/` 定义，恰为 3 处：`public/app.js:4`（import）、`public/app.js:7794`（调用）、`lib/gallery-organizer.mjs:505`（定义）。全仓（含 `test/` 与 `public/lib/` 镜像）另有 4 处，不作数 |
| 上游"按日期分区的五个 section" | 是"**每页 5 个日期 section**"（`DEFAULT_GALLERY_HISTORY_DAYS_PER_PAGE = 5`），不是"总共五个 section"；日期数无上限，`totalPages` 随日期数增长 |
| 本地 `lib/gallery-organizer.mjs` 多了 `DEFAULT_GALLERY_RENDER_LIMIT`、`normalizeGalleryRenderLimit`、`paginateGalleryRenderWindow` | 成立（`:7`、`:289-296`、`:301-320`）；但本地同时**丢了**上游的 `getGallerySectionLayout`、`getGalleryHistorySectionLayouts` 与 `:3-6` 常量，工单未提 |
