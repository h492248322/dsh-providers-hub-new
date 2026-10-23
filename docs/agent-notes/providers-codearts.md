<!-- 新建（2026-10-21）：本仓库的主 provider 一直没有专属笔记，这条缺陷史与取证方式
     都是「改之前必须先读」的，故单独成文件。按需阅读，不进每轮注入。 -->

## CodeArts 的上下文窗口：**上游不下发**，且缺它会让用户的占用条整条消失

### ⚠️⚠️ 真实报障（2026-10-21）

用户原话：「codearts 对话后，DSH 下方本该显示上下文窗口占用比的地方没有显示」，
并补充「好像是 glm-5.3 文本对话有这个问题」。**不是**配置项问题，也**不是**
「我们没解析后端返回的字段」。

### 判据链（宿主侧，**不在本仓**，改之前先照抄这几行去核对版本）

`dsh-client-ui-conversation/lib/client.js`：

```js
function contextOccupancy(pressure) {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null
  return { percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)), ... }
}
// ContextMeter 里：
if (context === null) return null
```

⇒ **缺任一个输入 ⇒ 环 + 百分比 + 弹层整条不渲染**（不是显示 0%，是根本不出现）。

| 输入 | 来源 | 本家状态 |
|---|---|---|
| `usedTokens`（分子） | `dsh-token-meter` 读 `assistant/message.usage`，`pressureFrom = inputTokens + cacheReadTokens + cacheWriteTokens` | ✅ **一直是好的**（实测 glm-5.3 上报 `inputTokens:37482, cacheReadTokens:448`） |
| `contextWindow`（分母） | `dsh-agent-loop` 写 `request/context` 事件，值 = 适配器 `resolveModel()` 的 `context.contextWindow` | ❌ **本家唯一会出错的地方** |

⚠️ 顺带记：**`assistant/attempt` 的 `usage` 不可靠**（实测常常 `undefined`、
`stream: []`）—— 但 token-meter 有 `assistant/message.usage` 这条腿，故分子不受影响。
排查时**不要**看到 `assistant/attempt.usage === undefined` 就以为「usage 没上报」。

### 落盘铁证：同一会话内切模型，条就消失

`~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd` 里逐行对照：

```
model/selection:  {"provider":"codearts","model":"deepseek-v4.1-flash"}
request/context:  {"provider":"codearts","model":"deepseek-v4.1-flash","contextWindow":1000000}   ← 有 ⇒ 条在
model/selection:  {"provider":"codearts","model":"glm-5.3"}
request/context:  {"provider":"codearts","model":"glm-5.3"}                                        ← 无 ⇒ 条消失
```

复核脚本（解 zstd、抽 `request/context`）见会话 `session-fd3e2786` 的取证方式；
**判据是 `request/context` 事件里有没有 `contextWindow` 键**，不是看 UI。

### ⚠️⚠️ 上游两个目录端点**都不下发窗口**（2026-10-21 只读探测实测）

- `snap-access /v1/model/builtin` 的条目**键全集**：
  `channel_source, credit, display_enabled, enable, intervals, model_category,
   model_desc, model_id, model_name, model_sku, provider, supports_images, time_slots`
  ⇒ **无任何 context/window/length/token 类字段**（8 条模型逐条核对）。
- `opengw gateway/config`：本机 4 个账号**全回** `4000 invalid channel, group not found`
  （所以别指望从它取窗口；也不要因为它 4000 就以为凭据坏了 ——
  `/v1/model/builtin` 用同一个账号是 200）。
- ⚠️ 探测脚本必须**遍历账号池**：本机第一份凭据（`CODEARTS_ACCESS_TOKEN`）已 401，
  只试它一个会得出「上游不可达」的**假结论**。

⇒ 窗口的权威来源是 **IDE 自己下发的 provider 配置**，不是 HTTP 端点。

### 权威取值：IDE 内核日志的 `limit.context`

位置：`~/.codeartsdoer/codearts-data/log/kernel-*.log`，搜
`provider models replace body is` / `global config models`：

```json
"provider":{"inferhub-provider":{"models":{
  "GLM-5.2":{"id":"GLM-5.2","limit":{"input":1044480,"output":65536,"context":1048576}},
  "glm-5.3":{"id":"glm-5.3","limit":{"input":1044480,"output":65536,"context":1048576}},
  "glm-5.2-sft-harmony":{"id":"...","limit":{"input":196608,"output":131072,"context":202752}},
  "openpangu-2.0-pro":{"id":"...","limit":{"input":512000,"output":131072,"context":524288}},
  "deepseek-v4.1-flash":{"id":"...","limit":{"input":1044480,"output":65536,"context":1048576}}
}}}
```

