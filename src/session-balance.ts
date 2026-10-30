/**
 * 按 **sessionId** 做账号亲和 / 无 sessionId 时随机分摊的纯函数。
 *
 * ## 为什么需要它
 *
 * 账号池此前的 `getAvailableAccount()` 永远取「手动顺序第一个可用账号」：
 * 只要 1 号没撞限额，全部流量都压在它身上。对 ZCode 这种「一个会话会连续
 * 发很多轮请求」的 provider，用户希望：
 *
 * - **有 sessionId**：同一会话固定落到同一个账号（会话亲和），不同会话按
 *   sessionId 稳定分散到不同账号；
 * - **没有 sessionId**（本地 OpenAI 网关等一次性调用）：每次随机挑一个账号，
 *   把请求分摊开。
 *
 * ## 为什么用 rendezvous 哈希而不是 `hash % N`
 *
 * `hash(sessionId) % 账号数` 在账号数变化时会**整体重排**：某个账号临时进入
 * 限流（候选集从 5 个变 4 个）会让所有会话换号，限流恢复后又全部换回。
 * rendezvous 哈希给每个 `(session, account)` 算一个稳定分数、按分数排序取最高，
 * 账号集合变化时只有原本落在那个账号上的会话需要迁移，其余会话保持不动。
 *
 * ## 为什么随机回退用洗牌而不是「随机取一个」
 *
 * 随机取一个若刚好拿到凭据损坏 / 已被 `tried` 排除的账号，还要再抽一次；
 * 直接洗牌后顺序尝试，既均匀又不重复。
 */

import { createHash } from 'node:crypto'

/**
 * 「ZCode 会话负载均衡」的开关环境变量。
 *
 * ## 默认与判据（与 `DSH_RATE_LIMIT_SINK` 同型，**别写成 falsy 判断**）
 *
 * 默认**开启**（用户 2026-10-30 的原始需求）。留这道开关是因为它改变了选号
 * 语义：手动顺序不再决定谁先被用；若有人依赖「首位账号一直扛」的旧行为
 * （例如想让额度最充足的号先烧完），显式设 `0` / `false` / `off` / `no`
 * 即整体退回「手动顺序优先」的既有路径 —— 与关掉前逐字节同语义。
 *
 * ⚠️ 判据取「**显式写了** `0/false/off/no` 才算关」，未设置 / 空串 / 无法
 * 识别的值一律按默认开启 —— `Boolean(env[...])` 会把「未设置」误判成关闭
 * （`account-pool.ts` 的 `rateLimitSinkEnabled` 记过同型坑）。
 *
 * ⚠️ **与 `jet-hub-store.ts` 的 `sanitizeSessionBalanceEnabled` 是两套刻意
 * 不同的判据，不要「统一」**：本函数是 **env 替身回落**（字符串宽松，`'false'`
 * 算关 —— env 里没有类型，用户写了就是意图）；store 那份是**落盘数据判据**
 * （严格 `raw !== false` —— 脏字符串 ≠ 用户意图，宁可当启用）。生产路径恒走
 * store 那份（见 `credential-resolver.ts` ③ 的 poolSwitch 优先级），本函数
 * 只在「结构化替身池」可达。
 */
export const DSH_ZCODE_SESSION_BALANCE = 'DSH_ZCODE_SESSION_BALANCE'

/** 当前是否启用「ZCode 会话负载均衡」（见 {@link DSH_ZCODE_SESSION_BALANCE}）。 */
export function sessionBalanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DSH_ZCODE_SESSION_BALANCE]
  if (typeof raw !== 'string') return true
  const value = raw.trim().toLowerCase()
  if (value.length === 0) return true
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no')
}

/** 计算 `(scope, sessionId, accountId)` 的稳定分数（SHA-256 十六进制）。 */
export function sessionAccountScore(scope: string, sessionId: string, accountId: string): string {
  return createHash('sha256')
    .update(scope)
    .update('\0')
    .update(sessionId)
    .update('\0')
    .update(accountId)
    .digest('hex')
}

/**
 * 按 sessionId 给账号做 **rendezvous 哈希**排序（分数从高到低）。
 *
 * - 同一个 sessionId + 同一批账号 ⇒ 结果逐字稳定（跨进程、跨重启一致）；
 * - 不同 sessionId 会得到不同顺序，从而把会话分散到不同账号；
 * - 账号集合增删时，只影响原本首选该账号的会话，其余顺序尽量保持。
 *
 * @param accounts - 候选账号（调用方已按 enabled / 模型限流 / tried 过滤）。
 * @param sessionId - 非空会话标识。
 * @param scope - 命名空间（传 provider id），避免不同 provider 的同名账号串味。
 * @returns 新数组，不修改入参。
 */
export function rankAccountsBySession<T extends { id: string }>(
  accounts: readonly T[],
  sessionId: string,
  scope: string,
): T[] {
  return [...accounts].sort((a, b) => {
    const sa = sessionAccountScore(scope, sessionId, a.id)
    const sb = sessionAccountScore(scope, sessionId, b.id)
    if (sa !== sb) return sa < sb ? 1 : -1
    // 哈希碰撞在 SHA-256 下实际不可达；保留确定性的 id 次序，避免引擎排序不稳定。
    return a.id.localeCompare(b.id)
  })
}

/**
 * Fisher–Yates 洗牌（不改入参）。
 *
 * `random` 可注入，供单测固定序列；生产缺省 `Math.random`。
 */
export function shuffleAccounts<T>(accounts: readonly T[], random: () => number = Math.random): T[] {
  const out = [...accounts]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    const current = out[index]!
    out[index] = out[swapIndex]!
    out[swapIndex] = current
  }
  return out
}
