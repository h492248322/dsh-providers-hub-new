# PR #1（Codely + 网关局域网开关）对抗性审计

**结论：不能合。** 作者宣称「修完 2×P0 + 1×P1 + 1×P2 并逐条补了有牙守卫」，实测 4 条修复本身**确有牙**（M1/M2/M3/M4 全部变红），但**同一批修复把三条新的 P0/P1 引进来了**（换发失败一律锁号到次日 0 点 + 引导用户删号、停滞续拉导致「流式正文 ≠ 落盘正文」、推理请求零超时），且他点名的「必须下发 tools / 必须读 finish_reason / 必须续拉」三处核心判据**一条用例都没有**（M13/M14/M15 全绿）—— 也就是说，他这轮补的守卫只覆盖了他自己改的那几行，**没覆盖他改的那几行所依赖的调用链**。

审计方式：`git worktree add --detach /d/jet/code/js/_audit-red 021ff8b4`（独立副本，**主工作树 `src/` 与 `tests/` 零改动**），变异注入用自写脚本（CRLF 感知 + 命中计数 + 片段自证，锚点未命中报 `PATCH-NOT-APPLIED` 而不是「无牙」）。基线：主树 `pnpm test` = **414 passed / 1 skipped、10304 passed / 6 skipped、0 failed**（与作者宣称一致）。

---

## 一、被打穿的（按严重级）

### A1 · P0｜换发失败一律写「次日 0 点」冷却，并把用户推向**删号**

- 文件：`src/codely-adapter.ts:667-690`（记账在 `:673`）、文案在 `:784-792`
- 我做了什么：

  ```
  # 探针（独立副本，忠实复刻 pool 的 updateModelRateLimit 写点）
  P5  换发时 fetch 抛 ECONNRESET（网络抖动）
    → marks = [{"accountId":"acc-1","resetAtMs":1792684800000},
               {"accountId":"acc-2","resetAtMs":1792684800000}]
    → error = PERMISSION_DENIED
       "codely: 换发 cli_api_key 失败（访问令牌可能已过期），已尝试 2 个账号均不可用。
        请删除该账号后重新「+ 新建账号」登录"
  P6  换发时上游回 500（上游故障）
    → marks 同上（两个号都锁到 1792684800000）
  P31 距 now 的小时数 = 11.15 小时（nextUtc8DayStartMs）
  ```

- 为什么是真缺陷：`fetchCodelyCliApiKey` 在**任何非 2xx 与任何网络异常**下都返回 `undefined`（`codely-auth.ts:593` + `:601`），而新代码把这一格**无条件**记成 `nextUtc8DayStartMs()`。后果链：
  1. 一次 5 秒的 DNS 抖动 / 上游 502，会让池里**每一个**账号被标记到次日 0 点 ⇒ 用户当天**再也选不到这些号**（`getAvailableAccount` 的 `modelRateLimits` 过滤腿会剔掉它们）；
  2. 文案把「网络不通」说成「访问令牌可能已过期」，并明确指示「**删除该账号后重新新建**」—— 删除账号 + `unset` 凭据是**不可逆**的，而用户手里其实是一个完好的凭据（本仓在 `docs/agent-notes/protocol-wire.md` 里把「删除不可逆」列为 P0 纪律，`failLogin` 的 `poolEntryOf → 'unknown'` 三态就是为它加的）；
  3. 这与作者在注释里写的「**不改变**作者的分档意图」相反 —— 他给 402 用的「额度耗尽到次日」语义，被复用到了一个**与额度无关**的分支上。
- 修法：换发失败必须**分档**——只有能确证是凭据失效（`401/403` 且 body 含 `invalid_token` / `expired`）才换号并记账；网络异常 / 5xx 走「传输级重试」或直接抛 `SERVER`（**不记账**，不锁号），文案不得引导删号。

---

### A2 · P0｜停滞续拉让「用户看到的正文」与「落盘正文」分叉，且重试不带历史

