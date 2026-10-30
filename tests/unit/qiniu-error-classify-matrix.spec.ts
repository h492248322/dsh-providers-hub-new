// ⚠️ 2026-10-31 对抗审计收编（原临时探针 zz-audit-m113-baseline）：
// classifyQiniuError 的**交叉形态矩阵** —— HTTP 状态码与响应体文案**不一致**时
// （429 带超限文案 / 401 带额度文案 / 502 带额度文案…）分类必须仍按文案语义走。
// 判定顺序「context_window 最先」正是 PR26 的承重判据（bafbdeb 修的
// 「落 httpErrorCode(400)=INVALID_REQUEST ⇒ 溢出压缩不跑」就坏在顺序上），
// 本矩阵锁死全部 12 格，任何人重排 classifyQiniuError 的判定顺序必红
// （对抗审计 M1/M1b 变异实测有牙）。纯函数调用、零网络。
import { describe, expect, it } from 'vitest'
import { classifyQiniuError } from '../../src/qiniu-product.js'

describe('classifyQiniuError 交叉形态矩阵（状态码×文案不一致时不翻转）', () => {
  it('基线矩阵', () => {
    const rows: Array<[string, { kind: string }, string]> = [
      ['A: 429 + maximum context length', classifyQiniuError(429, '{"error":{"message":"This model\'s maximum context length is 40960 tokens"}}'), 'context_window'],
      ['A2: 429 + context_length_exceeded', classifyQiniuError(429, '{"error":{"message":"context_length_exceeded: reduce the length"}}'), 'context_window'],
      ['B: 401 + quota exhausted', classifyQiniuError(401, '{"error":{"message":"quota exhausted, please top up"}}'), 'quota'],
      ['B2: 403 + insufficient balance', classifyQiniuError(403, '{"error":{"message":"insufficient balance"}}'), 'quota'],
      ['C: 400 + too many tokens', classifyQiniuError(400, '{"error":{"message":"you sent too many tokens"}}'), 'context_window'],
      ['C2: 400 + input tokens exceed', classifyQiniuError(400, '{"error":{"message":"input tokens exceed the maximum"}}'), 'context_window'],
      ['D: 502 + insufficient quota', classifyQiniuError(502, 'upstream insufficient quota'), 'quota'],
      ['E: 429 plain rate limit', classifyQiniuError(429, '{"error":{"message":"Too Many Requests"}}'), 'rate_limit'],
      ['F: 401 invalid api key', classifyQiniuError(401, '{"error":{"message":"invalid api key"}}'), 'auth'],
      ['G: 400 invalid parameter', classifyQiniuError(400, '{"error":{"message":"invalid parameter"}}'), 'invalid_request'],
      ['H: 402 balance not enough', classifyQiniuError(402, '{"error":{"message":"balance not enough"}}'), 'quota'],
      ['I: 401 + rate limit wording', classifyQiniuError(401, '{"error":{"message":"rate limit reached"}}'), 'rate_limit'],
    ]
    const flips = rows.filter(([, actual, expected]) => actual.kind !== expected)
    // 基线：只记录、不判死 —— 变异实验用它对照。
    expect(flips.map(([n, a, e]) => `${n}: got=${a.kind} want=${e}`)).toEqual([])
  })
})
