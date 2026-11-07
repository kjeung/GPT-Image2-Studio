# prompt-kit-share 分享码能力 vs 上游 v0.2.116 模板库体系

- **基线**：`v0.2.116`（`7b7f8f6`）
- **被研判对象**：fork 独有的 `lib/prompt-kit-share.mjs`（286 行）
- **上游同名模块**：无。`git cat-file -e 7b7f8f6:lib/prompt-kit-share.mjs` → 不存在
- **上游对应体系**：`lib/prompt-template-library.mjs`（251 行）+ `lib/prompt-template-taxonomy.mjs`（116 行）+ `lib/youmind-profile-entries.mjs`（29163 行）
- **议题**：map #1 子票 #3

---

## 结论速览

**判弃 → 不可。分享码是真缺口，8 个导出里 6 个可直接移植、2 个需裁剪 `sets` 形参。**

三层依据：

1. **上游有用户模板库，但它只有「本机单机自用」路径**。`public/app.js:857` 的 `state.promptTemplates` 存 `localStorage`（键 `image-studio-prompt-templates-v2`，`:183`），读写走 `readPromptTemplates`/`writePromptTemplates`（`:8062`/`:8077`），没有第二条出入口。
2. **上游 13 个模板库导出全是查询/计数/排序，零序列化**。`lib/prompt-template-library.mjs` 里 `share|encode|decode|payload|base64|JSON.stringify|serialize|CompressionStream` 命中 **0**。
3. **模板库不是分享码的上位替代，因为二者数据模型不同**。上游模板是 `{id, name, prompt}` 三字段（`public/app.js:8020-8033` 明确定义），没有 `params`、没有 `analyzeTitle`、**没有套组（`sets`/`templateIds`）**。全仓 `promptSets` / `templateIds` / `analyzeTitle` 命中均为 **0**。

> ⚠️ 关键限定：上游的 `PROMPT_TEMPLATE_LIBRARY` 是**内置**分类模板目录（作者侧预置、编译进源码），而分享码传递的是**用户自己**的模板与套组。前者是「目录」，后者是「搬运」。二者不构成覆盖关系。

---

## 一、上游 v0.2.116 模板库的完整能力面

`lib/prompt-template-library.mjs` 共 **13 个 export**（不是 12——`:16` 还有一组 re-export）：

| 行号 | 导出 | 性质 |
|---|---|---|
| `:16` | `PROMPT_TEMPLATE_SOURCES`、`YOUMIND_PROFILE_META`（re-export） | 常量透传 |
| `:26` | `PROMPT_TEMPLATE_SORT_OPTIONS` | 常量 |
| `:153` | `PROMPT_TEMPLATE_LIBRARY` | `Object.freeze` 的内置目录树 |
| `:157` | `normalizePromptTemplateLibraryModel` | 模型 id 归一 |
| `:170` | `flattenPromptTemplateLibrary` | 按 category/subcategory/model 展平 |
| `:193` | `sortPromptTemplateLibraryTemplates` | featured/latest/name 三档排序 |
| `:211` | `getPromptTemplateLibraryCategory` | 查分类 |
| `:215` | `getPromptTemplateLibrarySubcategory` | 查子分类 |
| `:219` | `getPromptTemplateLibraryChildCount` | 计数 |
| `:228` | `getPromptTemplateLibraryCategoryCount` | 计数 |
| `:232` | `getPromptTemplateLibraryModelCounts` | 计数 |
| `:241` | `getPromptTemplateLibraryCounts` | 计数 |
| `:249` | `getPromptTemplatePreviewUrl` | 取 `previewImage` 字符串 |

**没有一个是序列化、反序列化、编码、解码、导入或导出。** 分类定义在 `lib/prompt-template-taxonomy.mjs:7/:13/:17/:29/:100/:105`（全部 `Object.freeze` 常量），数据源 `lib/youmind-profile-entries.mjs:9`（520 条记录）。

用户侧模板的存取路径（`public/app.js`）：

| 行号 | 函数 | 说明 |
|---|---|---|
| `:857` | `state.promptTemplates: []` | 用户模板唯一容器 |
| `:8062` | `readPromptTemplates` | 只从 `localStorage` 读 |
| `:8077` | `writePromptTemplates` | 只写 `localStorage` |
| `:8020` | `normalizePromptTemplate` | 只保留 `id`/`name`/`prompt` |
| `:8551` | `savePromptTemplate` | 新建/编辑，字段固定三样 |
| `:8605` | `deletePromptTemplate` | 单条删除 |