- 文件：`src/codely-adapter.ts:1080-1101`（判据在 `:1080`，递归在 `:1099`）
- 我做了什么：

  ```
  P20 三轮都只回短正文（A / B / C），带 tools
    → rounds = 4（一轮原发 + 3 次续拉）
    → 流式 text-delta = ["A","B","C","C"]        ← 用户屏幕上看到 4 段
    → block-end 次数 = 1
    → 最终 blocks = [{"type":"text","text":"C"}]  ← 只有最后一段
  P32 第 1 轮「我先看看。」/ 第 2 轮「已改好。」
    → 用户看到 = "我先看看。已改好。已改好。已改好。"
    → 落盘正文 = "已改好。"
    → 两者是否一致 = false
  P19 第二轮请求的 messages
    → [system(工具纪律), user("看一下目录"), user("（系统提示）…现在这一刻就调用工具执行…")]
    → 第二轮是否含上一轮 assistant = false
  ```

- 为什么是真缺陷：
  1. **同一段文字在界面上出现 3~4 次**（每轮续拉都把新正文追加到同一条流里），而落盘只有最后一份 ⇒ 用户截图/复制的内容与重开会话看到的内容**不一致**；
  2. 第一轮正文（「我先看看。」）**从未进入 `block-end`**，只在流里出现过 —— 它在落盘/回放路径上**丢失**；
  3. 续拉请求**没有把上一轮的 assistant 正文加进 `messages`**（`retryOptions.messages` 只追加了一条 user 提示）⇒ 模型不知道自己刚说过什么，只能重新生成一遍 —— 这既是重复文本的成因，也让「续拉」在语义上退化成「重发」；
  4. 递归调用 `streamViaHttp(retryOptions, retryBudget - 1)` **每一层都重新选号、重新换发 key、重新记账**（实测 P20 rounds=4 对应 4 次换发 + 4 次推理请求）—— 一次用户请求烧 4 次额度。
- 修法：续拉前必须把「本轮已产出的 assistant 正文（+ 已公告的工具调用）」作为 `assistant` 消息加进 `messages`；续拉的 chunk 不得追加到已关闭/已公告的同一条文本流（要么开新 index，要么把判据改成「先收齐再一次性下发」）；`stalled` 判据里 `text.trim().length < 500` 的副作用必须显式登记（它决定了「短回答被重复几次」）。

---

### A3 · P1｜推理请求与换发请求**都没有超时**，上游挂住即永久挂起

- 文件：`src/codely-adapter.ts:699-704`（推理 POST）、`src/codely-auth.ts:584-592`（换发 GET）
- 我做了什么：

  ```
  P34 探针：检查两处 fetch 的 init.signal
    → 推理请求的 signal = ABSENT
    → 换发请求的 signal = ABSENT
  # 对照：同仓 accio 的推理请求
  src/accio-adapter.ts:1993  signal: options.signal ?? AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS)
  ```

- 为什么是真缺陷：`options.signal` 只在宿主**主动取消**时才存在；用户不点「停止」时（最常见），`fetch` 没有任何时限。同文件里目录端点（`:1388`）、登录三步（`codely-auth.ts:242/301/381/415`）、积分与签到（`codely-credits.ts:100/265`）**全都**用了 `AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS)` —— 唯独「真正会长时间跑」的推理与换发两处没有。症状：上游半开连接 / 网关挂住 ⇒ 界面永久转圈，用户以为模型在思考。
- 修法：两处都改成 `signal: options.signal ?? AbortSignal.timeout(...)`（或 `AbortSignal.any([...])` 同时保留取消能力），超时值单独命名并登记（推理可能要长，30s 的目录超时不适用）。

---

### A4 · P1｜`unknownModelInputModalities` 与 `toCatalogEntry` 的能力表**分叉**，收缩目录时图片能力静默退化

