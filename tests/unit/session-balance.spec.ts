/**
 * ZCode 会话负载均衡（2026-10-30 用户要求）的**纯函数 + 账号池**回归。
 *
 * 守三件事：
 * 1. 同一 sessionId 在固定账号集合上**永远**得到同一个首选账号（跨进程稳定）；
 * 2. 不同 sessionId 会分散到全部账号（负载均衡），且账号集合变化时只迁移少量会话；
 * 3. 没有 sessionId 的请求走**随机**顺序，而不是继续压手动顺序第一个。
 * 4. 总开关 `DSH_ZCODE_SESSION_BALANCE`：默认开；显式 0/false/off/no 关
 *    （判据与 `rateLimitSinkEnabled` 同型，未设置/空串/未知值一律开）。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import {
  DSH_ZCODE_SESSION_BALANCE,
  rankAccountsBySession,
  sessionAccountScore,
  sessionBalanceEnabled,
  shuffleAccounts,
} from '../../src/session-balance.js'
import { ZCODE } from '../../src/zcode-product.js'

const ACCOUNTS = [
  { id: 'zcode-a' },
  { id: 'zcode-b' },
  { id: 'zcode-c' },
  { id: 'zcode-d' },
  { id: 'zcode-e' },
]

describe('session-balance 纯函数', () => {
  it('同一 sessionId + 同一账号集合 ⇒ 顺序逐字稳定', () => {
    const first = rankAccountsBySession(ACCOUNTS, 'session-abc', 'zcode').map(a => a.id)
    const second = rankAccountsBySession([...ACCOUNTS].reverse(), 'session-abc', 'zcode').map(a => a.id)
    expect(first).toEqual(second)
    expect(first).toHaveLength(ACCOUNTS.length)
  })

  it('不同 scope / sessionId / accountId 的分数不同（避免串味）', () => {
    expect(sessionAccountScore('zcode', 's1', 'a')).not.toBe(sessionAccountScore('zcode', 's1', 'b'))
    expect(sessionAccountScore('zcode', 's1', 'a')).not.toBe(sessionAccountScore('zcode', 's2', 'a'))
    expect(sessionAccountScore('zcode', 's1', 'a')).not.toBe(sessionAccountScore('buddy', 's1', 'a'))
  })

  it('1000 个 sessionId 分散到 5 个账号：每个账号都分到足量会话', () => {
    const counts = new Map<string, number>(ACCOUNTS.map(a => [a.id, 0]))
    for (let index = 0; index < 1000; index += 1) {
      const first = rankAccountsBySession(ACCOUNTS, `session-${index}`, 'zcode')[0]!.id
      counts.set(first, (counts.get(first) ?? 0) + 1)
    }
    // 1000/5 = 200；只要求每档 > 150，避免把 SHA-256 的均匀性写成精确断言。
    expect([...counts.values()].every(count => count > 150)).toBe(true)
  })

  it('rendezvous：移除一个账号时，原本不落在它上面的会话不变', () => {
    const before = new Map<string, string>()
    for (let index = 0; index < 200; index += 1) {
      before.set(`s-${index}`, rankAccountsBySession(ACCOUNTS, `s-${index}`, 'zcode')[0]!.id)
    }
    const removed = 'zcode-c'
    const afterAccounts = ACCOUNTS.filter(a => a.id !== removed)
    let moved = 0
    let unchanged = 0
    for (const [sessionId, previous] of before) {
      if (previous === removed) continue
      const next = rankAccountsBySession(afterAccounts, sessionId, 'zcode')[0]!.id
      if (next === previous) unchanged += 1
      else moved += 1
    }
    // 只要求「绝大多数不变」；rendezvous 的理论迁移比例约为 1/N。
    expect(unchanged).toBeGreaterThan(moved * 3)
  })

  it('shuffleAccounts 用注入随机数可复现，且不修改入参', () => {
    const original = [...ACCOUNTS]
    const sequence = [0.9, 0.1, 0.7, 0.3]
    let index = 0
    const shuffled = shuffleAccounts(ACCOUNTS, () => sequence[index++]!)
    expect(shuffled).not.toEqual(ACCOUNTS)
    expect(new Set(shuffled.map(a => a.id))).toEqual(new Set(ACCOUNTS.map(a => a.id)))
    expect(ACCOUNTS).toEqual(original)
  })
})

describe('DSH_ZCODE_SESSION_BALANCE 开关判据', () => {
  it('未设置 / 空串 / 未知值 ⇒ 默认开启', () => {
    expect(sessionBalanceEnabled({} as never)).toBe(true)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: '' } as never)).toBe(true)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: '  ' } as never)).toBe(true)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: 'yes' } as never)).toBe(true)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: '1' } as never)).toBe(true)
  })

  it('显式 0 / false / off / no（大小写与空白容忍）⇒ 关闭', () => {
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: '0' } as never)).toBe(false)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: 'false' } as never)).toBe(false)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: 'OFF' } as never)).toBe(false)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: ' no ' } as never)).toBe(false)
  })
})

/** 内存版 credentials + settings，供真实 `AccountPool` 使用。 */
function makePool(): { pool: AccountPool } {
  const ctx = new Context()
  const credentials = new Map<string, string>()
  const settingsState: { value: unknown } = { value: undefined }
  ;(ctx as unknown as { credentials: unknown }).credentials = {
    resolve: async (ref: { toString(): string }) => {
      const value = credentials.get(String(ref))
      return value === undefined ? undefined : { value, source: 'fake' }
    },
    set: async (ref: { toString(): string }, value: string) => { credentials.set(String(ref), value) },
    unset: async (ref: { toString(): string }) => { credentials.delete(String(ref)) },
  }
  ;(ctx as unknown as { settings: unknown }).settings = {
    register() {
      return {
        get: () => settingsState.value,
        replace: (value: unknown) => { settingsState.value = value },
      }
    },
    describe() { return [] },
  }
  ;(ctx as unknown as { logger: unknown }).logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const pool = new AccountPool(ctx as never)
  // 五个账号，凭据全部有效；账号 id 与 provider 走真实 zcode 形状。
  for (const [index, account] of ACCOUNTS.entries()) {
    void pool.addAccount({
      id: account.id,
      provider: ZCODE.id,
      nickname: account.id,
      enabled: true,
      credentialRef: `ZCODE_ACCOUNT_TEST_${index}`,
      refreshable: false,
      createdAt: index + 1,
    } as never)
    credentials.set(`ZCODE_ACCOUNT_TEST_${index}`, JSON.stringify({
      zcode_jwt: `jwt-${account.id}`,
      device_mid: `mid-${account.id}`,
    }))
  }
  return { pool }
}

