# Gitee PR #1 审计报告（`pr3-merge` → `master`，相对 `master` 的新增改动）

- 审计对象：合并提交 `021ff8b4`（审计期间被 amend 为 `9c4776c6`，**只有 `AGENTS.md` 的 CRLF 整文件重写**，`git diff 021ff8b4..9c4776c6 --stat` = `AGENTS.md | 1802 +++---`，其余文件逐字节相同）
- 审计面：`git diff master..HEAD --stat` 的 59 个文件（11974 增 / 1009 删）
- 审计方式：全文阅读 + 隔离 worktree（`_audit-blue`）里做变异验证 + 基线 vitest
- **未改动任何 `src/` / `tests/` 文件**（所有变异都在 `D:\jet\code\js\_audit-blue` 里做，做完 `git checkout --` 还原；主工作树只做只读与基线跑测）

---

## 结论摘要

| 级别 | 条数 |
|---|---|
| **阻断（Blocker）** | 1 |
| **重要（Major）** | 5 |
| **建议（Minor / 建议）** | 6 |

一句话：**codely 的「接线」主体（`probeById` / `WRITES_RATE_LIMIT_PROVIDERS` / `modelAdapters` / 余额 / 签到 / 登录三态 / 网关局域网开关 / 第 4、5 条指纹）基本到位且有牙**；真正的缺陷集中在
① **`CodelyAuth` 是「写了但从未接线、且接上去也跑不通」的死代码**（`refreshAll` 签名与 `JetHubAuthLike` 不兼容 + 传裸 `refName` 读不到凭据）；
② **`streamViaHttp` 的停滞重试会把前几轮正文整段丢掉**（实测 4 轮 → 只剩第 4 轮）；
③ **`channel: false` 造成的用户可见缺口**（账号能加、能对话，但 `account.refresh` 报「不支持续期」、聚合轮换里永远没有它、自愈名单里也没有它 —— 而代码/注释都声称「有探测、有冷却、能自愈」）；
④ **`account-pool` 的局域网开关快照缺一条守卫**（快照漏键 ⇒ 任何其它写入都会把开关抹掉，实测只有「重启后」才看得见，而这条路径零用例）；
⑤ **`.codely-cli/auto-saves/` 六个会话导出文件被提交进仓库**（含本机真实绝对路径 `F:\AIProject\dsh-providers-hub` 与完整会话正文，违反本仓「取证/会话产物不入库」纪律）。

---

## 逐条缺陷

### B-1（阻断）`CodelyAuth` 是死代码，且真接上去必然「静默零动作」

**文件:行**
- `src/codely-auth-service.ts:131-149`（`refreshAll(pool, refreshOne)` 两参）
- `src/codely-auth-service.ts:97-122`（`refreshAccountCredential(refName, …)` 直接把它当**完整 ref** 传给 `readCodelyCredential`）
- `src/index.ts:6`（`import { CodelyAuth }`）、`src/index.ts:5378-5380`（注释「续期对象暂未挂」）
- 全仓 `new CodelyAuth` **0 处**（`grep -rn "new CodelyAuth\|CodelyAuth(" src/ tests/ scripts/` 只命中一条注释）

**现象**

1. **零调用点**：`CodelyAuth` 被 `index.ts` import 却从未实例化 —— 这正是本仓自己记过的「已导出却零调用点」陷阱（`codely-auth.ts:49-58` 的模块头明确写了这条纪律，然后自己又犯了一次）。
2. **即使挂上，`refreshAll` 也跑不通**：`JetHubAuthLike.refreshAll` 的契约是 `(pool) => Promise<void>`（`src/jet-hub-rpc.ts:1360`），而 `CodelyAuth.refreshAll(pool, refreshOne)` 需要第二个参数。`index.ts` 的接线形态必然是 `refreshAll: (pool) => auth.refreshAll(pool)` ⇒ 运行时抛 `TypeError: refreshOne is not a function`。**实测**（隔离 worktree，`tests/unit/zz-codely-refresh.spec.ts`，已删除）：
   ```
   THREW = TypeError: refreshOne is not a function
   refreshAll.length = 2 | JetHubAuthLike 要求 1 参
   resolve called = 0 | set called = 0
   ```
   ⇒ 真接上去时，**每个账号都续不了期**，而异常被 `refreshAll` 外层的 `await refreshOne(account).catch(() => undefined)` 与 `index.ts` 的逐 provider `try` 吞掉 ⇒ **日志零字、界面零提示**（与 issue IKKHL5 逐字同形）。
3. **即使签名对上，ref 也读不到凭据**：`JetHubAuthLike.refreshAccountCredential(refName, …)` 的 `refName` 来自 `entry.credentialRef`（**裸名**，如 `account.abc`），各家实现都自己调 `credentialRef(refName)` 补全；而 `CodelyAuth` 把它**当完整 ref 直接 `credentials.resolve`**。**实测**：
   ```
   resolve called with ref = "account.abc"
   resolve calls = 1 | set calls = 0 | refresh HTTP calls = 0     ← 裸名：静默零动作
   CONTROL: set calls = 1 | refresh HTTP calls = 1                 ← 完整 ref：正常
   ```
   ⇒ 续期「成功返回」但**一个 HTTP 请求都没发**，用户看到的是「续期了但有效期没变」。

**判据（为什么能确证）**
- `grep -rn "new CodelyAuth"` 全仓 0 命中 ⇒ 零调用点是事实，不是推断。
- `JetHubAuthLike` 的签名是**接口契约**（`src/jet-hub-rpc.ts:1351-1361`），`CodelyAuth.refreshAll` 的 2 参形态与之**结构性不兼容**；实测调用即抛 `TypeError`。
- `readCodelyCredential` 的注释（`src/codely-auth.ts:524-529`）**明确写着**「参数是**完整 ref**」，而 `refreshAccountCredential` 把裸 `refName` 传了进去 —— 同一文件两套同义判据（本仓首条红线）。

