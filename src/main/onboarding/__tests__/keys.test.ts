import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FAL_NETWORK_CHECK,
  FAL_STATUS_URL,
  KEY_CHECK_TIMEOUT_MS,
  KEY_STASH_MAX_ENTRIES,
  KEY_STASH_TTL_MS,
  KeyStash,
  OPENAI_MODELS_URL,
  checkAndStash,
  checkKey,
  keyFormatOk,
  keyLast4,
  mapFalStatus,
  type FetchLike
} from '../keys'

const OPENAI = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
const FAL = '1234abcd-12ab-34cd-56ef-1234567890ab:0123456789abcdef0123456789abcdef'

type Call = { url: string; init: RequestInit }
function fakeFetch(status: number | 'throw' | 'hang'): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init })
    if (status === 'throw') return Promise.reject(new TypeError(`fetch failed: ${url} ${JSON.stringify(init.headers)}`))
    if (status === 'hang') {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
      })
    }
    return Promise.resolve(new Response(JSON.stringify({ error: 'x' }), { status }))
  }
  return { fetchImpl, calls }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('format', () => {
  it('fal: non-space string of 20+ chars', () => {
    expect(keyFormatOk('FAL_KEY', FAL)).toBe(true)
    expect(keyFormatOk('FAL_KEY', 'short:key')).toBe(false)
    expect(keyFormatOk('FAL_KEY', 'has a space in the middle of it ok')).toBe(false)
    expect(keyFormatOk('FAL_KEY', '')).toBe(false)
    expect(keyFormatOk('FAL_KEY', 'x'.repeat(513))).toBe(false)
  })
  it('openai: sk- prefix', () => {
    expect(keyFormatOk('OPENAI_API_KEY', OPENAI)).toBe(true)
    expect(keyFormatOk('OPENAI_API_KEY', 'pk-abcdefghijklmnopqrstuvwxyz')).toBe(false)
    expect(keyFormatOk('OPENAI_API_KEY', 'sk-')).toBe(false)
    expect(keyFormatOk('OPENAI_API_KEY', 'sk-abc def ghi jkl mno pqr')).toBe(false)
  })
  it('last4 only for long enough values', () => {
    expect(keyLast4(OPENAI)).toBe('6789')
    expect(keyLast4('short')).toBe('')
  })
})

describe('checkKey: OpenAI', () => {
  it('200 → valid, one GET to /v1/models with Bearer, no redirects followed', async () => {
    const { fetchImpl, calls } = fakeFetch(200)
    expect(await checkKey('OPENAI_API_KEY', OPENAI, fetchImpl)).toEqual({ status: 'valid' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(OPENAI_MODELS_URL)
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.redirect).toBe('manual')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${OPENAI}`)
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })
  it('401 → invalid', async () => {
    expect(await checkKey('OPENAI_API_KEY', OPENAI, fakeFetch(401).fetchImpl)).toEqual({ status: 'invalid' })
  })
  it.each([404, 403, 429, 500, 302])('%i → unknown without offline detail', async (s) => {
    const r = await checkKey('OPENAI_API_KEY', OPENAI, fakeFetch(s).fetchImpl)
    expect(r.status).toBe('unknown')
    expect(r.detail).toBeUndefined()
  })
  it('network error → unknown/offline, no retry', async () => {
    const { fetchImpl, calls } = fakeFetch('throw')
    expect(await checkKey('OPENAI_API_KEY', OPENAI, fetchImpl)).toEqual({ status: 'unknown', detail: 'offline' })
    expect(calls).toHaveLength(1)
  })
  it('timeout → unknown/offline', async () => {
    const { fetchImpl, calls } = fakeFetch('hang')
    expect(await checkKey('OPENAI_API_KEY', OPENAI, fetchImpl, { timeoutMs: 20 })).toEqual({ status: 'unknown', detail: 'offline' })
    expect(calls).toHaveLength(1)
    expect(KEY_CHECK_TIMEOUT_MS).toBe(8_000)
  })
  it('bad format → invalid without any request', async () => {
    const { fetchImpl, calls } = fakeFetch(200)
    expect(await checkKey('OPENAI_API_KEY', 'nope', fetchImpl)).toEqual({ status: 'invalid', detail: 'format' })
    expect(calls).toHaveLength(0)
  })
})

describe('checkKey: fal', () => {
  // Fixture status: the live 404-vs-401 behaviour of FAL_STATUS_URL has not been recorded (no valid / revoked key
  // available to this build), so the shipped check is format-then-unknown (§8 open question). The mapping below is the
  // target, exercised only with the network check forced on.
  it('ships as format check then unknown, with no request', async () => {
    expect(FAL_NETWORK_CHECK).toBe(false)
    const { fetchImpl, calls } = fakeFetch(200)
    expect(await checkKey('FAL_KEY', FAL, fetchImpl)).toEqual({ status: 'unknown', detail: 'no-check' })
    expect(calls).toHaveLength(0)
    expect(await checkKey('FAL_KEY', 'bad', fetchImpl)).toEqual({ status: 'invalid', detail: 'format' })
  })
  it('target mapping when the network check is on', async () => {
    const { fetchImpl, calls } = fakeFetch(404)
    expect(await checkKey('FAL_KEY', FAL, fetchImpl, { falNetwork: true })).toEqual({ status: 'valid' })
    expect(calls[0]!.url).toBe(FAL_STATUS_URL)
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Key ${FAL}`)
    expect(await checkKey('FAL_KEY', FAL, fakeFetch(401).fetchImpl, { falNetwork: true })).toEqual({ status: 'invalid' })
    expect(await checkKey('FAL_KEY', FAL, fakeFetch(200).fetchImpl, { falNetwork: true })).toEqual({ status: 'unknown' })
    expect(await checkKey('FAL_KEY', FAL, fakeFetch('throw').fetchImpl, { falNetwork: true })).toEqual({ status: 'unknown', detail: 'offline' })
    expect([401, 403, 400, 404, 422, 500].map(mapFalStatus)).toEqual(['invalid', 'invalid', 'valid', 'valid', 'valid', 'unknown'])
  })
})

