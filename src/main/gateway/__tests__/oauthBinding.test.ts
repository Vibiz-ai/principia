import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { GatewayService } from '../service'
import { OAuthConnection } from '../oauth'

describe('OAuth credential binding', () => {
  it('never sends resolved credentials to an old server after the connection URL changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-oauth-bind-'))
    let resolveHeaders!: (headers: Record<string, string>) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const headerSpy = vi.spyOn(OAuthConnection.prototype, 'headers').mockImplementation(() => { entered(); return new Promise(resolve => { resolveHeaders = resolve }) })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Must not send credentials'))
    const service = new GatewayService({ userData: dir, mainDir: dir, cipher: { available: () => true, encrypt: s => Buffer.from(s), decrypt: b => b.toString() }, vault: { addRedactions() {} }, baseEnv: () => ({}) })
    try {
      const connection = { id: 'company', name: 'Company', transport: 'http' as const, authentication: 'oauth' as const, enabled: true, roots: [dir], url: 'https://old.example.com/mcp' }
      service.save(connection)
      const pending = service.test('company')
      await started
      service.save({ ...connection, url: 'https://new.example.com/mcp' })
      resolveHeaders({ Authorization: 'Bearer replacement-account-token' })
      await expect(pending).rejects.toThrow('Connection changed')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally { service.close(); headerSpy.mockRestore(); fetchSpy.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