**后果**
- 现状：`account.refresh` 对 codely 报「不支持续期」（`authOf(auths,'codely')` 为 `undefined`）；`SELF_HEAL` 名单里也没有它 ⇒ 过期账号**永不自动续期**、积分端点**永不自愈**。
- 一旦按 `provider-registry.ts:894-905` 的接线清单「补上」，得到的是**更糟的形态**：静默零动作（签名不兼容被吞 + ref 不匹配被 `readCodelyCredential` 的 `catch` 吞成 `undefined` ⇒ `return`）。
- 而 `src/codely-auth.ts:43-47` 与 `src/jet-hub-rpc.ts:3853-3885` 的注释都声称「`access_token` 约 365 天，可续期（`/auth/refresh` 实测 200、不轮换）」—— 用户按注释理解会以为有自愈。

**修法方向**
1. `refreshAll(pool)` 收成一参：内部自己遍历 `pool.listAccountsByProvider('codely')`，逐账号调 `this.refreshAccountCredential(...)`（对齐 `officeaceAuth.refreshAccountList` 的形态）。
2. `refreshAccountCredential` 第一行改成 `const ref = credentialRef(refName)`（与 `buddy-auth.ts:301-309` / `accio-auth.ts:757-770` **同一形态**），不要自己判断「是裸名还是完整 ref」。
3. 挂上时**同时**补齐四处：`JetHubAuths.codely` 接口键、`index.ts` 的 `auths` 传值、`SELF_HEAL_REFRESHABLE_PROVIDERS` 加 `CODERLY.id`、`jet-hub-rpc-auth-wiring` / `refreshAll` 计数。挂不上就**删掉** `codely-auth-service.ts` 与 `index.ts:6` 的 import（留死代码比没有更糟 —— 本仓原话）。
4. 补一条**行为**用例：`refreshAll(pool)` 驱动到「真发了 `/auth/refresh` 请求 + 凭据被 `set` 回写 + 池 `expiresAt` 被回填」，而不是只断言「不抛错」。

---

### M-1（重要）停滞重试把前几轮正文整段丢掉（`stalled` 分支）

**文件:行** `src/codely-adapter.ts:1080-1101`（`const stalled = …` / `yield* this.streamViaHttp(retryOptions, retryBudget - 1)`）

**现象**
注释（`src/codely-adapter.ts:1062`）写着「⚠️ 第一轮已下发的正文**保留**（用户看到"我先看看"然后真的去看了，比静默重来自然）」，但实现是**递归调用 `streamViaHttp` 并从 `yield*` 直接 `return`**，而递归调用内部又会发 `block-start(index:0)` + 自己的 `block-end(index:0)`。`BlockAssembler` 的 `block-start` **只在 index 未见过时建 partial**、`block-end` 走 **first close wins**（实测见下），于是前几轮的正文被后一轮**覆盖/丢弃**。

**实测（隔离 worktree，真实 `BlockAssembler`，`tests/unit/zz-stalled2.spec.ts`，已删除）**
```
CHAT_REQUESTS = 4
TEXT_DELTAS   = ["第一轮：我来看看。","第二轮：准备开始。","第三轮：先规划。","第四轮：马上动手。"]
FINAL_BLOCKS  = [{"type":"text","text":"第四轮：马上动手。"}]
LOST_ROUNDS   = 3
```
`BlockAssembler` 语义对照（`tests/unit/zz-asm.spec.ts`，已删除）：
```
CASE1（两轮 start(0)，只有第二轮 end）  = [{"type":"text","text":"第二轮"}]   ← 第一轮被丢
CASE2（两轮 start(0)+end(0) 各一）      = [{"type":"text","text":"第一轮"}]   ← 第二轮被丢
```

**判据** 用**真实** `BlockAssembler`（不是替身）喂适配器输出，逐块打印 —— 这是行为证据，不是源码推断。注意 `TEXT_DELTAS` 里 4 轮文本**都下发了**（UI 侧可能闪一下），但**最终组装出来的 assistant message 只剩第 4 轮** ⇒ 落盘/重放/下一轮上下文里都只有最后一轮。

**后果**
- 每次「模型只说不做」都白烧最多 3 次请求（计费），且**用户看到的最终回答被替换成最后一句**（可能是「第四轮：马上动手。」这种半句）。
- 更糟的是 `finish` 只发一次、`blocks` 只有一条 —— 会话落盘后**无法还原**被丢掉的三轮。
- 与注释声称的行为**相反**（注释说保留，实际丢弃）。

**修法方向** 二选一（都要有用例钉住）：
1. **不递归**：把重试做成循环，`messages` 追加提示后**继续在同一 assembler 语义下追加**，并给重试轮分配**新的 block index**（如 `RETRY_TEXT_INDEX = 100 + round`），最后统一 `block-end`；
2. 或者**先 flush 当前正文块**（`block-end(index:0)`）再递归，且递归里正文 index 从 `RETRY_BASE` 起 —— 但这会让一次请求产出多个 text 块，需确认 `BlockAssembler`/客户端渲染对多 text 块的处理（`CASE2` 显示 second close 被忽略，故**单纯补 `block-end` 不够**）。
3. 无论哪种，守卫必须断言「多轮重试后 `blocks()` 里**含有第一轮正文**」，而不是只断言「最终有内容」。

---

### M-2（重要）`channel: false` 造成三处**用户可见**缺口，且与代码/注释自相矛盾

**文件:行** `src/provider-registry.ts:924`（`channel: false`），相关声称见 `src/index.ts:876-891`（`probeById.codely` 头注释）、`src/provider-registry.ts:918-940`

**`channel` 驱动的真实行为（非守卫计数）**
逐处核对 `src/` 里所有对 `descriptor.channel` 的**生产读取**，只有三处（其余全是测试/注释）：

| 消费点 | 读法 | `channel:false` 的后果 |
|---|---|---|
| `tests/helpers/provider-sets.ts:110` → `expectedProviderIdsWithAuth()` | `d.channel` | 仅测试 |
| `src/aggregate-adapter.ts:1285` 注释 + `AGGREGATE_CHANNELS` 硬编码清单（**不读** `d.channel`，两者由测试比对） | — | **codely 不在 `AGGREGATE_CHANNELS`** ⇒ 它的模型**永不进聚合目录、静默不可见** |
| `src/index.ts:5189-5235` 的 `registry` 数组（`channel:true` 的手工副本，由 `expectedProviderIdsWithAuth()` 守卫） | 人工维护 | codely 不在 ⇒ **无 auth 服务 ⇒ 无续期**（见 B-1） |

⇒ 结论：`channel: false` **不**影响「能不能加账号 / 能不能对话 / 面板是否显示模型」（这些走 `PROVIDER_REGISTRY` 全量派生 + `modelAdapters` 表，codely 都已进）。它真正造成的是：