⚠️ **这个值会变，而且变过**（本机 42 份日志，2026-09-11~10-21 按日期收敛）：

| 模型 | 历史 |
|---|---|
| `GLM-5.2` | 09-11~10-20 = `202_752` ⇒ **10-21 起 = `1_048_576`** |
| `glm-5.3` | 10-17 起出现，先 `202_752` ⇒ **10-21 起 = `1_048_576`** |
| `glm-5.2-sft-harmony` | 全期 `202_752` |
| `openpangu-2.0-flash` / `-pro` | 全期 `524_288` |
| `deepseek-v4.1-flash` | 全期 `1_048_576`（本仓曾写 `1_000_000`，**是错的**） |

⚠️⚠️ **留旧值 `GLM-5.2 = 202_752` 有两个静默后果**（与 `officeace-product.ts`
那次「估值偏小 5.3 倍」**逐字同因**）：① 占用比被封顶成 100%（分母小 5 倍）；
② 自动压缩阈值 = `0.8 × 202752 ≈ 162K` ⇒ **1M 的能力永远吃不到**。
⇒ 校准窗口时**两个出口一起想**（占用条的分母 + 压缩阈值），别只看 UI。

### 修法（三条腿，缺一条就会复发）

1. **静态表** `src/llm-adapter.ts` 的 `CONTEXT_WINDOWS` 逐模型校准（写来源+日期）；
2. **具名兜底** `CODEARTS_FALLBACK_CONTEXT_WINDOW = 524_288`（用户 2026-10-21 选定：
   取当前目录**最小真实窗口**；偏小 ⇒ 偏早压缩不报错，偏大 ⇒ 未知模型可能
   **上游溢出报错**一轮对话报废 ⇒ 取偏小一侧）。纪律与
   `aggregate-adapter` 的 `AGGREGATE_COLD_CONTEXT_WINDOW` 同型：**宁给具名兜底、不省略**；
3. **骨架回调** `ModelCatalogConfig.unknownModelContextWindow?(modelId)`
   —— **可选**，只有声明它的家生效（当前**仅 codearts**）。其余 12 家行为逐字不变。

### ⚠️⚠️ 两条踩过的坑（都实测过，别再犯）

1. **回调必须传 `modelId`**：第一版写成无参、直接返回常数兜底 ⇒ `glm-5.3` 在
   窗口表里是 1M，却**不在静态兜底目录 `DEFAULT_MODELS` 里** ⇒ 离线/首次启动
   时它算「目录外 id」⇒ 拿到 `524_288`（**分母错 2 倍**），而它正是报障模型。
   ⇒ 实现必须是 `codeartsContextWindow(modelId)`「**表内优先、查不到才兜底**」。
   ⚠️ 这是**全量测试**（10191 条里的 1 条红）抓出来的，不是审计想出来的。
2. **`listModels` 的返回值里没有 `contextWindow`**：DSH 契约
   `LlmModelInfo`（`dsh-llm/lib/types/types.d.ts`）**只有**
   `provider/id/name/description/inputModalities`；`context?: {contextWindow}`
   只存在于 **`LlmResolvedModelInfo`**（`resolveModel` 的形状）。
   ⇒ 守卫**不能**断言 `listModels` 带窗口（我第一版就这么写，恒红）。
   **契约形状写错会让守卫「假红」，与假绿一样有害**。

### 守卫与变异验证（`tests/unit/codearts-context-window.spec.ts`）

| 变异 | 结果 |
|---|---|
| 目录条目改回 `...cond ? {...} : {}`（缺陷原形） | ①② 红，点名 `glm-5.3` / `GLM-5.2` |
| `unknownModelContextWindow` 改回无参常数 | ③ 红 + 跨家不变式 g 红 |
| 骨架对未知 id 普遍给 `200_000` | **17 条红，逐家点名**（证明其余各家仍受约束） |
| 回调改回 `() => CODEARTS_FALLBACK_CONTEXT_WINDOW` | ③c 红（精确复现上面那个缺陷） |