面板 DOM（`public/index.html:3750-3776`）只有 `newPromptTemplateButton` / `applyPromptTemplateButton` / `deletePromptTemplateButton` 三个动作，**没有任何导入/导出/分享控件**。

---

## 二、「上游以别的名字实现过」的排查

逐个查了工单点名的 5 个模块，并做了全仓伪命中排除：

| 模块 | `share` 命中 | 判定 |
|---|---|---|
| `prompt-template-library.mjs` | 0 | 无 |
| `prompt-template-taxonomy.mjs` | 0 | 无 |
| `prompt-attempt-deck.mjs` | 0（`:70` 仅有注释提到 `base64 data URLs`） | 生成结果预览图编码，与模板无关 |
| `prompt-agent-template-sync.mjs` | 0（只有 `importedTemplates` 这个词） | 从**图片反推历史**里回收模板（`:36` `isReusablePromptAgentHistoryEntry`、`:55` `mergePromptAgentHistoryTemplates`），同机历史→模板，不是跨用户 |
| `youmind-profile-entries.mjs` | 8 | **全为假阳性**：`:9386` 模板正文里的 `"An iOS share sheet..."`，`:9391` `sourcePage` URL 里的 `ios-share-sheet-popout-36421` |
| `prompt-agent.mjs` | 1 | **假阳性**：`:110` 提示词正文 `"...neutral colors shared by variants..."` |
| `prompt-agent-store.mjs` | 0 | 只有服务端历史 JSON 读写（`:31/:37`） |

全仓唯一的 `JSON.stringify(state.promptTemplates` 出现在 `public/app.js:8078`——写自己的 `localStorage`，不是导出。全仓也没有模板相关的压缩/编码实现（`btoa/atob` 只出现在 `browser-image-cache.mjs`、`creation-logo-library.mjs`、`responses-workflow.mjs` 的图片 data URL 处理里）。

上游自己也把这条划成 out of scope：`openspec/changes/archive/2026-09-22-refresh-prompt-kit-default-templates/proposal.md` 的 Non-Goals 明写 **「不新增模板管理能力、模板搜索、远程同步或服务端默认模板」**。

**结论：上游没有任何跨用户传递模板的能力，也没有别名实现。**

---

## 三、本地分享码能力与格式说明

### 3.1 编码了什么

`compactShareData`（`lib/prompt-kit-share.mjs:112-127`）打包三类东西：

```js
{
  v: 1,                                                             // 版本号
  t: [[id, name, prompt, params|null, analyzeTitle], ...],          // 用户模板
  s: [[id, name, templateIds, updatedAt], ...],                     // 套组
  a: [selectedTemplateId, selectedSetId, prompt, params,
      promptEnhanceEnabled, promptEnhanceText],                     // 当前编辑态
}
```

即：**模板（含每模板的生成参数与"按标题分析"开关）+ 套组（模板的有序引用集合）+ 发起方当前编辑态**。

### 3.2 什么格式

```
PROMPT-KIT.V1. + ("gz." | "b64.") + base64url( JSON(compact) )
```