1. **`account.refresh` 报「不支持续期」**（`authOf(auths,'codely') === undefined`）。而 `src/codely-auth.ts:43-47`、`src/jet-hub-rpc.ts:3853-3885`、`src/provider-registry.ts:918-923` 三处注释都说「可续期、`/auth/refresh` 实测 200」⇒ 用户被引向一个**不存在的能力**。
2. **聚合轮换里永远没有 codely**（`AGGREGATE_CHANNELS` 缺项 + `WIRED_EXPIRY_PROVIDERS` 缺项）⇒ 用户明明有 codely 账号与余额，聚合面板里却看不到它，**零报错、零日志**（本仓记过 7 次的同一形态）。
3. **`SELF_HEAL_REFRESHABLE_PROVIDERS` 里没有它**（`src/jet-hub-rpc.ts:2266-2340`）⇒ 过期账号在积分端点**永不自愈**；而 `credits-balance-self-heal.spec.ts` 的反向守卫（`d.channel && d.credits.balance === true`，`tests/unit/credits-balance-self-heal.spec.ts:760-763`）用 `d.channel` 当判据 ⇒ **codely 被自动豁免、守卫永远不会红** —— 这是「守卫判据用错字段」导致新 provider 漏网的**新实例**（该守卫原本是为 accio 漏登记补的）。

**判据**
- `grep -rn "\.channel\b" src/ --include=*.ts`（排除注释）只命中 2 行且都不是生产读取 ⇒ 「`channel` 只影响那三张表」是可核对的。
- 反向守卫的期望集合是 `PROVIDER_REGISTRY.filter(d => d.channel && …)`，而 codely 的 `channel` 是 `false` ⇒ **它的缺失在守卫里不可见**（实测：把 `credits-balance-self-heal.spec.ts` 的 `expected` 里 codely 相关条目人为加进去会红，而现状全绿）。

**后果** 用户可见的「能加账号、能对话，但续期/自愈/聚合三个入口都没有它」，且每一处都**静默**。

**修法方向**
- 如果 codely 设计上**确实**有 `/auth/refresh`（注释如此声称）：把 `channel` 翻 `true`，并同时补 ②~⑥（registry 注释 `provider-registry.ts:894-905` 已列出完整清单）。
- 如果暂时不接续期：**把三处注释改成如实陈述**（「无续期，过期只能重新登录」），并把 `credits-balance-self-heal.spec.ts` 的反向守卫判据从 `d.channel && d.credits.balance` 改成 **`d.credits.balance === true`**（只减 `NO_REFRESH_ENDPOINT` 显式豁免表）—— 这样 codely 漏登记会**点名变红**，而不是被 `channel:false` 顺手豁免。
- 聚合：即使 `channel:false`，只要 `credits.balance === true` 就应进 `AGGREGATE_CHANNELS` + `WIRED_EXPIRY_PROVIDERS`（否则「有余额却永不参与轮换」这条静默缺陷会一直留着）。

---

### M-3（重要）`account-pool` 的 `gatewayAllowLan` 快照缺一条守卫（漏键 ⇒ 任何其它写入静默抹掉开关）

**文件:行** `src/account-pool.ts:596`（`gatewayAllowLan: this.gatewayAllowLanCache,`）

**现象** `AccountPool` 的落盘是**整体替换**语义（`src/account-pool.ts:585-600` 的注释自己写着「replace 是整体替换语义，漏键 ⇒ 被抹掉」）。本 PR 正确地把 `gatewayAllowLan` 加进了快照，但**没有任何用例**覆盖这条腿。

**实测（隔离 worktree，`tests/unit/zz-pool-allowlan.spec.ts`，已删除）**
```
正常态：after setAllowLan(true): true → after setGatewayEnabled(false): true → after reload: true   ✅
变异（删掉快照那一行）：
       after setAllowLan(true): true → after setGatewayEnabled(false): true → after reload: false  ❌
```
⇒ 漏键在**同一进程内完全不可见**（因为读的是进程内 `gatewayAllowLanCache`），**只有重启后才暴露**为「开关被静默关掉」。

**判据** 变异验证：删掉 `src/account-pool.ts:596` 后，`openai-gateway-wiring.spec.ts` + `jet-hub-store.spec.ts` + `openai-gateway-panel.spec.ts` 三个文件 **182 条全绿**（`RESULT: GREEN (无牙)`）⇒ 现有守卫**没有牙**。同型缺陷在 `nativeWebSearchEnabled` / `sidebarEntryEnabled` 上有显式用例（本 PR 甚至给 `jet-hub-store.spec.ts` 补了 `gatewayAllowLan: false` 的**缺省值**断言，但那是 store 侧、不是 pool 侧的「整体替换漏键」）。

**后果** 将来任何一次重构/误删那一行 ⇒ 用户打开的「允许局域网访问」在**任意一次**账号/黑名单/网关/顺序写入时被抹掉，重启后**静默回到只绑回环**（用户会以为开关坏了）。

**修法方向** 补一条**行为**用例（与 `nativeWebSearchEnabled` 同款）：`setGatewayAllowLan(true)` → `setGatewayEnabled(false)` → **新建一个 `AccountPool` 从同一目录读** → 断言 `gatewayAllowLan() === true`。判据必须落在「**重启后**」这一格，否则永远抓不到。

---

### M-4（重要）`.codely-cli/auto-saves/` 六个会话导出文件被提交进仓库

**文件:行**（PR 新增，`A` 状态）
```
.codely-cli/auto-saves/chat-auto-save-2026-10-20-11-04-49-194.json      (1096 行)
.codely-cli/auto-saves/chat-auto-save-2026-10-20-11-12-52-730.json      (1151 行)
.codely-cli/auto-saves/chat-auto-save-2026-10-20-11-43-42-038.json      (1141 行)
.codely-cli/auto-saves/chat-export-auto-save-2026-10-20-11-04-49-194.md (36 行)
.codely-cli/auto-saves/chat-export-auto-save-2026-10-20-11-12-52-730.md (36 行)
.codely-cli/auto-saves/chat-export-auto-save-2026-10-20-11-43-42-038.md (36 行)
```