跨家不变式 (g)「未知 id 不得编造 context」在 `model-catalog-parity.spec.ts`，
现为「**默认禁止 + codearts 具名例外**」；例外**改判据**（必须等于具名常量），
**不是** `if (id !== 'codearts')` 跳过断言 —— 后者会让 codearts 这条完全无牙。
⚠️ 该不变式此前对 **15 家全部有牙**（文件头注有反向验证记录），改它时要保住这一点。
=======

## ⚠️⚠️ 图片输入：只有 VL 模型能收图，且 DSH 会按模态把图**投影成文字**

### 报障与结论（2026-10-21）

用户：「codearts 发送图片后端模型不支持图片，发送带图的信息会直接跳出提示阻止发送，
但 CodeArts IDE 发送识图任务是支持识图的」。

**结论：IDE 不是让文本模型收图，而是两段式** —— 先用 VL 模型看图、把结果变成文字，
再交给主模型。判据来自本机 IDE 内核日志：

```
builtin-model-service  "[fetchMultimodalModelId] Response: {...8 个模型...}"
builtin-model-service  "[fetchMultimodalModelId] Success, selected multimodal model: kimi-k2.6-vl,
                        candidates: kimi-k2.6-vl, Qwen3-VL-235B"     ← 11 次采样恒定选它
provider-models-plugin "global config multimodalModels:" 0=... 2=kimi-k2.6-vl
```

`analyzeImage` 是 IDE 的一个**工具**（描述原文：*Analyse image or images by ID, file path,
or base64 data and extract information such as OCR text, objects, layout, colors…*；
参数 `imageId`/`imagePath`/`imageBase64` 三选一，*Data is processed in memory only*）。

### 谁能收图（`/v1/model/builtin` 的 `supports_images`，8 条逐条实测）

| 模型 | `supports_images` | `model_category` |
|---|---|---|
| `kimi-k2.6-vl` / `Qwen3-VL-235B` | **true** | **图片理解** |
| `glm-5.3` / `GLM-5.2` / `glm-5.2-sft-harmony` / `openpangu-2.0-flash` / `-pro` / `deepseek-v4.1-flash` | false | 文本生成 |

### ⚠️⚠️ wire 形态**四选一**，只有一种被接受（实测）

对两个 VL 模型各发一张 8×8 纯色 PNG、问颜色：

| 形态 | 结果 |
|---|---|
| **`{type:'image_url', image_url:{url:'data:…'}}`** | **200，答对颜色** ✅ |
| `{type:'image_url', image_url:'data:…'}`（字符串） | 406 `InferHub.001001046` |
| `{type:'image', source:{type:'base64',…}}` | 400 `ModelArts.81001` unsupported content type |
| `{type:'input_image', image_url:…}` | 406 `InferHub.001001046` |

反向对照：同一形态发给 `glm-5.3` 得
`InferHub.001001020.406 The request model is not multimodal` ⇒ 判据有判别力。

⚠️ 本机 IDE 日志里 `image_url` **零命中** —— IDE 走自家内部通道，没留下 wire 形态，
所以这一格**只能实测**，不能从日志抄。

### ⚠️⚠️ DSH 侧：模态声明是**唯一开关**，它决定图会不会被换成文字

`dsh-llm/lib/index.js:2337`（dispatch 前）：

```js
if (modelInfo.inputModalities !== void 0
    && !modelInfo.inputModalities.includes('image')
    && projectedMessages.some(m => contentHasImage(m.content)))
  projectedMessages = projectImagesForTextModel(projectedMessages)
// → 每张图被替换成 textOnlyImageText(ref)：
//   "[image omitted because this model accepts text only; attachment sha256:…]"
```

⇒ **声明里没有 `image`，图根本到不了适配器**（在宿主就被换成一行占位文字）。
官方 `read_image` 的 `assertImageCapableRoute` 用的也是同一个判据。

### 三条接线（本次改动）

1. `CODEARTS_VL_MODELS` + `codeartsAcceptsImage()`：**逐模型**判能力（大小写不敏感）；
2. `toCatalogEntry` 与 **`unknownModelInputModalities(modelId)`** 都要按 id 判 ——
   ⚠️⚠️ VL 模型**刻意不在对话目录里**（上下文小、不支持工具调用），所以
   `resolveModel('kimi-k2.6-vl')` 走的是**「目录外」分支**，只有后者生效。
   第一版只改了 `toCatalogEntry`，实测恒红（真缺陷，见守卫 ①）；
3. `serializeMessages` 改用共享实现（`openai-compat.ts`），配 `readImage` 桥接 +
   `codeartsImagePart()` 产出唯一被接受的形态。