- 文件：`src/codely-adapter.ts:248`（回调）vs `:1347-1359`（`toCatalogEntry` 用 `CODERLY_ABILITIES`）
- 我做了什么：

  ```
  P22 远端只下发 codely-basic（目录收缩）
    resolveModel('codely-basic') = { name: "codely-basic · 图片 | 工具", input: ["text","image"] }
    resolveModel('codely-flash') = { name: "codely-flash",              input: ["text"] }   ← 实测它收图
    resolveModel('codely-air')   = { name: "codely-air",                input: ["text"] }   ← 实测它收图
    resolveModel('codely-core')  = { name: "codely-core",               input: ["text"] }
  # 变异 M19：把回调改成查同一张 CODERLY_ABILITIES 表（正确修法）
    → codely-adapter.spec.ts + codely-adapter-errors.spec.ts = 23 passed / 0 failed（全绿）
    → 但 P22 的输出变成 codely-flash/air = ["text","image"]（修法有效且零用例变红）
  ```

- 为什么是真缺陷：`docs/agent-notes/providers-codearts.md` 逐字记过这条形态 ——「只改 `toCatalogEntry` 恒无效」「`unknownModelInputModalities` 是第二条腿」「只改一条腿，另一条静默退化」。codely 现在正好是**反过来的那一半**：`toCatalogEntry` 逐模型声明了能力（对），但 `resolveModel` 在「目录里没有该 id」时一律报 `['text']`。而「目录里没有」不等于「未知」——`CODERLY_ABILITIES` 是**实测白名单**，它知道 `codely-flash` 收图。DSH 的语义是 `['text']` = **明确不支持**（会把图片投影成文本占位）⇒ 用户发图给 `codely-flash` 时图**根本到不了适配器**，只看到「模型说它没看到图」。
- 附加证据（同一缺陷的第二面）：`:246-248` 的注释写「本渠道的多模态能力**未按模型实测过**」，而 `:1327` 的注释写「**真凭据 10 次请求**逐模型实测」—— 同一文件两套互相矛盾的陈述。
- 修法：`unknownModelInputModalities: (modelId) => CODERLY_ABILITIES[modelId]?.includes('image') === true ? ['text','image'] : ['text']`（已用 M19 实测：改动有效、零用例变红 ⇒ 需要补一条守卫）。

---

### A5 · P1｜`CodelyAuth` 是**不可用的死代码**，而文档写着「续期实现已就绪」

- 文件：`src/codely-auth-service.ts:131`（`refreshAll(pool, refreshOne)` 两参）、`src/index.ts:6`（import 后零使用）、`src/jet-hub-rpc.ts:1413`（文档声称就绪）
- 我做了什么：

  ```
  # 全仓引用普查
  $ grep -rn "new CodelyAuth" src/ tests/ plugin-src/ scripts/
  （零命中）—— src/index.ts:6 只有 import，从未实例化

  # 类型层（tsc 实测）
  $ npx tsc --noEmit ... typecheck-tmp.ts
  typecheck-tmp.ts(3,14): error TS2322: Type 'CodelyAuth' is not assignable to type 'JetHubAuthLike'.
    Types of property 'refreshAll' are incompatible.
      Type '(pool: unknown, refreshOne: (account) => Promise<void>) => Promise<void>'
        is not assignable to type '(pool: AccountPool) => Promise<void>'.
      Target signature provides too few arguments. Expected 2 or more, but got 1.

  # 运行期（按 index.ts 的包装写法 `refreshAll: (pool) => auth.refreshAll(pool)`）
  P13 → TypeError: refreshOne is not a function
  ```

- 为什么是真缺陷：接线清单（`provider-registry.ts:895` 与 `jet-hub-rpc.ts:1409-1414`）把「② `index.ts` 的 auths 对象传值 / ③ `SELF_HEAL_REFRESHABLE_PROVIDERS` 加 codely」写成**剩下两步**，并明确说「续期实现已就绪」。实际情况是：那个类**编译不过**（`JetHubAuthLike` 契约）且**运行期必抛**。下一轮审计/作者照文档接线，会得到「编译红 + 续期恒抛」，而症状会被 `refreshAll` 外层逐 provider 的 `try` 吞成一条 warn ⇒ **静默失效**（正是 officeace 那条「批量续期把同步池当 Promise」的同型）。
- 修法：要么把 `refreshAll(pool)` 改成符合契约的签名（`refreshOne` 由 `ProviderRuntime.auth` 的调用方提供不了 ⇒ 应改成内部自己遍历池并调 `refreshAccountCredential`），要么删掉该类并把接线清单改成「续期未实现」。**不允许**留一个「文档说就绪、实际不可用」的类。