**现象** 这六个文件是 Codely CLI 自己的**会话自动保存产物**（`"tag":"auto-save-…"`, `"type":"automatic"`），内容含：
- 本机**真实绝对路径** `F:\AIProject\dsh-providers-hub` 与完整目录树；
- 完整对话正文（含 `[agent-auto]` 上下文、模型回复）；
- 会话 id、`apiRoundId`、token 计数；
- `"authType": "codely-oauth"` / `"endpoint": "codely-litellm.tuanjie.cn"`。

**判据** `.gitignore` 里已有大量同类条目（`.e2e-logs/`、`.tmp-*/`、`_过程归档/`、`docs/*-protocol-notes.md`），本仓纪律是「取证/会话产物不入库」；`.codely-cli/` 与 `.e2e-logs/` **同型**（运行产物）却**没有**任何 ignore 规则。`git ls-files .codely-cli` 确认它们**真的在索引里**。

**后果** 仓库公开 ⇒ 本机路径与完整会话永久留在 git 历史（事后删文件也清不干净，与 `.gitignore` 里 `tests/fixtures/test.png` 那条「真人桌面截图」记录的理由逐字相同）。此外它们给 PR 增加了 ~3.4k 行噪声，会掩盖真实 diff。

**修法方向**
1. `git rm -r --cached .codely-cli` + `.gitignore` 加 `.codely-cli/`（放在 `.e2e-logs/` 旁边，并写清理由）；
2. 若要保留取证价值，把**必要的结论**摘进 `docs/agent-notes/providers-codely.md`，**不要**提交原始会话；
3. 注意：若这六个文件已推送到远端，需按本仓既有做法评估是否要改写历史（至少要在 PR 描述里如实登记）。

---

### M-5（重要）`dsml-tool-delivery.spec.ts` 给 codely 加了**已失效**的豁免，守卫从此对它失明

**文件:行** `tests/unit/dsml-tool-delivery.spec.ts:41-45`
```js
// ⚠️ codely（2026-10-20）**只接模型目录**：它不发起任何推理请求（推理网关
//    要求 HMAC 签名、密钥未取得，见 `codely-adapter.ts` 模块头）⇒ 不存在
//    「发了请求却漏带 tools」这一 2026-10-13 事故的形态，故豁免。
const exempt = new Set(['aggregate-adapter.ts', 'auto-adapter.ts', 'codely-adapter.ts'])
```

**现象** 豁免理由（「不发起任何推理请求」）**已被同一 PR 自己证伪**：`src/codely-adapter.ts:299-305` 的 `stream()` 生产路径走 `streamViaHttp`（真发 HTTP + SSE），`src/codely-adapter.ts:536-592` 真下发 `tools` 与 `tool_choice`。而豁免**没有随推理接线撤销**（注释里甚至写了「⚠️ 该豁免**必须随推理接线一并撤销**」，但同一次 PR 里推理已接线，豁免仍在）。

**判据（变异验证，有牙 → 无牙）**
```
变异：src/codely-adapter.ts  `tools: options.tools.map(...)` → `toolsXX: options.tools.map(...)`
      （即：真的不再下发 tools）
结果：tests/unit/dsml-tool-delivery.spec.ts  GREEN (无牙)   7 passed
```
⇒ 即使把 codely 的 `tools` 下发**彻底删掉**，这条守卫**仍然全绿** —— 它对该文件零覆盖。

**后果** 这正是 2026-10-13 那次事故（「发了请求却漏带 tools ⇒ agent 永远无法执行工具」）的**同型复发通道**：codely 现在真发请求，但这条守卫永远不会为它变红。而本 PR 在 `codely-adapter.ts:522-535` 用了大段注释论证「必须下发 `tools`」—— 论证有，守卫没有。

**修法方向** 从 `exempt` 里删掉 `'codely-adapter.ts'`（它现在有 `tools` 字样，删掉豁免后立刻通过）；若担心正则误判，改成「断言 `src/codely-adapter.ts` 里存在 `tools:` 且存在 `tool_choice`」的行为级判据。**顺手**：`tests/unit/refresh-targets-derived.spec.ts:167` 的注释仍写「`stream()` 显式报『推理通道尚未接通』」—— 与现状相反，一并订正（否则下一个人会照着注释做错决定）。

---

### m-1（建议）`gatewayStatusLines` 新增的 `isWildcardHost(status.address?.host)` 在 `running:true` + `address:null` 时会抛错

**文件:行** `plugin-src/client/openai-gateway-panel.js:736`（`isWildcardHost(status.address?.host)`）

**现象** `isWildcardHost` 的第一行是 `host.normalize('NFKC')`（`src/openai-gateway/config.ts:69-70`），`undefined` 会抛 `TypeError`。同文件其它判据（`gatewayLoopbackOnly` / `gatewayEndpoint`）都先判 `typeof host !== 'string'` 或 `!address` 短路。**实测**（隔离 worktree，`tests/unit/zz-wild.spec.ts`，已删除）：
```
isWildcardHost(undefined)                       → THREW TypeError: Cannot read properties of undefined (reading 'normalize')
gatewayStatusLines({running:true, address:null}) → THREW 同上
gatewayStatusLines({running:true, address:{port:8326}}) → THREW 同上
```

**判据** 这是**本 PR 新增的行**（`git diff` 里 `+ isWildcardHost(status.address?.host)`）；旧代码在 `running:true` 分支只调 `gatewayEndpoint`（有 `!address` 早退）与 `gatewayLoopbackOnly`（有 `typeof host` 早退），**不会抛**。

**后果** 宿主侧 `gateway.getEnabled` 的 `running` 与 `address` 是**两次独立 `degrade`**（`src/jet-hub-rpc.ts:7690` / `7708`）：`address` 读失败降级为 `null`、而 `running` 读成功为 `true` 时，客户端 `gatewayStatusLines` **抛异常** ⇒ 整个 `GatewayPanel` 渲染崩掉（React 里是白屏/错误边界）。触发概率低（需要 `gatewayAddress()` 抛错），但它是**新引入的崩溃面**，且宿主侧明明已经防了这种组合（`address: null` 是合法值）。

**修法方向** `isWildcardHost(status.address?.host ?? '')`（空串在 `normalizeHostForCompare` 里返回 `''`，`isWildcardHost('')` 返回 `true` —— ⚠️ 那会让空地址被当成通配，语义也不对）⇒ 更稳的是**先判 `typeof status.address?.host === 'string'`**，与同文件另外两个判据同款。补一条 `gatewayStatusLines({running:true, address:null})` 不抛的用例（现有 109 条用例没有这一格）。

