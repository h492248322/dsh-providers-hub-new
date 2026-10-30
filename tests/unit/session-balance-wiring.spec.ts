/**
 * ZCode 会话负载均衡的**接线**回归：`accountSelection: 'session-balance'` 必须
 * 真的把 DSH 的 `sessionId` 传到池，而不是只停在纯函数里。
 */
import { describe, expect, it, vi } from 'vitest'
import { createCredentialResolver, type ResolverPool } from '../../src/credential-resolver.js'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { ZCODE } from '../../src/zcode-product.js'

const PRODUCT = { id: 'zcode', displayName: 'ZCode (智谱)' }

function resolverPoolWithSession(): ResolverPool<{ token: string }> & {
  sessionCalls: Array<{ sessionId: string | undefined; exclude: string[] }>
} {
  const sessionCalls: Array<{ sessionId: string | undefined; exclude: string[] }> = []
  return {
    sessionCalls,
    listAccountsByProvider: () => [],
    permanentLocked: () => false,
    getAvailableAccount: async () => {
      throw new Error('session-balance 不应回落到手动顺序的 getAvailableAccount')
    },
    getAvailableAccountForSession: async (_provider, _modelId, sessionId, exclude) => {
      sessionCalls.push({ sessionId, exclude: [...(exclude ?? [])] })
      return { entry: { id: 'zcode-a', credentialRef: 'R' }, credential: { token: 'A' } }
    },
  }
}

describe('createCredentialResolver · session-balance 接线', () => {
  it('把 sessionId 传给池的 getAvailableAccountForSession', async () => {
    const pool = resolverPoolWithSession()
    const resolve = createCredentialResolver({ pool }, {
      product: PRODUCT,
      readCredential: async () => undefined,
      fallback: { kind: 'custom', resolve: async () => undefined },
      accountSelection: 'session-balance',
    })
    const credential = await resolve('GLM-5.3-Flash', 'session-xyz')
    expect(credential).toEqual({ token: 'A' })
    expect(pool.sessionCalls).toEqual([{ sessionId: 'session-xyz', exclude: [] }])
  })

  it('池没有 session 方法时回落 getAvailableAccount（兼容旧测试桩）', async () => {
    const calls: string[] = []
    const pool: ResolverPool<{ token: string }> = {
      listAccountsByProvider: () => [],
      permanentLocked: () => false,
      getAvailableAccount: async () => {
        calls.push('manual')
        return { entry: { id: 'zcode-a', credentialRef: 'R' }, credential: { token: 'A' } }
      },
    }
    const resolve = createCredentialResolver({ pool }, {
      product: PRODUCT,
      readCredential: async () => undefined,
      fallback: { kind: 'custom', resolve: async () => undefined },
      accountSelection: 'session-balance',
    })
    await resolve('GLM-5.3-Flash', 'session-xyz')
    expect(calls).toEqual(['manual'])
  })
})

describe('ZcodeAdapter 把 sessionId 继续往下传', () => {
  it('resolveCredentialOrThrow 调 resolveCredential 时带 model / sessionId，并取回本次账号 id', async () => {
    const resolveCredential = vi.fn(async (
      _modelId?: string,
      _sessionId?: string,
      picked?: { accountId?: string },
    ) => {
      if (picked !== undefined) picked.accountId = 'zcode-a'
      return { zcode_jwt: 'jwt', device_mid: 'mid' }
    })
    const adapter = new ZcodeAdapter({
      credentialRef: 'ZCODE_CREDENTIAL' as never,
      resolveCredential,
      refresh: async () => {},
      product: ZCODE,
    })
    const result = await (adapter as unknown as {
      resolveCredentialOrThrow: (options: { model: string; sessionId: string }) => Promise<{
        credential: { zcode_jwt: string }
        accountId: string | undefined
      }>
    }).resolveCredentialOrThrow({ model: 'GLM-5.3-Flash', sessionId: 'session-xyz' })
    expect(result.credential.zcode_jwt).toBe('jwt')
    expect(result.accountId).toBe('zcode-a')
    expect(resolveCredential).toHaveBeenCalledWith('GLM-5.3-Flash', 'session-xyz', expect.anything())
  })

  it('switchAccountOnQuota 用 getAvailableAccountForSession 并带 sessionId', async () => {
    const sessionCalls: Array<{ sessionId: string | undefined; exclude: string[] }> = []
    const pool = {
      updateModelRateLimit: async () => {},
      getAvailableAccountForSession: async (
        _provider: string,
        _model: string,
        sessionId: string | undefined,
        exclude: ReadonlySet<string>,
      ) => {
        sessionCalls.push({ sessionId, exclude: [...exclude] })
        return { entry: { id: 'zcode-b' }, credential: { zcode_jwt: 'jwt-B', device_mid: 'mid-B' } }
      },
    }
    const adapter = new ZcodeAdapter({
      credentialRef: 'ZCODE_CREDENTIAL' as never,
      resolveCredential: async () => ({ zcode_jwt: 'jwt-A', device_mid: 'mid-A' }),
      refresh: async () => {},
      product: ZCODE,
      accountPool: pool as never,
    })
    const next = await (adapter as unknown as {
      switchAccountOnQuota: (
        options: { model: string; sessionId: string },
        tried: Set<string>,
        activeAccountId: string | undefined,
      ) => Promise<{ accountId: string } | undefined>
    }).switchAccountOnQuota({ model: 'GLM-5.3-Flash', sessionId: 'session-xyz' }, new Set(['zcode-a']), 'zcode-a')
    expect(next?.accountId).toBe('zcode-b')
    expect(sessionCalls).toEqual([{ sessionId: 'session-xyz', exclude: ['zcode-a'] }])
  })
})