---

### A6 · P1｜`channel: false` 让 codely **永不进聚合轮换**，而它在运行期不驱动任何别的行为

- 文件：`src/provider-registry.ts:924`
- 我做了什么：

  ```
  P11 运行期实测（读值，不读注释）
    channel:true 家数 = 21，codely in = false
    codely in AGGREGATE_CHANNELS   = false
    codely in WIRED_EXPIRY         = false
    codely in WRITES_RATE_LIMIT    = true
    codely in expectedWithAuth     = false
    codely in expectedCreditsTable = true
    codely in expectedWithProbe    = true
  P12 channel:true 但不在聚合 = []   ；在聚合但 channel:false = []
  # 全仓 .channel 读取点普查（排除 token-ledger 的同名不同义字段）
    src/ 生产代码里 **零处** 读 descriptor.channel；
    唯一消费者是 tests/（provider-sets.ts、provider-registry.spec.ts 等）
  ```

- 为什么是真缺陷（对用户可见）：codely 的推理、目录、余额、签到**全部已接线并实测通过**，但 `channel: false` 让它同时被排除在 `AGGREGATE_CHANNELS` 与 `WIRED_EXPIRY_PROVIDERS` 之外 ⇒ **它的模型永远不出现在聚合渠道的模型列表与轮换候选里**，且**零报错、零日志**（`docs/agent-notes/providers-accio.md` 把这条陷阱记为已复发 4 次：cline → accio → officeace → autoclaw）。用户侧表现为「我在 Codely 里能对话，但用聚合模型时它从不被选中」。
- 同时它暴露了一个更根本的问题：`channel` 这个字段在**生产代码里没有任何读取点**，它只驱动测试期望。作者在注释里写的「本行只是三张派生守卫的判据」是**准确的**——也就是说 `channel: false` 是为了「让守卫变绿」而选的，不是对现实的描述。这与 `docs/agent-notes/providers-accio.md` 那条「用巧合字段推断语义」的红线同型。
- 修法：翻 `channel: true` 并补齐四处登记（`SELF_HEAL_REFRESHABLE_PROVIDERS` + `AGGREGATE_CHANNELS` + `WIRED_EXPIRY_PROVIDERS` + `createProviderExpiry`），或**明确登记**「codely 刻意不进聚合」的理由（当前注释里没有这条理由，只有「先补齐那批登记再一次性翻，避免红仓库」—— 这是**流程理由**，不是**产品理由**）。

---

### A7 · P2｜`codely-product.ts` 的模块头与字段注释与事实直接矛盾

- 文件：`src/codely-product.ts:25-26`、`:56-58`
- 原文：「⚠️ **签名密钥尚未取得**（见 `codely-adapter.ts` 模块头），故本渠道当前**只有目录、没有推理**」「⚠️ **当前不可用**：网关要求 `X-Codely-Signature`（HMAC），签名密钥未取得」
- 事实：`codely-sign.ts` 已把 SECRET 硬编码并逐字节对拍通过，`codely-adapter.ts` 的模块头自己写着「签名已完全还原 ⇒ 推理走 HTTP + SSE，**不需要任何客户端**」，端到端实测 200。
- 为什么算缺陷：这是**同一份 PR 内**两处对同一事实的相反陈述。排障者读 `codely-product.ts` 会以为推理不可用，从而不去查真正的原因（本轮审计就有一次差点被它带偏）。

---

### A8 · P2｜`codely-rotation.spec.ts` 里有一段自欺的死代码