describe('KeyStash', () => {
  it('stash / peek / take removes the entry', () => {
    const s = new KeyStash()
    const { stashId, last4 } = s.stash('OPENAI_API_KEY', OPENAI)
    expect(last4).toBe('6789')
    expect(s.peek(stashId)).toMatchObject({ stashId, name: 'OPENAI_API_KEY', last4: '6789' })
    expect(s.take(stashId)).toEqual({ name: 'OPENAI_API_KEY', value: OPENAI })
    expect(s.take(stashId)).toBeNull()
    expect(s.has(stashId)).toBe(false)
  })
  it('ids are unique', () => {
    const s = new KeyStash()
    const a = s.stash('FAL_KEY', FAL).stashId
    const b = s.stash('FAL_KEY', FAL).stashId
    expect(a).not.toBe(b)
    expect(s.size).toBe(2)
  })
  it('expires after 30 minutes (lazy, injected clock)', () => {
    let t = 1_000
    const s = new KeyStash({ now: () => t })
    const { stashId } = s.stash('FAL_KEY', FAL)
    t += KEY_STASH_TTL_MS - 1
    expect(s.has(stashId)).toBe(true)
    t += 1
    expect(s.take(stashId)).toBeNull()
    expect(s.size).toBe(0)
    expect(KEY_STASH_TTL_MS).toBe(30 * 60_000)
  })
  it('expires by timer even if never touched', () => {
    vi.useFakeTimers()
    const s = new KeyStash()
    s.stash('FAL_KEY', FAL)
    vi.advanceTimersByTime(KEY_STASH_TTL_MS)
    expect(s.size).toBe(0)
  })
  it('forget and clear', () => {
    const s = new KeyStash()
    const a = s.stash('FAL_KEY', FAL).stashId
    const b = s.stash('OPENAI_API_KEY', OPENAI).stashId
    const c = s.stash('FAL_KEY', FAL).stashId
    s.forget([a, 'not-an-id'])
    expect(s.has(a)).toBe(false)
    expect(s.has(b)).toBe(true)
    s.clear()
    expect(s.has(b) || s.has(c)).toBe(false)
  })
  it('rejects bad input without echoing it', () => {
    const s = new KeyStash()
    expect(() => s.stash('NOPE' as never, OPENAI)).toThrow(/Unknown key name/)
    try {
      s.stash('FAL_KEY', 'x'.repeat(600))
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('xxxx')
    }
  })
})

describe('checkAndStash', () => {
  it('valid stashes and returns metadata', async () => {
    const stash = new KeyStash()
    const r = await checkAndStash('OPENAI_API_KEY', OPENAI, { stash, fetchImpl: fakeFetch(200).fetchImpl })
    expect(r).toMatchObject({ status: 'valid', last4: '6789' })
    expect(stash.take(r.stashId)?.value).toBe(OPENAI)
  })
  it('unknown stashes too (Use anyway)', async () => {
    const stash = new KeyStash()
    const r = await checkAndStash('FAL_KEY', FAL, { stash })
    expect(r.status).toBe('unknown')
    expect(stash.has(r.stashId)).toBe(true)
    const off = await checkAndStash('OPENAI_API_KEY', OPENAI, { stash, fetchImpl: fakeFetch('throw').fetchImpl })
    expect(off).toMatchObject({ status: 'unknown', detail: 'offline' })
    expect(stash.has(off.stashId)).toBe(true)
  })
  it('invalid keeps nothing', async () => {
    const stash = new KeyStash()
    const r = await checkAndStash('OPENAI_API_KEY', OPENAI, { stash, fetchImpl: fakeFetch(401).fetchImpl })
    expect(r).toEqual({ status: 'invalid', stashId: '', last4: '' })
    expect(stash.size).toBe(0)
  })
})