describe('AccountPool.getAvailableAccountForSession', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('同一 sessionId 重复调用始终返回同一个账号', async () => {
    const { pool } = makePool()
    const first = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-sticky')
    const second = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-sticky')
    expect(first?.entry.id).toBe(second?.entry.id)
  })

  it('不同 sessionId 分散到多个账号（不是永远第一个）', async () => {
    const { pool } = makePool()
    const ids = new Set<string>()
    for (let index = 0; index < 30; index += 1) {
      const picked = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', `session-${index}`)
      ids.add(picked!.entry.id)
    }
    expect(ids.size).toBeGreaterThanOrEqual(3)
  })

  it('没有 sessionId 时随机顺序：Math.random 不同 ⇒ 首个账号不同', async () => {
    const { pool } = makePool()
    // 0.99 的 Fisher-Yates 序列不产生交换 ⇒ 原顺序第一个；0 会把首位换到后面。
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const first = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash')
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const second = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash')
    expect(first?.entry.id).not.toBe(second?.entry.id)
  })

  it('限流账号会被候选筛排除，即使 sessionId 哈希原本指向它', async () => {
    const { pool } = makePool()
    const blocked = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-sticky')
    await pool.updateModelRateLimit(blocked!.entry.id, 'GLM-5.3-Flash', Date.now() + 3_600_000)
    const next = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-sticky')
    expect(next?.entry.id).not.toBe(blocked!.entry.id)
    expect(next).not.toBeNull()
  })

  it('excludeAccountIds 排除哈希首选的账号，换下一个', async () => {
    const { pool } = makePool()
    const first = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-exclude')
    const next = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-exclude', new Set([first!.entry.id]))
    expect(next?.entry.id).not.toBe(first!.entry.id)
  })

  it('★ 开关关闭（DSH_ZCODE_SESSION_BALANCE=0）时 resolver 回落手动顺序首个账号', async () => {
    const { pool } = makePool()
    // 开着时这个 sessionId 不落在手动顺序第一个账号上（若落在，换一个肯定不落的）。
    const balanced = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-off')
    const manualFirst = await pool.getAvailableAccount('zcode', 'GLM-5.3-Flash')
    const sessionId = balanced!.entry.id === manualFirst!.entry.id
      ? 'session-off-2'
      : 'session-off'
    expect(await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', sessionId))
      .not.toBe(null)

    // 关掉开关 ⇒ resolver 走 getAvailableAccount（手动顺序），不再进 session 路径。
    vi.stubEnv(DSH_ZCODE_SESSION_BALANCE, '0')
    const resolver = await import('../../src/credential-resolver.js')
    const sessionCalls: Array<string | undefined> = []
    const manualCalls: Array<string> = []
    const resolve = resolver.createCredentialResolver<{ token: string }>(
      {
        pool: {
          listAccountsByProvider: () => [],
          permanentLocked: () => false,
          getAvailableAccount: async (provider: string) => {
            manualCalls.push(provider)
            return { entry: { id: 'zcode-a', credentialRef: 'R' }, credential: { token: 'A' } }
          },
          getAvailableAccountForSession: async (
            _provider: string,
            _modelId: string,
            sessionId?: string,
          ) => {
            sessionCalls.push(sessionId)
            return { entry: { id: 'zcode-b', credentialRef: 'R' }, credential: { token: 'B' } }
          },
        } as never,
        reportAccount: () => {},
      },
      {
        product: { id: 'zcode', displayName: 'ZCode (智谱)' },
        readCredential: async () => undefined,
        fallback: { kind: 'custom', resolve: async () => undefined },
        accountSelection: 'session-balance',
      },
    )
    const credential = await resolve('GLM-5.3-Flash', sessionId)
    // 判据：session 方法**一次都没被调用**（开关闭合在 resolver 入口，不在池内），
    // 且落到手动顺序的 getAvailableAccount。
    expect(sessionCalls).toEqual([])
    expect(manualCalls).toEqual(['zcode'])
    expect(credential).toEqual({ token: 'A' })
    vi.unstubAllEnvs()
  })
})