- 文件：`tests/unit/codely-rotation.spec.ts:341-352`
- 原文：

  ```ts
  const { exchangeAuth, adapter } = adapterWithExpiredExchange(pool, 'BAD-1', [])
  const both = adapterWithExpiredExchange(pool, 'BAD-1', [])
  void adapter
  void both
  void exchangeAuth
  // 用「两个号都坏」的夹具重跑（上面那个 helper 只坏一个，故这里手工构造）
  ```

  两个 adapter 构造完立刻 `void` 掉，`exchangeAuth` 一次都没被断言。最终断言用的是下面另造的 `bad`。
- 为什么算缺陷：这不是「多余」，而是**读者会以为「两号都坏」那格被 `adapterWithExpiredExchange` 覆盖了**，从而在改动时删掉下面那段手工构造 —— 而它是这条用例唯一有判别力的部分。本仓对「注释诱饵」有明确纪律（`docs/agent-notes/protocol-wire.md` 的「计数守卫必须剥注释」）。

---

### A9 · P2｜推理请求体里的「工具使用纪律」system 与 `tools` 字段**不同步**

- 文件：`src/codely-adapter.ts:457-495`（纪律 system）vs `:536-592`（`tools`）
- 我做了什么：M15（把 `tools` 下发整段改成恒不发）后实测：

  ```
  P7 bodies[0].tools = undefined
  P7 bodies[0].tool_choice = undefined
  P7 messages 含工具纪律 system = ["【工具使用纪律】本次会话已提供工具。…"]
  ```

- 为什么算缺陷（严重度 P2，但值得登记）：纪律 system 说「本次会话已提供工具」，而 `tools` 字段可能因任何原因没发出去（见 M15 无牙）。这时模型会收到一条**与事实相反**的指令，比不发纪律更糟（它会尝试调一个不存在的工具）。当前实现里两处的判据是同一个 `options.tools.length > 0`，所以现在是对的 —— 但**没有任何用例锁住「两处同源」**，而这是「一文件两套判据」最容易腐化的位置。

---

## 二、变异验证表（全部在独立副本 `/d/jet/code/js/_audit-red` 实测）