---

### m-2（建议）`codely` 的 `can_check_in !== true` 判据无牙（变异后仍全绿）

**文件:行** `src/codely-credits.ts:343`

**现象** 把 `if (state.can_check_in !== true)` 改成 `if (state.can_check_in === false)`（即：`can_check_in` 缺失/`undefined` 时**当成可签到**）后，`tests/unit/codely-checkin.spec.ts` **8 条全绿**：
```
RESULT: GREEN (无牙)    Tests 8 passed (8)
```
**判据** 缺一格夹具：**`init` 报文里完全没有 `can_check_in` 字段**（上游改版 / 过渡态）时应当**不执行签到**（`!== true` 才是 fail-closed），而现有 8 条用例的 `can_check_in` 全是显式 `true` / `false`。
**后果** 上游某天不下发该字段 ⇒ 适配器会**白打一次写操作请求**（签到是写操作，`POST /api/points/check-in`）；虽然后端幂等，但这是「不该发的请求」。
**修法方向** 补一条夹具：`init` 返回 `{ activity_status:'ACTIVE', check_in_status:'READY' }`（无 `can_check_in`）⇒ 断言 `kind === 'already-claimed'` 且**执行端点零请求**。

---

### m-3（建议）`codely-adapter.ts` 的「换发失败也换号」分支记账无牙

**文件:行** `src/codely-adapter.ts:667-690`（`if (exchanged === undefined)` 分支内的 `pool.updateModelRateLimit(...)`）

**现象** 把该处 `await pool.updateModelRateLimit(currentAccountId, model, nextUtc8DayStartMs())` 删成 `void 0` 后，`codely-rotation.spec.ts` **10 条全绿**。叠加「漏传 `tried`」也仍全绿：
```
变异1（只删记账）           → GREEN (无牙)
变异2（只漏传 tried）       → GREEN (无牙)
变异3（两者同时）           → GREEN (无牙)
```
**判据** 该分支的**判别力**全在 `exchangeAuth` 的顺序断言（`['Bearer EXPIRED','Bearer GOOD']`），而「记账」这一腿没有任何断言；`tried` 这一腿被「池替身在 `updateModelRateLimit` 之外还实现了 `exclude` 过滤」掩盖 —— 因为即使漏传 `tried`，`pool` 替身按 `exclude` 过滤时仍会给出下一个号（`picks` 实测 `[[], ["acc-1"]]`，第二发传了 `['acc-1']`，但断言里没有它）。
**后果** 与 accio 审计记过的「替身缺一条真实实现里有的腿 ⇒ 对应变异全体无牙」**同型**：真实池里「换发失败的号没有限流标记」⇒ 下次仍被优先选中、又撞一次墙（这正是注释 `codely-adapter.ts:664-666` 声称要防的事）。
**修法方向** 在「所有号都换发失败」用例里**断言 `marks`**（两个号各记一次、`resetAtMs === nextUtc8DayStartMs()`）；并断言第二次 `getAvailableAccount` 的 `exclude` 含 `acc-1`。

---

### m-4（建议）`stalled` 重试是**纯计费放大器**，且没有「用户可关」的逃生门

**文件:行** `src/codely-adapter.ts:1080-1101`

**现象** `retryBudget = 3`（`streamViaHttp` 默认参数）+ 停滞判据从宽（正文 < 500 字即算停滞）⇒ 一次用户请求最多发 **4 次**上游请求（实测 `CHAT_REQUESTS = 4`）。且该行为**对用户不可见、不可关**（只有 `DSH_CODERLY_TOOL_CHOICE=auto` 关掉 `tool_choice`，**不能**关掉重试）。
**判据** 实测 4 次请求；`retryBudget` 无环境变量/配置开关。
**后果** 长任务里每次「只说不做」都 ×4 计费；且如 M-1 所述，用户最终只看到最后一轮正文 ⇒ **付了 4 倍价钱拿到 1/4 的内容**。
**修法方向** 加 `DSH_CODERLY_STALL_RETRY=0` 逃生门；把默认预算降到 1（先修 M-1 的正文丢失，再考虑提高）。

---

### m-5（建议）`provider-icons.js` 有 3 个重复键（`autoclaw` / `modelscope` / `aggregate`）

**文件:行** `plugin-src/client/provider-icons.js:307,312,313`（第一份）与 `:314,315,319`（重复的第二份，**无缩进**）

**现象**
```js
  modelscope: MODELSCOPE_ICON,
  aggregate: AGGREGATE_ICON,
autoclaw: AUTOCLAW_ICON,        ← 重复键（无缩进，明显是手贴进来的）
modelscope: MODELSCOPE_ICON,    ← 重复键
codely: CODELY_ICON,
aggregate: AGGREGATE_ICON,      ← 重复键
```
**判据** `node -e` 抽 `PROVIDER_ICONS` 的键：`keys: 26 dups: ['autoclaw','modelscope','aggregate']`。JS 里后者覆盖前者（同值，**行为无变化**），但缩进崩坏 + 重复键说明这是**手工 merge 的残留**。
**后果** 行为无害；但「键集合守卫」用 `Object.keys` ⇒ 重复键不可见，下次有人改第一份会**以为改到了**（实际被第二份覆盖）。这是本仓「同一事实多份抄写必然漂移」的又一实例。
**修法方向** 删掉 `:314/:315/:319` 三行（保留带注释与缩进的第一份）。

---

### m-6（建议）`AGENTS.md` 被整文件重写（CRLF/编码噪声），真实改动只有 1 行

**文件:行** `AGENTS.md`（`git diff --stat` = `1802 ++++----`）