### ⚠️ 两条踩过的坑

1. **`prepareCall` 里原有一行硬覆盖**：`{ ...await resolveModel(...), inputModalities: ['text'] }`
   ⇒ 只要目录开始按模型区分模态，这行就**静默抹平**它。症状是「VL 模型明明声明了
   image，发图仍被拒」，且两处代码各自看都对。守卫 ④ 钉住「两者必须一致」。
2. **本家原有一份只处理文本的私有 `serializeMessages`**（注释还写着「图片被丢弃」）。
   在它上面加图片腿 = 同一语义两套实现 ⇒ 改为复用共享实现，并**删掉**原来那条
   「CodeArts 与 openai-compat 互相对拍」的用例（合并后 `f(x)===f(x)` 恒真，
   属同义反复，本仓纪律不允许留着充数）。

### 验证

- 单测：`codearts-image-input.spec.ts` 7 条（模态正/反向、VL 不在目录、prepareCall
  一致、大小写、wire 形态、识图模型选择）；变异验证两处均精确变红（回调恒 false →
  ① 红；prepareCall 加回硬覆盖 → ④ 红）。
- 真实端到端（2026-10-21，第三个账号）：发**蓝色** 8×8 PNG 给 `kimi-k2.6-vl`，
  回答「蓝色（我实际看到的是一张1x1像素的纯蓝色图片，RGB值为(0,0,255)）」⇒
  图真的到了上游。
- ⚠️ 排查时的坑：反复开流式会话却不消费完响应体会**占满并发槽**，后续请求回
  `TM.00001041 并发会话数已达上限(3个)`（甚至以 404 形式出现）—— 那不是代码缺陷，
  **等槽位释放或换账号**即可。

### ⚠️⚠️ `analyzeImage` 真机验收抓出的真缺陷：已拼好的 `image_url` 被**静默丢弃**

**症状**（极具误导性）：`analyzeImage` 工具返回「我无法看到您提到的图片」。
HTTP 200、正文正常、上游零报错 —— 因为**图根本没发出去**。

**成因（两处同因的门禁，必须同修）**：

1. `openai-compat.ts` 的 `userContentParts()` **只认 harness 原生**
   `{type:'image', attachment}`（拿 `imageUrls` 表查字节），对
   **已拼好的** `{type:'image_url', image_url:{url}}` **零命中** ⇒ 该块被丢弃。
   ⚠️ 而 `analyzeImage` 的识图请求是**插件自己构造**的（不是 harness 派生历史），
   它正是把图直接拼成目标形态后交给 `adapter.stream()`。
2. `serializeMessages()` 里 `imageUrls === undefined` 时**整段跳过**
   `userContentParts` ⇒ 即使第 1 条修好，识图请求（**不传** `imageUrls`）
   也走不到那里。⇒ 判据改成「有映射表 **或** 内容里本来就带 `image_url` 块」。

**为什么原有用例没抓到**：它们只测 `{type:'image', attachment}` 那条路
（配 `imageUrls` 表）。「已拼好的块」是**另一条入口**，零断言 ⇒ 从缝里漏过。
守卫 ⑪~⑬（`codearts-analyze-image.spec.ts`）补上，两处改动**各自都有牙**
（分别撤掉任一处，⑪ 都精确变红）。

**⚠️ 排查过程里的两个坑（都真实踩到）**：

1. **`fetchImpl: async () => new Response('nope', {status: 404})` 会把所有请求拦掉**
   —— 我的 e2e 脚本里留了这个桩，于是看到「HTTP 404」并误以为是上游问题，
   还据此怀疑过并发槽。**桩必须在真机验收时移除**，否则验的是桩。
2. **变异验证「全绿」先怀疑变异没注入**（本仓已登记过同款）：该文件是 **CRLF**，
   而我的脚本用 LF 匹配多行锚点 ⇒ `replace` 静默不生效 ⇒ 误判「改动无判别力」。
   ⚠️ **跨行锚点在 CRLF 文件上必须用单行锚点或做行尾归一**，并且**先打印
   `锚点存在: True/False` 自证**，未命中要报「未注入」而不是「无牙」。

**真机验收（2026-10-22）**：16×16 纯绿 PNG，`glm-5.3`（文本模型）经工具识图，
返回「整个画面为**亮绿色**（近似荧光绿，RGB 可能接近 #00FF00）… 图片中没有任何文字」
⇒ 图真的到了上游，且描述准确。