| # | 守卫 / 被测判据 | 变异 | 结果 | 归因 |
|---|---|---|---|---|
| M1 | 工具 index 从 2 起（`codely-adapter.ts:947`） | `2 +` → `0 +` | `codely-adapter.spec.ts` **2 红 / 16 passed** | **有牙** |
| M2 | 换发失败也必须换号（`:667-690`） | 回退成直接 `throw PERMISSION_DENIED` | `codely-rotation.spec.ts` **2 红 / 8 passed** | **有牙** |
| M3 | 远端过滤成空 ⇒ 回退兜底表（`:1300`） | 判据前加 `false &&` | `codely-adapter.spec.ts` **1 红 / 17 passed** | **有牙** |
| M4 | 局域网 hint 必须同时判 `running`（`openai-gateway-panel.js:816`） | 去掉 `&& status.running` | `openai-gateway-panel.spec.ts` **1 红 / 108 passed** | **有牙** |
| M5 | 签名分隔符必须是 LF（`codely-sign.ts:127`） | `join('\n')` → `join('|')` | `codely-sign.spec.ts` **2 红 / 4 passed** | **有牙** |
| M6 | 第 5 条指纹 `find` 必须 221 字符（`tencent-fingerprint.ts:382`） | 砍成前一句（107 字符） | `openai-gateway-tencent-fingerprint.spec.ts` **5 红 / 51 passed** | **有牙** |
| M7 | `isLegalHostText` fail-closed 闸门（`config.ts:144`） | 只判 `host !== ''` | `openai-gateway-config.spec.ts` + `-host-binding.spec.ts` **4 红 / 27 passed** | **有牙** |
| M8 | 429 冷却 1h 与 402 次日分流（`codely-adapter.ts:753`） | 两档合并成次日 | `codely-rotation.spec.ts` **1 红 / 9 passed** | **有牙** |
| M9 | 积分空串不翻成 0（`codely-credits.ts:63`） | 去掉 `trim().length > 0` | `codely-credits.spec.ts` **1 红 / 9 passed** | **有牙** |
| M10 | 签到幂等判据 `can_check_in`（`codely-credits.ts:343`） | `if (false)` | `codely-checkin.spec.ts` **2 红 / 6 passed** | **有牙** |
| M16 | 图片模态逐模型声明（`codely-adapter.ts:1355`） | 恒 `['text']` | `codely-adapter-errors.spec.ts` **1 红 / 4 passed** | **有牙** |
| M17 | 目录外模型前置拦截（`:356`） | `false &&` | `codely-adapter-errors.spec.ts` **1 红 / 4 passed** | **有牙** |
| M18 | 登录失败走 `failLogin`（`jet-hub-rpc.ts` 12 处） | 换成 `recordLoginFailure`（不删号） | `codely-login.spec.ts` **1 红 / 10 passed** | **有牙** |
| M24 | `exchangeFailedOut` 区分两种 `undefined`（`:784`） | 恒 `false` | `codely-rotation.spec.ts` **1 红 / 9 passed** | **有牙** |
| M27 | mount 时读 `pool.gatewayAllowLan()`（`openai-gateway/index.ts:66`） | 恒 `false` | `openai-gateway-wiring.spec.ts` **2 红 / 9 passed** | **有牙** |
| M29 | 积分 details 逐桶映射（`codely-credits.ts:131`） | 只取第一桶 | `codely-credits.spec.ts` **1 红 / 9 passed** | **有牙** |
| M30 | 签到数额取 `reward_summary`（`:226`） | 恒 `undefined` | `codely-checkin.spec.ts` **1 红 / 7 passed** | **有牙** |
| M31 | 局域网开关禁用判据（`panel.js:780`） | 恒 `false` | `openai-gateway-panel.spec.ts` **1 红 / 108 passed** | **有牙** |
| M32 | 状态行必须给可抄的地址（`panel.js:722`） | `endpoint = ''` | `openai-gateway-panel.spec.ts` **1 红 / 108 passed** | **有牙** |
| M33 | 绑 0.0.0.0 时必须教用户换局域网 IP（`panel.js:736`） | 删掉那句 | `openai-gateway-panel.spec.ts` **1 红 / 108 passed** | **有牙** |
| M11 | 换号必须传 `tried`（`:766`） | 去掉第 3 参 | `codely-rotation.spec.ts` **10 passed 全绿** | **无牙** |
| M12 | 空名工具调用不得发射（`:984`） | `false &&` | `codely-adapter.spec.ts` + `-rotation` **28 passed 全绿** | **无牙** |
| M13 | `finish_reason==='length'` ⇒ `max-tokens`（`:1148`） | 判据恒假 | **28 passed 全绿** | **无牙** |
| M14 | 停滞续拉判据（`:1080`） | 恒假 | **28 passed 全绿** | **无牙** |
| M15 | 必须下发 `tools` / `tool_choice`（`:536`） | 恒不下发 | **7 个 codely spec / 68 passed 全绿** | **无牙** |
| M19 | `unknownModelInputModalities` 应查实测表（`:248`） | 改成查 `CODERLY_ABILITIES`（**正确修法**） | **23 passed 全绿** | **无牙**（修法有效但零守卫） |
| M20 | 能力后缀（`:134`） | 恒返回 `''` | **23 passed 全绿** | **无牙** |
| M21 | `readImage` 失败不得喂空字节（`:408`） | 喂 `Uint8Array(0)` | **23 passed 全绿** | **无牙** |
| M22 | 未注入 `readImage` 的报错（`:399`） | 改文案 | **18 passed 全绿** | **无牙** |
| M23 | 读不到图不得发空 data URL（`:408`） | 发 `data:image/png;base64,` | **23 passed 全绿** | **无牙** |
| M25 | 远端空数组不算成功（`:1367`） | 去掉 `models.length === 0` | `codely-adapter.spec.ts` **18 passed 全绿** | **无牙** |
| M26 | 收敛判据必须扣 env host（`runtime.ts`） | 去掉 `&& !isGatewayHostFromEnv` | `openai-gateway-wiring.spec.ts` **11 passed 全绿**（但见 P30） | **无牙** |
| M28 | 换发失败记账时刻（`:673`） | 改成 1h | `codely-rotation.spec.ts` **10 passed 全绿** | **无牙** |
| M34 | 停滞续拉的「短正文」限制（`:1084`） | 追加 `text.length < 12` | **33 passed 全绿** | **无牙** |
| M35 | 正文 `block-end` 必须是全文（`:1108`） | 只发末 10 字 | **33 passed 全绿**（P33 实测：block-end 变成「-end 是否完整。」） | **无牙** |