**现象** `git diff --ignore-all-space master..HEAD -- AGENTS.md` 仍是 `1802` 行 ⇒ 不是空白差异；实际是**整文件行尾/编码重写**（审计期间该文件又被 amend 了一次，`021ff8b4 → 9c4776c6` 只改这一个文件、`901 insertions / 901 deletions`）。文件本身仍是 CRLF（`git show master:AGENTS.md | od -c` 与 `head -3 AGENTS.md | od -c` 都是 `\r\n`）⇒ 是**逐行内容被重写**（大概率是编辑器/工具整篇重排）。
**判据** `git diff --stat --ignore-all-space` 与普通 diff **行数相同**（1802）⇒ 不是空格问题，是行内容/顺序变动；而 `.gitattributes` 只保护 `tests/fixtures/**`，对 `AGENTS.md` 无约束。
**后果** 1802 行噪声把真实 diff 埋掉（本 PR 的 59 个文件里它是最大的一块），reviewer 无法看出「到底改了什么」；且后续 merge 会持续冲突（本次合并已经因为 `AGENTS.md` 冲突手工解过一遍）。
**修法方向** 从 `master` 取回 `AGENTS.md`，只重放**真实需要的那一处**改动（新增第五条指纹的那段），确保 `git diff master..HEAD -- AGENTS.md` 只剩几十行。

---

## 变异验证表

全部在隔离 worktree `D:\jet\code\js\_audit-blue`（`git worktree add --detach … 021ff8b4`，`node_modules` 用目录联接）里做；每次变异前打印 `ANCHOR present: true/false` 与实际被替换片段自证；跑完 `git checkout --` 还原（`git diff --stat` 归零）。**没有一条 `PATCH-NOT-APPLIED`**（第一轮两次失败是我把 `\r\n` 写成了 `\n`，改用 `JSON.stringify` 生成配置后命中 —— 已按本仓纪律先自证锚点再判「无牙」）。

| # | 守卫 / 被测文件 | 变异 | 结果 | 归因 |
|---|---|---|---|---|
| 1 | `codely-adapter.spec.ts`（★★ 正文+工具） | `const idx = 2 + (…)` → `const idx = (…)`（工具 index 不抬高） | **变红** 2 条 | 有牙 |
| 2 | `codely-adapter.spec.ts`（★★ 远端过滤成空） | `if (filtered.length === 0 && this.remoteModels !== undefined)` → `if (false)` | **变红** 1 条 | 有牙 |
| 3 | `codely-rotation.spec.ts` | `getAvailableAccount(…, model, tried)` → `getAvailableAccount(…, model)`（漏传 `tried`） | **全绿** | **无牙** —— 判据没抓住：`exchangeAuth` 顺序断言不依赖 `tried`；池替身的 `exclude` 腿把它掩盖 |
| 4 | `codely-rotation.spec.ts` | 换发失败分支的 `updateModelRateLimit(...)` → `void 0` | **全绿** | **无牙** —— 该腿零断言 |
| 5 | `codely-rotation.spec.ts` | 变异 3 + 变异 4 同时 | **全绿** | **无牙**（同上） |
| 6 | `provider-runtime-wiring.spec.ts` | `WRITES_RATE_LIMIT_PROVIDERS` 删掉 `'codely'` | **变红** 2 条 | 有牙（点名 `probeById` 与写点清单漂移） |
| 7 | `provider-runtime-wiring.spec.ts` + `claim-runtime-parity.spec.ts` | `src/index.ts` 的 `if (codelyRuntimeDescriptor !== undefined && …)` → `if (false)` | **变红** 3 条 | 有牙（含签到能力交叉校验） |
| 8 | `refresh-targets-derived.spec.ts` | `src/index.ts` 删掉 `codely: pruned(CODERLY.id, codelyAdapter),` | **变红** 2 条（用例⑦ + ⑨） | 有牙 |
| 9 | `openai-gateway-tencent-fingerprint.spec.ts` | 第 5 条指纹 `find` 砍掉后半句（221 → 107 字符） | **变红** 5 条 | 有牙（长度判据 + 切句两半 + 互不干扰） |
| 10 | `openai-gateway-config.spec.ts` | `if (options.allowLan === true && !isGatewayHostFromEnv(env))` → 去掉 env 优先 | **变红** 1 条 | 有牙 |
| 11 | `openai-gateway-config.spec.ts` | `if (!isLegalHostText(host))` → `if (false)`（拆掉 fail-closed 闸门） | **变红** 3 条 | 有牙 |
| 12 | `codely-adapter-errors.spec.ts` | `'codely-core': ['reasoning','tools']` → 加 `'image'` | **变红** 1 条 | 有牙 |
| 13 | `codely-sign.spec.ts` | `join('\n')` → `join('\|')`（分隔符 LF → `\|`） | **变红** 2 条 | 有牙 |
| 14 | `codely-credits.spec.ts` | `readPoints` 去掉 `value.trim().length > 0`（空串当 0） | **变红** 1 条 | 有牙 |
| 15 | `codely-checkin.spec.ts` | `can_check_in !== true` → `=== false` | **全绿** | **无牙** —— 缺「字段缺失」夹具 |
| 16 | `openai-gateway-panel.spec.ts` | `if (status.allowLan && status.running)` → `if (status.allowLan)`（谎报已监听） | **变红** 1 条 | 有牙 |
| 17 | `openai-gateway-wiring.spec.ts` + `jet-hub-store.spec.ts` + `openai-gateway-panel.spec.ts` | `src/account-pool.ts` 删掉 `gatewayAllowLan: this.gatewayAllowLanCache,`（整体替换漏键） | **全绿** 182 条 | **无牙** —— 缺「重启后读回」的夹具（我用一次性探针实测到 `after reload: false`，证明缺陷可达） |
| 18 | `dsml-tool-delivery.spec.ts` | `src/codely-adapter.ts` 的 `tools:` → `toolsXX:`（真删掉下发） | **全绿** 7 条 | **无牙** —— codely 被 `exempt` 豁免，判据对它零覆盖 |

**统计：18 条变异，有牙 11 条 / 无牙 7 条（#3/#4/#5/#15/#17/#18，其中 #3/#4/#5 同源）/ `PATCH-NOT-APPLIED` 0 条。**

**基线（主工作树，未改任何文件）**
```
npx vitest run tests/unit/codely-*.spec.ts
  → 7 files / 68 tests passed
npx vitest run provider-registry / provider-runtime-wiring / refresh-targets-derived /
  credits-runtime-parity / claim-runtime-parity / credits-capabilities / zcode-wiring /
  openai-gateway-{wiring,config,panel,tencent-fingerprint} / dsml-{tool-delivery,normalizer-coverage}
  → 13 files / 409 tests passed
npx tsc -p tsconfig.json --noEmit → EXIT=0
```

---

## 已核对为「无问题」的关键接线清单

