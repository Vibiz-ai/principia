import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createWrappedDek, openVault, parseMasterKey, secretParts } from '../vault'
import { createLogger, createRedactor } from '../log'

describe('vault (CLOUD.md §7.3)', () => {
  const kek = randomBytes(32)
  const dek = createWrappedDek(kek, 'ws_a')

  it('round-trips with AAD bound to workspace, kind and id', () => {
    const v = openVault(kek, 'ws_a', dek)
    const blob = v.encrypt('provider', 'cred_1', 'sk-ant-oat01-secret-value-123')
    expect(blob).not.toContain('secret')
    expect(v.decrypt('provider', 'cred_1', blob)).toBe('sk-ant-oat01-secret-value-123')
    expect(() => v.decrypt('provider', 'cred_2', blob)).toThrow()
    expect(() => v.decrypt('company-secret', 'cred_1', blob)).toThrow()
  })

  it('refuses a row moved to another workspace even under the same KEK', () => {
    const a = openVault(kek, 'ws_a', dek)
    const blob = a.encrypt('provider', 'cred_1', 'value-value-value')
    const otherDek = createWrappedDek(kek, 'ws_b')
    const b = openVault(kek, 'ws_b', otherDek)
    expect(() => b.decrypt('provider', 'cred_1', blob)).toThrow()
    // the wrapped DEK itself is bound to its workspace
    expect(() => openVault(kek, 'ws_b', dek)).toThrow(/does not open/)
  })

  it('detects tampering of iv, tag or ciphertext', () => {
    const v = openVault(kek, 'ws_a', dek)
    const blob = Buffer.from(v.encrypt('repo-pat', 'r', 'github_pat_abcdefghijklmnopqrstuvwxyz'), 'base64')
    for (const i of [0, 13, blob.length - 1]) {
      const t = Buffer.from(blob); t[i] = t[i]! ^ 1
      expect(() => v.decrypt('repo-pat', 'r', t.toString('base64'))).toThrow()
    }
    expect(() => v.decrypt('repo-pat', 'r', 'AAAA')).toThrow()
  })

  it('fails with a wrong master key and rewraps under a new one', () => {
    expect(() => openVault(randomBytes(32), 'ws_a', dek)).toThrow(/PRINCIPIA_MASTER_KEY/)
    const v = openVault(kek, 'ws_a', dek)
    const blob = v.encrypt('provider', 'c', 'some-secret-value')
    const kek2 = randomBytes(32)
    const v2 = openVault(kek2, 'ws_a', v.rewrap(kek2))
    expect(v2.decrypt('provider', 'c', blob)).toBe('some-secret-value')
  })

  it('validates the master key format', () => {
    expect(() => parseMasterKey(undefined)).toThrow()
    expect(() => parseMasterKey('abc')).toThrow()
    expect(parseMasterKey('a'.repeat(64)).length).toBe(32)
  })

  it('tracks known secrets, including long JSON leaves of file credentials', () => {
    const v = openVault(kek, 'ws_a', dek)
    v.encrypt('provider', 'x', JSON.stringify({ tokens: { access_token: 'eyJ-access-token-long-value', refresh_token: 'rt-refresh-token-0123456789' }, last_refresh: 'x' }))
    expect(v.knownSecrets()).toContain('eyJ-access-token-long-value')
    expect(v.knownSecrets()).toContain('rt-refresh-token-0123456789')
    expect(secretParts('short')).toEqual([])
    const parts = secretParts(JSON.stringify({ token_endpoint: 'https://auth.example.com/token', grant_types_supported: ['authorization_code'], last_refresh: '2026-10-21T09:00:00.000Z', client_secret: 'cs_secret_value', private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n' }))
    expect(parts).toContain('cs_secret_value')
    expect(parts).toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC')
    for (const no of ['https://auth.example.com/token', 'authorization_code', '2026-10-21T09:00:00.000Z']) expect(parts).not.toContain(no)
    expect(secretParts(JSON.stringify({ Authorization: 'Bearer abcdefgh12345678' }))).toContain('abcdefgh12345678')
  })
})

describe('logging and redaction', () => {
  it('redacts known secrets and token shapes in every line', () => {
    const lines: string[] = []
    const redact = createRedactor(() => ['my-known-secret-value'])
    const log = createLogger(redact, l => lines.push(l))
    log.info('x', { a: 'my-known-secret-value', b: 'pdt_abcdefghijklmnop', c: 'sk-ant-oat01-abcdefghij', d: 'ghp_abcdefghijklmnopqrstuvwxyz', e: 'sk-proj-abcdefghijklmnopqrstu', f: 'opk_0123456789abcdef', g: 'whk_0123456789abcdef', h: 'pll_abcdefghijk', i: 'pss_abcdefghijk' })
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.level).toBe('info')
    for (const k of 'abcdefghi') expect(parsed[k]).toBe('[redacted]')
    log.plain('Connect link: http://x/pair#K7QM-4XWD (10 min)')
    expect(lines[1]).toBe('Connect link: http://x/pair#K7QM-4XWD (10 min)')
  })
})