**M26 的补充实测（无牙 ≠ 无后果）**：

```
P30 env host=127.0.0.2 + allowLan=true，连续 3 次 applyGatewayDesiredState()
  基线：初次 mount 后「已监听」日志 = 1，三次收敛后 = 1，address = 127.0.0.2
  M26：初次 = 1，三次收敛后 = 4，address 端口从 25022 变成 25319（每次都重建）
```

⇒ 这条变异**没有用例抓得住**，而它的后果正是作者自己在注释里写的「必现死循环」。`openai-gateway-wiring.spec.ts` 里那条「反复收敛不得反复重建」的用例只断言了 `isGatewayRunning()` 与 `address().host`，**断言不到「实例没被重建」** —— 端口漂移是唯一可观测量，而它没被断言。

---

## 三、我试了但**没打穿**的（如实登记）

1. **局域网地址判据的 Unicode / 紧凑写法绕过面（21 条逐条实测，全部被拒或正确解析）**：
   `0。0。0。0`（REJECT 非法字符）、`0\u3002…`（同）、`::%eth0`（REJECT 通配）、`[::]:8326`（REJECT 通配）、`::\u034f`（REJECT 通配）、`0\u00000.0.0`（REJECT）、`0\u00ad.0.0.0`（REJECT）、`0.0.0.0\u034f`（REJECT）、`0\u200b.0.0.0`（REJECT）、`0x0` / `00.0.0.0` / `0.0.0.0.` / `0` / `::ffff:0.0.0.0` / `[::ffff:0:0]:8326` / `::%nonexistent` / `０.０.０.０`（全部 REJECT 通配）、`0٠.0.0.0`（REJECT 非法字符）、`127.1` / `LOCALHOST` / `127.0.0.1`（正确 RESOLVED）。
   ⇒ **fail-closed 闸门（`isLegalHostText` → 再通配识别）确实有效**，这条作者修对了（M7 也证明它有牙）。
2. **`allowLan` 会不会绕过 env 的非法字符闸门**：`resolveGatewayConfig({HOST:'0。0。0。0'}, {allowLan:true})` **抛错**；`env` 给具体地址时 `allowLan` 不覆盖。✅
3. **签名分隔符**：M5 变红，且 `codely-sign.spec.ts` 的固定向量 + 反例对照（`|` / `\r\n` 必须不等）结构是对的。
4. **积分解析**：字符串数字、空串、多桶、exhausted=0、非 JSON、401、网络失败 —— M9/M29/M30 逐条有牙。
5. **签到幂等**：M10 有牙（`can_check_in:false` 与 `PROCESSING` 两格都变红）。
6. **登录失败不删号**：M18 有牙；`loginCredentialLanded` 的三态 + `poolEntryOf → 'unknown'` 结构完整，我尝试的「读不到池时删号」路径没有找到可达入口。
7. **`exchangeFailedOut` 分档**：M24 有牙。
8. **坏凭据（裸 `JSON.parse` 产出 `{}`）是否死循环**：P21 实测 5 次选号即止（受 `CODERLY_MAX_ROTATE=5` 约束），M11 下也没有死循环 —— 只是「重复打同一个号」的浪费。
9. **工具 index 抢块**：M1 有牙，且作者用**真实 `BlockAssembler`** 做判据这个手法是对的（我复核了 `assembler.js` 的 `block-start` 幂等 + `block-end` first-close-wins 语义，与他的注释一致）。
10. **网关 413 / keepAliveTimeout**：`server.ts:503` 显式 `keepAliveTimeout = 120000`，`headersTimeout` 更大；413 有专文与用例。没有找到「断连代替 413」的回归。
11. **PII**：本 PR 新增的 `access-token-abc` / `refresh-token-abc` 是构造样例，按纪律逐条登记（不是启发式放过）。`repo-pii-guard.spec.ts` 8 passed。没有在本 PR 新增文件里找到真实手机号 / 真实域名凭据。
12. **`login.poll` 终态**：`codely-login.spec.ts` 的 denied 用例有牙（M18），且终态查询在 `listAllAccounts()` **之前**（顺序正确）。