| 接线点 | codely 是否到位 | 证据 |
|---|---|---|
| `probeById.codely` | ✅ | `src/index.ts:876-891`；变异 #6 有牙 |
| `WRITES_RATE_LIMIT_PROVIDERS` 含 `'codely'` | ✅ | `tests/helpers/provider-sets.ts:288-292`；变异 #6 有牙 |
| `probeById` → `runtimeOf` 可达（**本 PR 新修**） | ✅ | `src/index.ts:5330-5340` 单独注册；变异 #7 有牙（这条修的是真实可达缺陷：`probe` 域原先只在 `registry` 循环里挂） |
| `modelAdapters.codely`（`provider.status` 的模型数/关闭） | ✅ | `src/index.ts:4882`；变异 #8 有牙（用例⑦ + 新增用例⑨） |
| `REF_PREFIX_TO_PROVIDER` 的 `['CODELY','codely']` | ✅ | `src/jet-hub-store.ts:1176-1179`（恢复表按全量 registry 派生） |
| `credits.balance` → `provider-credits.ts` 的 codely 条目 | ✅ | `src/provider-credits.ts:405-437`；`credits-runtime-parity.spec.ts` 的 `BALANCE_PATH_OF.codely` 已登记 |
| `balance:true` + **无 runtime** 时的回退表 | ✅ | `src/index.ts:4630-4670`（`FALLBACK_CREDITS_TABLE`）—— 这是本 PR 修的真实缺陷，有 `credits-runtime-parity` 兜 |
| `dailyCheckin` + `precheckStatus:false` | ✅ | `src/provider-credits.ts:421-436`；`claim-runtime-parity.spec.ts` 计数 10→11 并注明原因 |
| `provider-icons` 有 `codely` 键 | ✅（但有重复键，见 m-5） | `plugin-src/client/provider-icons.js:318` |
| `jet-hub-styles` 有 `.dim-jh-providerIcon.codely` | ✅ | `plugin-src/client/jet-hub-styles.js:100-103`（注释里**没有**反引号，模板字符串安全） |
| `PLUGIN_ID` / `package.json.name` / `cordis.patch.yml` / `build.mjs` 四处同名 | ✅ 未改动 | 本 PR 只往 `package.json` 加了一条 `test:e2e:buddy-fingerprint` script，四个身份字面量都没碰 |
| **登录三态**（`login.poll`） | ✅ | `src/jet-hub-rpc.ts:4888-4945` 的 codely 分支用 `failLogin(id, error)`（不是裸 `removeAccount`），终态走 `recordLoginFailure`；`codely-login.spec.ts` 的「denied」用例断言 `{done:true, success:false}` 且 `removed` 含该 id |
| 登录失败**不删已落库凭据** | ✅ | `failLogin` 先 `loginCredentialLanded`（`'yes'` ⇒ 只记日志不删）；codely 分支符合 |
| `expires_at` 秒/毫秒 | ✅ **无混淆** | `decodeCodelyJwtExpMs` 返回**毫秒**（`Math.floor(exp*1000)`），落盘时 `new Date(ms).toISOString()`；`expiresAt` 池字段也是毫秒。**不是** accio 那种「上游给秒当毫秒用」 |
| JWT `exp` 缺失不编造 | ✅ | 三处都 `undefined` 缺省；`codely-login.spec.ts` 有 3 条（非 JWT / 缺 exp / 非 JSON） |
| `errorDetail` vs `errorDetailForClassify` | ✅ 未涉及 | codely 适配器自己构造 `LlmError`，不走 `openai-compat` 的 `httpErrorCode` ⇒ 两条出口无分叉风险 |
| 额度错误码**字面量** `'QUOTA_EXCEEDED'` | ✅ | `src/codely-adapter.ts:807`；变异 #4 之外的 `QUOTA_EXCEEDED` 断言在 `codely-rotation.spec.ts:163-180`（有牙，通过 #6/#7 的交叉验证间接覆盖） |
| `AUTH` 码会吞 message | ✅ 已避开 | codely 无 `'AUTH'`；401/403 走 `PERMISSION_DENIED`（`codely-adapter.ts:817-820`），无凭据/换发失败也 `PERMISSION_DENIED` 且文案给可执行出路 |
| **局域网开关 fail-closed** | ✅ | `isLegalHostText` 只放行 `[A-Za-z0-9.:%_-]`，**先字符闸门 → 再通配识别**；`allowLan:true` 走**程序内字面量** `'0.0.0.0'`、不经 `resolveHost`；env 里的通配值**仍被拒**（变异 #10/#11 有牙） |
| 局域网开关**收敛判据与工厂同源** | ✅ | `runtime.ts` 的 `desiredWildcard = desiredAllowLan && !isGatewayHostFromEnv(env)`；`openai-gateway-wiring.spec.ts` 有「连续 3 次收敛不重建」的回归锁（有牙） |
| 局域网开关**持久化缺键 = 关闭** | ✅ | `sanitizeGatewayAllowLan` 只认 `=== true`；`SettingsStore` / `FileStore` / 恢复表三处都写 `false` 缺省；`jet-hub-store.spec.ts` 三处断言 |
| 局域网开关**UI 禁用判据** | ✅ | `gatewayAllowLanSwitchDisabled` 只在 `hostFromEnv` 时禁；`gatewayAllowLanHint` **同时判 `running`**（变异 #16 有牙 —— 这条修的是「谎报已监听」的真实缺陷） |
| 绑非回环时的**日志留痕** | ✅ | `src/openai-gateway/server.ts:528-534`（`logger.warn` 明说暴露面） |
| 客户端回环判据**复用宿主实现** | ✅ | `openai-gateway-panel.js` import `isLoopbackHost` / `isWildcardHost`（`../../src/openai-gateway/config.js`），不自己写正则 |
| **第 4 条指纹**（DSH 身份首句） | ✅ | `find` 不带尾句点 ⇒ 覆盖带/不带句点；`replace` 换成官方同形措辞且**不再含 `DeepSeek Harness`**；有 4 条用例（含幂等、大小写、整段真实 system） |
| **第 5 条指纹**（Web 运行面两句） | ✅ **逐字节核对通过** | 我用 `node` 从 DSH 安装包 `dsh-harness-dev-context/lib/index.js` 抽出 `WEB_SURFACE_PROMPT`，断言 `find === real.slice(0,221)` **为 true**、`real.includes(find)` 为 true、`find.length === 221` ⇒ **不是手抄错**；且 `find` 位置无关（与第 4 条的**行首锚定相反**，符合笔记） |
| 第 5 条指纹的**漂移守卫** | ✅（弱） | `openai-gateway-tencent-fingerprint.spec.ts:667-711` 读本机 `~/.dsh/sessions` 真实 system；读不到时**自行退回**（不假红）—— 如实登记：它锁得住「措辞改了会红」，锁不住「DSH 改了措辞而 find 没跟上」之外的场景 |
| 请求体超限 413 | ✅ 未改动 | `src/openai-gateway/server.ts` 本 PR 只加了 `allowLan` 与一条 warn，413 / `keepAliveTimeout` 逻辑逐字节未变 |
| `AGGREGATE_CHANNELS` | ❌ **缺 codely**（见 M-2） | `src/aggregate-adapter.ts:1291-1370` |
| `WIRED_EXPIRY_PROVIDERS` / `createProviderExpiry()` | ❌ **缺 codely**（见 M-2） | `src/aggregate-expiry.ts:185-270`、`src/provider-expiry.ts` |
| `SELF_HEAL_REFRESHABLE_PROVIDERS` | ❌ **缺 codely**（见 M-2 / B-1） | `src/jet-hub-rpc.ts:2266-2340` |
| `ACCIO_ACCOUNT_*` 那类前缀表 | ✅ | `REF_PREFIX_TO_PROVIDER` 已加 `CODELY`（见上表） |
| **两张注册表**（`provider-registry.ts` + `provider-runtime.ts`） | ✅（runtime 侧本 PR 新修） | `registerProviderRuntime({descriptor, credits, expiry, probe})`，**刻意不给 `auth`**（否则 `account.refresh` 谎称支持续期）—— 这个取舍是对的，但反过来说明 B-1 的「续期不存在」必须**如实写进 UI/注释** |
| `getAvailableAccount` 第 3 参 `tried` | ⚠️ 生产代码**传了**，但**无牙**（变异 #3） | `src/codely-adapter.ts:680` / `:766` 都传 `tried`；缺守卫 |
| 多账号轮换的坏凭据跳过 | ✅ | `while (next !== null && !usableCodelyCredential(...))` 两处（`:681-684` / `:767-770`），不消耗 HTTP 尝试、不记账 |
| 记账失败不掐断换号 | ✅ | 两处 `try { … } catch { }`（`:672-676` / `:749-760`） |

