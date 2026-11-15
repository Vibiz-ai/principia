import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CloudLoginVault, LOGIN_VAULT_FILE } from '../loginVault'

const cipher = { available: () => true, encrypt: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`), decrypt: (b: Buffer) => Buffer.from(b.toString().slice(4), 'base64').toString() }

describe('cloud sign-ins kept on this Mac (docs/FLEET.md §9)', () => {
  it('keeps each sign-in encrypted in a 0600 file, gives it back, and forgets it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvault-'))
    const v = new CloudLoginVault({ userData: dir, cipher })
    expect(v.get('claude')).toBeNull()
    v.save('claude', 'claude_oauth_token' as never, 'sk-ant-oat01-SECRET')
    v.save('codex', 'codex_auth_json' as never, '{"tokens":{"refresh_token":"rt-SECRET"}}')
    const file = path.join(dir, LOGIN_VAULT_FILE)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/SECRET/)
    expect(new CloudLoginVault({ userData: dir, cipher }).get('claude')).toEqual({ kind: 'claude_oauth_token', value: 'sk-ant-oat01-SECRET' })
    expect(v.has('codex')).toBe(true)
    v.forget('codex')
    expect(v.has('codex')).toBe(false)
    expect(v.has('claude')).toBe(true)
  })

  it('keeps nothing when the Keychain can’t encrypt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvault-'))
    const v = new CloudLoginVault({ userData: dir, cipher: { ...cipher, available: () => false } })
    v.save('claude', 'claude_oauth_token' as never, 'x')
    expect(v.has('claude')).toBe(false)
  })
})
