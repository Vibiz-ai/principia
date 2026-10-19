import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager, type SessionDeps } from '../sessions'
import { codexAdapter } from '../engine/adapters'
import { profile } from '../engine/__tests__/fakes'
import type { Session } from '../../shared/types'

describe('session handoff', () => {
  it('carries redacted context, cwd and memory without resuming a foreign session or changing the source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-handoff-'))
    const source = { id: 'ses_old', adapter: 'claude', title: 'Fix bug', cwd: dir, artifactsDir: '/old/artifacts', cols: 120, rows: 32, agentSessionId: 'claude-conversation', status: 'exited' } as Session
    const mgr = new SessionManager({
      store: { getSession: () => source }, paths: { userData: dir },
      secrets: { redact: (s: string) => s.replaceAll('secret-value', '[redacted]') },
      memory: { lastMode: () => 'read-write' }
    } as unknown as SessionDeps)
    vi.spyOn(mgr, 'attach').mockReturnValue({ session: source, scrollback: '\x1b[31mChanged file.ts secret-value\x1b[0m' })
    const create = vi.spyOn(mgr, 'create').mockReturnValue({ ...source, id: 'ses_new', adapter: 'codex' })
    const result = mgr.handoff(source.id, 'codex', 'user: Fix the bug. Do not push. secret-value')
    const req = create.mock.calls[0][0]
    expect(result.adapter).toBe('codex')
    expect(req).toMatchObject({ adapter: 'codex', cwd: dir, memory: 'read-write', title: 'Fix bug' })
    expect(req.resumeAgentSessionId).toBeUndefined()
    const file = path.join(dir, 'handoffs', fs.readdirSync(path.join(dir, 'handoffs'))[0])
    const note = fs.readFileSync(file, 'utf8')
    expect(req.initialPrompt).toContain(file)
    expect(note).toContain('Do not push.')
    expect(note).toContain('Changed file.ts [redacted]')
    expect(note).not.toContain('secret-value')
    expect(note).not.toContain('\x1b')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(source.adapter).toBe('claude')
    expect(() => mgr.handoff(source.id, 'claude')).toThrow('different harness')
  })

  it('passes the handoff prompt as one final argument to interactive Codex', () => {
    const prompt = 'Read "/tmp/context file.txt" and continue.\nDo not push.'
    const invocation = codexAdapter.interactive({ profile: profile('p', 'codex'), initialPrompt: prompt, artifactsDir: '/tmp/artifacts', resumeId: null })
    expect(invocation.args.at(-1)).toBe(prompt)
    expect(invocation.args).toContain('--no-alt-screen')
  })
})