---

## 未能验证的项（如实标注）

1. **真机/真实凭据路径**：所有 codely 上游行为（`/auth/refresh` 是否真 200 且不轮换、`/api/model-status` 的 8 个模型组、`/api/points/check-in` 的 `can_check_in` 语义）都是**读注释与测试夹具**，本轮**没有发任何真实请求**（无凭据、且本仓纪律禁止对真实凭据做写操作）。故 B-1 里「`/auth/refresh` 实测 200」这条我**按注释采信、未复核**。
2. **`channel: false` 是否**还**驱动了别的用户可见行为**：我逐处 grep 了 `src/`（`\.channel\b` 排除注释只有 2 行、都不是生产读取），但**测试侧的派生表**（`expectedProviderIdsWithAuth` / `AGGREGATE_CHANNELS` 比对 / `credits-balance-self-heal` 的 `d.channel` 判据）用了它，其中 `credits-balance-self-heal.spec.ts:760` 的 `d.channel` 判据会让 codely **被自动豁免**（见 M-2）。这条我**已确证判据形态**，但**未做变异**证明「补上 codely 后会红」。
3. **`gatewayStatusLines` 崩溃面的真实触发概率**：我实测了「`running:true` + `address:null`」会抛 `TypeError`（m-1），但宿主侧 `degrade('监听地址', …)` 什么时候会失败**未实测**（需要 `gatewayAddress()` 抛错，而它是 `running?.address()`，只在实例方法抛错时才失败）。
4. **`stalled` 重试在真实客户端上的表现**：我用真实 `BlockAssembler` 证明了「最终 blocks 只剩最后一轮」（M-1），但**未验证** DSH 客户端/落盘层对「多次 `block-start(index:0)`」的另外处理（例如它是否按 chunk 顺序另行记录、从而在 UI 侧不丢字）。M-1 的结论以 `BlockAssembler`（`@deepseek-ai/dsh-llm` 的**权威组装器**）为准。
5. **`AGENTS.md` 那 1802 行改动的具体语义**：我确认了「不是空白差异」（`--ignore-all-space` 仍 1802 行）与「仍是 CRLF」，但**没有逐行 diff 出真实改动**（那是 `docs/` 文档，不是代码；且审计期间该文件被 amend，diff 已变）。
6. **`.codely-cli/` 是否已推到远端**：我只确认它在**本地索引**里（`git ls-files`）；Gitee 远端的实际状态未查（本轮未联网）。
7. **`codely-cli.ts` 的 CLI 路径默认值**（`D:\Program File\Tuanjie Cowork\cli\bin\win32-x64\codely.exe`）是**硬编码的本机绝对路径**，生产用户机器上必然不存在 ⇒ 只能靠 `DSH_CODERLY_CLI_PATH`。我**未**把它列为缺陷，因为 `stream()` 生产路径**默认走 HTTP**（`cliSpawner` 只有测试注入），该常量只在测试/兜底路径用；但它作为「默认安装路径」在非本机是**恒不命中**的，如实登记。
8. **`docs/agent-notes/providers-codely.md` 不存在**：本 PR 新增了一个 provider 却没有对应的 agent-note（`AGENTS.md` 的「深细节索引」里 19 个 provider 笔记都没有 codely）。这属于**建议**（未单列，因为不影响运行行为），但按本仓纪律「改某 provider 前先读它的笔记」，缺笔记会让下一个人重踩同样的坑。

---

## 本轮到此

上面每一条都带「文件:行 + 判据 + 后果 + 修法方向」；变异验证 18 条（有牙 11 / 无牙 7 / `PATCH-NOT-APPLIED` 0），基线 7 + 13 个 spec 文件全绿、`tsc --noEmit` 通过。**未修改任何 `src/` / `tests/` 文件**；隔离 worktree `_audit-blue` 已清理。