---

## 四、未能验证的（如实标注，未编造结论）

1. **真实上游**（`codely.tuanjie.cn` / `codely-litellm.tuanjie.cn`）的 200 / 401 / 402 行为 —— 本机无凭据，且按仓库纪律**不得**对真实凭据发起请求。A1 的「网络抖动」与「上游 500」两格是用 fetch 替身注入的，**不是**真实报文。
2. **e2e 指纹用例**（`tests/e2e/buddy-fingerprint-roles.e2e.spec.ts`，需真实腾讯凭据、双闸门）—— 只做了源码级核对，**没有**实发。
3. **真实 `AccountPool` 实例下的换号**：我用的是「忠实复刻 `getAvailableAccount` 三条腿（enabled / exclude / modelRateLimits）」的替身（`account-pool.ts:2274-2290` 逐行对照），不是真类。M11 的「无牙」结论在这个替身下成立，但我**没有**在真池 + 真磁盘落盘下复现。
4. **网关 413 的真实网络往返**：只跑了单测，没有起真实 socket 做大包测试。
5. **`CodelyAuth` 接线后的端到端**：只做到 tsc + 运行期 TypeError 两步，没有真接线跑一轮。
6. **codely 的 SSE 在真实上游的分片形态**（是否会跨帧拆 `data:` 行、是否发心跳帧）—— 用桩帧，未实测。

---

## 五、本轮到此（范围与时间说明）

- 覆盖：`src/codely-*.ts` 全部 7 个文件、`src/openai-gateway/{config,runtime,server,index}.ts`、`src/openai-gateway/tencent-fingerprint.ts`、`src/{index,jet-hub-rpc,provider-registry,provider-credits}.ts` 的相关段、`plugin-src/client/{openai-gateway-panel,jet-hub}.js` 的网关段、8 个 codely spec + 4 个 gateway spec。
- **未覆盖**：`src/codely-cli.ts`（CLI 兜底路径，生产不走）、`plugin-src/client/jet-hub.js` 的侧栏入口段（新增 79 行）、`src/account-pool.ts` 的 `gatewayAllowLan` 持久化段、`tests/e2e/*`（除源码核对）。
- 变异 35 条：**21 有牙 / 14 无牙 / 0 PATCH-NOT-APPLIED**（每条注入都打印了 `HITS` 与 `FIRST_HIT_LINE` 自证；CRLF 文件用能感知换行的注入器）。
- 主工作树 `src/` 与 `tests/` **零改动**（`git status --short` 只有审计前就存在的 `.dsh-backup/`）。所有变异在 `git worktree` 副本里做，做完 `revert` 并核对过 `git diff` 为空。

### 建议的合并门槛（按此 PR 现状）

必须修：**A1（P0）**、**A2（P0）**、**A3（P1）**、**A4（P1）**、**A5（P1）**，并为 A2/A3/A4 各补一条**能变红**的守卫（A4 的 M19 已证明「正确修法零用例变红」）。
可随下轮：A6（需产品决策）、A7/A8/A9（文档与测试卫生）。
必须补守卫但可不改实现：M13（finish 分类）、M14/M34/M35（停滞续拉）、M15（tools 下发）、M25（远端空数组）—— 这 6 条是作者自己宣称「必须做」的判据，当前**一条用例都没有**。