// --- Property: the value never appears in any returned object, thrown message, log call or stash serialization ---

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 0x100000000
  }
}
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_:.'
function randomKey(r: () => number, name: 'FAL_KEY' | 'OPENAI_API_KEY'): string {
  const len = 20 + Math.floor(r() * 80)
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHA[Math.floor(r() * ALPHA.length)]
  // Some malformed ones too (spaces, missing prefix, too long), to cover the error paths.
  const shape = r()
  if (shape < 0.1) s = s.slice(0, 8) + ' ' + s.slice(8)
  else if (shape < 0.15) s = s.repeat(10)
  return name === 'OPENAI_API_KEY' && r() < 0.85 ? `sk-${s}` : s
}
/** Everything but the last four chars, which are shown on purpose. */
const secretPart = (v: string): string => v.slice(0, -4)

describe('property: key value never leaks', () => {
  it('across statuses, network errors, stash ops and logging', async () => {
    const logged: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      })
    )
    try {
      const r = rng(0xc0ffee)
      const outcomes = [200, 400, 401, 403, 404, 422, 429, 500, 'throw', 'hang'] as const
      for (let i = 0; i < 200; i++) {
        const name = r() < 0.5 ? 'FAL_KEY' : 'OPENAI_API_KEY'
        const value = randomKey(r, name)
        const secret = secretPart(value)
        const outcome = outcomes[Math.floor(r() * outcomes.length)]!
        const stash = new KeyStash()
        const seen: string[] = []
        try {
          const res = await checkAndStash(name, value, {
            stash,
            fetchImpl: fakeFetch(outcome).fetchImpl,
            falNetwork: r() < 0.5,
            timeoutMs: 5
          })
          seen.push(JSON.stringify(res), String(res.last4).length <= 4 ? '' : 'last4 too long')
          if (res.stashId) {
            seen.push(JSON.stringify(stash.peek(res.stashId)))
          }
          seen.push(JSON.stringify(stash), String(stash), JSON.stringify({ stash }))
          const plain = await checkKey(name, value, fakeFetch(outcome).fetchImpl, { timeoutMs: 5 })
          seen.push(JSON.stringify(plain))
        } catch (e) {
          seen.push(String(e), JSON.stringify(e), (e as Error).stack ?? '')
        }
        try {
          stash.stash(name, value + ' '.repeat(600))
        } catch (e) {
          seen.push(String(e), JSON.stringify(e), (e as Error).stack ?? '')
        }
        for (const s of seen) expect(s.includes(secret), `leak in: ${s.slice(0, 80)}`).toBe(false)
        expect(seen.join('\n')).not.toContain('last4 too long')
      }
      for (const line of logged) expect(line).not.toMatch(/sk-|Bearer|Key /)
      expect(logged).toEqual([])
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })

  it('util.inspect of the stash shows a count only', async () => {
    const { inspect } = await import('node:util')
    const s = new KeyStash()
    s.stash('OPENAI_API_KEY', OPENAI)
    expect(inspect(s, { showHidden: true, depth: 10 })).not.toContain(secretPart(OPENAI))
    expect(Object.values(s).join('')).not.toContain(secretPart(OPENAI))
  })
})

describe('review hardening', () => {
  it('trims a pasted trailing newline / spaces and stashes the trimmed value', async () => {
    const stash = new KeyStash()
    const { fetchImpl, calls } = fakeFetch(200)
    const r = await checkAndStash('OPENAI_API_KEY', `  ${OPENAI}\n`, { stash, fetchImpl })
    expect(r.status).toBe('valid')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${OPENAI}`)
    expect(stash.take(r.stashId)?.value).toBe(OPENAI)
  })

  it('non-ASCII key is a format error, not "offline", and sends nothing', async () => {
    const { fetchImpl, calls } = fakeFetch(200)
    const r = await checkKey('OPENAI_API_KEY', 'sk-abcdefghijklmnopqrstuvw\u2014xyz', fetchImpl)
    expect(r).toEqual({ status: 'invalid', detail: 'format' })
    expect(calls).toHaveLength(0)
    expect(keyFormatOk('FAL_KEY', 'ключключключключключключ')).toBe(false)
  })

  it('a fetch that ignores the abort signal still times out', async () => {
    const fetchImpl: FetchLike = () => new Promise<Response>(() => undefined)
    const t0 = Date.now()
    const r = await checkKey('OPENAI_API_KEY', OPENAI, fetchImpl, { timeoutMs: 20 })
    expect(r).toEqual({ status: 'unknown', detail: 'offline' })
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('a fetch that throws synchronously is offline, not a crash', async () => {
    const fetchImpl: FetchLike = () => {
      throw new TypeError(`bad header Bearer ${OPENAI}`)
    }
    const r = await checkKey('OPENAI_API_KEY', OPENAI, fetchImpl)
    expect(r).toEqual({ status: 'unknown', detail: 'offline' })
  })

  it('stash is bounded: the oldest entry is wiped past the cap', () => {
    const stash = new KeyStash()
    const ids = Array.from({ length: KEY_STASH_MAX_ENTRIES + 3 }, () => stash.stash('FAL_KEY', FAL).stashId)
    expect(stash.size).toBe(KEY_STASH_MAX_ENTRIES)
    expect(stash.has(ids[0]!)).toBe(false)
    expect(stash.has(ids[2]!)).toBe(false)
    expect(stash.has(ids[3]!)).toBe(true)
    expect(stash.has(ids.at(-1)!)).toBe(true)
  })
})