- 前缀 `PROMPT-KIT.V1.`（`:2`），版本号既在字符串前缀里又在 JSON 的 `v` 里（`:1`）
- `gz.` 为 gzip（`CompressionStream`，`:165-171`，不可用则回落 `b64.`）
- `b64.` 为裸 base64url（`:163-173`）
- base64url 用手写 `bytesToBase64Url`/`base64UrlToBytes`（`:10-28`），浏览器无依赖
- 边界：`MAX_ENCODED_LENGTH=240_000`、`MAX_DECODED_BYTES=600_000`、`MAX_TEMPLATE_COUNT=200`、`MAX_SET_COUNT=100`、`MAX_TEMPLATE_NAME_LENGTH=80`、`MAX_PROMPT_LENGTH=12_000`（`:1-8`）
- 解析端容错：剥 ` ```txt ` 包裹、剥 BOM/空白、还原 `\_`/`\-` 转义、截断号检测（`:190-195`、`:233-243`）
- 错误面：全模块 `throw new Error` 共 17 处、**16 条不同文案**（非 9 条），编号见附录 A.3

#### 实测有效容量（比标称上限小得多）

标称 `MAX_TEMPLATE_COUNT = 200` 是**数组长度**上限，真正的拦路虎是 `MAX_DECODED_BYTES = 600_000`（UTF-8 **字节**）。实测（`encodePromptKitSharePayload`，中文提示词按下述长度）：

| 模板数 × 每条 prompt 长度 | 结果 |
|---|---|
| 10 × 3000 汉字 | OK，payload 703 字符 |
| 65 × 3000 汉字 | OK，payload 3005 字符 |
| **66 × 3000 汉字** | **拒绝**（`模板内容过多…`） |
| 70 / 100 / 200 × 3000 汉字 | 拒绝 |
| 150 × 3000 ASCII | OK |
| 190 × 3000 ASCII | OK |
| 200 × 3000 ASCII | 拒绝 |

成因：中文 1 字 = 3 字节，600 000 / 3 ≈ 20 万汉字总量；按编辑器单条上限 3000 字算，**约 66 条中文模板即封顶**，远早于 200 条。所以"最多 200 模板"这个说法只在"每条提示词很短"时才成立。

### 3.3 移植是否要改格式

**格式本身不用改，且建议原样保留。** 理由：

1. 前缀带版本号（`V1` + `v:1`），本就是为跨版本兼容设计的；
2. `t` 的模板形与上游 `state.promptTemplates` 兼容（子集）；
3. `s`、`a` 在上游暂时没有消费方，但**保留字段**可让 fork 之间继续互通、也让未来接回套组时不必换版本号。

**要改的是四处语义接缝**（见第四节）：`params`/`analyzeTitle` 会被上游的 `normalizePromptTemplate` 直接丢掉；`sets` 没有消费方；默认模板 id 会被上游迁移规则误杀。

---

## 四、逐函数结论表

| 导出（`lib/prompt-kit-share.mjs`） | 结论 | 理由 |
|---|---|---|
| `normalizePromptKitShareData`（`:83`） | **可移植** | 纯校验/裁剪函数，无浏览器全局、无 IO；只依赖自带的 `normalizeTemplate`/`normalizeSet`/`normalizeParams`（`:39-81`）。可直接落在 `lib/` 并加进 `scripts/sync-public-lib.mjs` |
| `encodePromptKitSharePayload`（`:158`） | **可移植** | 只依赖 `TextEncoder`/`Blob`/`CompressionStream`/`btoa`，Node 20（`package.json` engines `>=20`）与浏览器均有；无上游冲突 |
| `decodePromptKitSharePayload`（`:180`） | **可移植** | 对称实现 + 16 条可读中文错误文案（截断/编码/损坏/版本/过旧浏览器各有专句）；`DecompressionStream` 缺失时有兜底提示。无上游冲突 |
| `formatPromptKitShareCode`（`:225`） | **可移植** | 一行加前缀，零依赖 |
| `parsePromptKitShareCode`（`:233`） | **可移植** | 前缀校验 + TXT 容错（BOM/折行/Markdown 转义），零依赖 |
| `mergePromptKitShareData`（`:245`） | **可移植（需裁剪 `sets` 形参）** | 合并语义本身是纯的（共享侧优先、按 id 去重、本地无关项保留）。但签名 `(localTemplates, localSets, sharedValue)` 与返回 `{templates, sets, active}` 里 `sets` 一半语义依赖上游不存在的套组模型；该部分随议题 #2 的判定走 |
| `movePromptTemplateInList`（`:264`） | **可移植** | 纯数组换位、返回新数组、越界返回原样。**上游完全无对应能力**：`movePromptTemplate|templateOrder|dragTemplate` 命中 0，`promptTemplateBatch` 命中 0（即上游连批量删都没有，只有 `:8605` 单条删） |
| `removePromptTemplatesFromLibrary`（`:276`） | **可移植（需裁剪 `sets` 级联）** | 「按 id 集合批量删模板」是纯函数；「并从所有套组移除引用」这一半依赖套组模型，同上随 #2 |

**没有任何一个导出属于「已被覆盖」。** 上游模板库的 13 个导出解决的是「浏览内置模板」，与「搬运用户模板」在数据模型与使用场景上都不相交。

### 移植时必须处理的四处接缝

1. **模板字段收窄（会静默丢数据）**
   上游 `normalizePromptTemplate`（`public/app.js:8020-8033`，`return` 块在 `:8028-8032`）只返回 `id/name/prompt`，而本地同名前身（`public/app.js:7075-7088`，多出的两个字段在 `:7086-7087`）还保留 `analyzeTitle` 与 `params`。分享码的 `t[3]`（`params`）与 `t[4]`（`analyzeTitle`）一旦经过上游 `readPromptTemplates` 就会被丢掉——**分享能导入，但刷新后参数与"按标题生成"开关消失**。移植时必须先扩上游 `normalizePromptTemplate`（属 #2 `studio-enhancements` 的范围，`lib/studio-enhancements.mjs:13` `normalizePromptTemplateParams` 即为其支撑）。

2. **默认模板 id 会被迁移规则误杀（高优）**
   本地默认模板 id 是 `default-template-${n}`（`public/app.js:105-107`），上游是 `default-template-v2-${n}`（`public/app.js:187-191`）；上游迁移用 `/^default-template-\d+$/` 判「旧内置」（`:8035-8037`）并在 `:8039-8055` 整批剔除。后果：**fork 用户把带 `default-template-N` id 的分享码导入上游构建后，下次启动刷新即被迁移逻辑清掉**。移植要么把 fork 默认模板数组合并为 v2 命名，要么给分享码里的内置 id 加命名空间。

3. **套组没有消费方**
   上游 `state.promptSets` / `PROMPT_SET_STORAGE_KEY` / `templateIds` 均 0 命中，也不存在多模板一次提交的 `startPromptSetGeneration`（本地 `public/app.js:7155`、`:7476-7514` 一带）。`s` 与 `a[1]` 只能先落库不消费，或按 #2 一并引入。

4. **`a` 会覆盖接收方的当前编辑态（实测，非推测）**
   `mergePromptKitShareData` 返回 `active: shared.active`（`:260`）——**无条件采用发送方**的编辑态。实测（`node --input-type=module` 直接调用）：

   ```js
   mergePromptKitShareData([{id:"t1",name:"接收方",prompt:"接收方提示词"}], [], shared)
   // → active.selectedTemplateId = "s1"      （接收方原本选中 t1）
   // → active.prompt = "对方编辑态"            （接收方编辑器正文被替换）
   // → active.promptEnhanceText = "对方增强文本"
   // 模板侧正确：templates = ["s1","t1"]，接收方模板未被删
   ```

   模板合并是对的（共享侧优先、按 id 去重、接收方无关项保留），**但"导入"同时把接收方正在写的提示词和增强文本换成了对方的**。这是产品语义问题而非 bug：上游 `applyPromptTemplate`（`public/app.js:8580`）也只往编辑器写 prompt 正文、没有"恢复他人编辑态"概念。移植时应决定：保留（等于"接手对方的现场"）还是导入后只合并模板、编辑态留空（更符合"分享模板"的预期）。**这一条草稿前文未记录，属本次新增。**

---

## 五、测试处置

### `test/prompt-kit-share.test.mjs`（184 行，13 个 test）

| test 行号 | 内容 | 处置 |
|---|---|---|
| `:43` | payload 往返模板/套组/编辑态 | **保留**（格式保留 `s`/`a`，断言不用改） |
| `:51` | 分享码独立于站点 URL | **保留** |
| `:58` | 相同 id 覆盖、无关模板保留 | **保留** |
| `:73` | 非法 payload 拒绝且不产空配置 | **保留** |
| `:78` | 上下移动保 id | **保留** |
| `:89` | 批量删并级联清套组引用 | **保留**；若 #2 判套组不移植，改写为只断言模板删除 |
| `:99` | 面板暴露导入/批量删/排序控件（DOM 断言） | **重写**。断言的是本地 `promptKitCodeInput`/`importPromptKitCodeInput`/`promptTemplateBatchDeleteButton` 与本地面板结构；上游 `public/index.html:3750-3776` 只有新建/插入/删除三键，需按新接线点重写 |
| `:111` | TXT 容忍 BOM/折行/Markdown 转义 | **保留** |
| `:118` | 损坏/截断码报可读中文错误 | **保留** |
| `:125` | 未压缩旧版 `b64.` 仍可导入 | **保留**（向后兼容锚点） |
| `:132` | 分享按钮产出可下载 TXT（`vm` + slice `sharePromptKit`） | **重写**。切片边界依赖本地 `public/app.js` 的 `async function sharePromptKit()` 与 `function setPromptKitCodeFeedback(`；上游函数体已重排，须重新定锚 |
| `:151` | TXT 选择读入/导入/重置 picker（slice `importPromptKitFile`） | **重写**，同上 |
| `:177` | `analyzeTitle` 随分享往返 | **保留**，但**会先红**：需先完成第四节接缝 1（扩上游 `normalizePromptTemplate`） |

净处置：**9 条保留、4 条重写、0 条删除**。`package.json` 的 `test` 是 `node --test ./test/*.test.mjs`，文件放回 `test/` 即自动纳入。

### `test/prompt-set.test.mjs`（93 行，5 个 test）

**它不测 `prompt-kit-share.mjs`。** 第 4-9 行从 `../lib/studio-enhancements.mjs` 导入 `buildTitleAwarePrompt`/`normalizePromptSet`/`removePromptTemplateFromSets`/`resolvePromptSetTemplates`。

- 5 条全部属于 `studio-enhancements.mjs` 的去留判定，即**议题 #2**，不随本工单处置；
- 但其中 `:58`（`startPromptSetGeneration` 逐模板套用标题）是**上游完全没有的能力**（`startPromptSetGeneration` 上游 0 命中），移植价值最高，建议 #2 优先保；
- `:47/:58` 依赖 `analyzeTitle`，与第四节接缝 1 是同一处改造，**两票应合并落地**，否则分享码与套组能力都半残。

> 建议：#2 与 #3 合并成一次提交。`mergePromptKitShareData` 与 `removePromptTemplatesFromLibrary` 的完整语义、以及 `analyzeTitle`/`params` 的存活，都跨在两张票之间。

---

## 六、风险

### 若判弃（不移植分享码）

用户失去**跨人传递提示词配置的唯一途径**，且上游没有任何替代：

1. **模板只能手抄**：上游模板存 `localStorage`，换设备/清缓存/换浏览器即归零；唯一可用手段是逐条复制 prompt 正文。分享码把整批模板压成一段文本（实测约 66 条 3000 字中文模板 / 190 条同长 ASCII 模板封顶，见 §3.2）。
2. **套组无法转移，甚至无法存在**：上游连 `templateIds`/`promptSets` 概念都没有，用户编排的「一次提交整套图」既导不出也建不了（后者属 #2）。
3. **编辑态无法交接**：`a` 携带选中的模板/套组、正在编辑的 prompt、增强开关与增强文本；判弃后只能截图。
4. **上游内置库补不上这个洞**：`PROMPT_TEMPLATE_LIBRARY` 是只读的 520 条作者目录，用户不能往里加，也不能把自己的模板塞进去分享给别人。

### 若移植但砍掉套组

分享码仍可传模板，但 `s` 恒空、`a[1]` 恒空，`mergePromptKitShareData` 与 `removePromptTemplatesFromLibrary` 各失去一半语义，且未来接回套组时要么换版本号要么做迁移。

### 移植本身的三个风险

1. **#2 依赖**：套组与 `analyzeTitle`/`params` 均依赖 `studio-enhancements.mjs`。若 #2 判弃，本票须降级为「只传模板」，且 `:177` 测试无法通过。
2. **接线点漂移**：本地 4 处接线（`public/app.js:21` import、`:7158` `buildCurrentPromptKitShareData`、`:7173` `sharePromptKit`、`:7200`/`:7219` 导入、`:17579-17588` 绑定）在上游 `public/app.js`（22352 行 / 1,016,996 字节，本地 18133 行 / 737,149 字节）里没有对应位置，必须重新定锚，不能照抄行号。
3. **同步清单**：本地 `scripts/sync-public-lib.mjs` 的 `PUBLIC_LIB_SYNC_TARGETS` 有 53 项、上游 112 项；需把 `prompt-kit-share.mjs` 加回清单，并用 `node scripts/sync-public-lib.mjs --check` 验证 `public/lib/` 与 `lib/` 一致（本地两份当前逐字节相同）。

---

## 附录 A：本次新增的实测证据

草稿结论未变（分享码是真缺口、8 个导出无一「已被覆盖」），以下四条是本轮**新增/补正**：

### A.1 `mergePromptKitShareData` 会用发送方编辑态覆盖接收方

```js
import { mergePromptKitShareData } from "./lib/prompt-kit-share.mjs";
const local = [{ id:"t1", name:"接收方", prompt:"接收方提示词" }];
const shared = { templates:[{id:"s1",name:"分享模板",prompt:"分享提示词"}], sets:[],
  active:{ selectedTemplateId:"s1", prompt:"对方编辑态", params:{ratio:"1:1"},
           promptEnhanceEnabled:true, promptEnhanceText:"对方增强文本" } };
const m = mergePromptKitShareData(local, [], shared);
// m.active.selectedTemplateId === "s1"      ← 接收方原本是 t1
// m.active.prompt === "对方编辑态"
// m.active.promptEnhanceText === "对方增强文本"
// m.templates === [s1, t1]                   ← 模板侧正确
```

根因在 `:260` `active: shared.active`。模板合并逻辑本身无误。

### A.2 标称 200 模板不可达：`MAX_DECODED_BYTES` 先封顶

| 模板数 × 每条 3000 字 | 结果 |
|---|---|
| 65 × 中文 | OK（payload 3005 字符） |
| 66 × 中文 | **拒绝** |
| 190 × ASCII | OK |
| 200 × ASCII | **拒绝** |

结论：中文场景约 66 条即满；编辑器单条上限本身是 3000 字（`public/index.html:2910`），
故 `MAX_TEMPLATE_COUNT=200` 实际不可达。移植时若要放宽，应提 `MAX_DECODED_BYTES` 而非模板数上限。

### A.3 错误文案是 16 条，不是 9 条

`grep -o 'throw new Error("[^"]*"' lib/prompt-kit-share.mjs | sort -u | wc -l` → **16**
（`throw new Error` 共 17 处，其中 1 条重复）。逐函数结论表 `decodePromptKitSharePayload` 一行原写「九类」，现已更正。

### A.4 上游零序列化的三重交叉验证

| 检查 | 命令 | 结果 |
|---|---|---|
| 模板库模块词汇 | `grep -cE 'share\|encode\|decode\|payload\|base64\|JSON.stringify\|serialize\|CompressionStream'` | **0** |
| 全仓套组/参数字段 | `git grep -c 'promptSets\|templateIds\|analyzeTitle' v0.2.116`（排除 openspec/docs） | **0** |
| 全仓分享口令词汇 | `git grep -li 'PROMPT-KIT\|shareCode\|sharePayload\|分享口令\|分享码' v0.2.116`（排除 openspec） | **0** |

唯一残留命中是 `openspec/changes/archive/2026-09-22-refresh-prompt-kit-default-templates/tasks.md`
里的「Prompt Kit」字样，与分享无关；该 change 的 `proposal.md:17` 还把
「不新增模板管理能力、模板搜索、远程同步或服务端默认模板」写进 Non-Goals。

---

## 七、复现命令

```bash
git -C /workspace/deployment/GPT-Image2-Studio worktree add --detach /tmp/r2-up v0.2.116

# 上游零序列化证据
cd /tmp/r2-up
grep -cE "share|encode|decode|payload|base64|JSON.stringify|serialize|CompressionStream" lib/prompt-template-library.mjs   # → 0
grep -nE "^export" lib/prompt-template-library.mjs                                                                       # → 13 项，全查询/计数/排序

# 上游无套组/参数字段
grep -rnE "promptSets|templateIds|analyzeTitle" --include=*.mjs --include=*.js . | grep -v node_modules | wc -l           # → 0

# 上游无分享/导入控件
grep -oE 'id="promptTemplate[A-Za-z]*"' public/index.html | sort -u   # → 只有 new/apply/delete 三键

# 本地分享码能力
grep -nE "^export" /workspace/deployment/GPT-Image2-Studio/lib/prompt-kit-share.mjs                                     # → 8 项
node --test /workspace/deployment/GPT-Image2-Studio/test/prompt-kit-share.test.mjs                                       # → 13 pass
```

---

## 一句话结论

**分享码是真缺口：上游有「内置目录 + 本机用户模板」，但没有跨用户搬运；上游 13 个模板库导出零序列化，`promptSets`/`templateIds`/`analyzeTitle` 全仓 0 命中。8 个导出全部可移植（`mergePromptKitShareData` 与 `removePromptTemplatesFromLibrary` 需裁掉 `sets` 形参），格式 `PROMPT-KIT.V1.` + `gz.|b64.` + base64url(JSON) 原样保留即可。移植前必须先解决四处接缝：`normalizePromptTemplate` 丢 `params`/`analyzeTitle`、`default-template-*` id 被上游迁移误杀、套组无消费方、`a` 覆盖接收方编辑态（前三条挂议题 #2，第四条需产品决策），故建议 #2/#3 合并落地。测试 9 保 4 改 0 删；`prompt-set.test.mjs` 整份归 #2。**
