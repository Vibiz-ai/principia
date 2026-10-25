import { describe, expect, it } from 'vitest'
import { claudeCheckLine } from './model'

const at = '2026-10-25T00:00:00Z'
describe('five doors step 5: the real Claude check on the last setup steps (E12)', () => {
  it('signed in on a plan: nothing extra to pay, and names the plan only when Claude reports it', () => {
    expect(claudeCheckLine({ state: 'ok', method: 'claude.ai', plan: 'pro' })).toEqual({ ok: true, text: 'Runs on your Claude Pro plan. No extra charge from Principia. Claude is signed in on this Mac.' })
    expect(claudeCheckLine({ state: 'ok', method: 'claude.ai', plan: null }).text).toMatch(/^Runs on your Claude plan\./)
    expect(claudeCheckLine({ state: 'ok', method: 'api_key', plan: null }).text).toContain('Anthropic bills each use')
  })
  it('signed out or missing: sign in or get a plan, with what a plan costs; never a fake percentage', () => {
    const out = claudeCheckLine({ state: 'signedOut', method: null, plan: null })
    expect(out.ok).toBe(false)
    expect(out.text).toContain('Sign in to Claude, or get a plan')
    expect(out.text).toContain('$20 a month')
    expect(claudeCheckLine({ state: 'missing', method: null, plan: null }).text).toContain('isn’t installed')
    for (const s of ['ok', 'signedOut', 'missing', 'unknown'] as const) expect(claudeCheckLine({ state: s, method: null, plan: null }).text).not.toMatch(/\d+%/)
    void at
  })
  it('unknown and not checked yet never claim a state', () => {
    expect(claudeCheckLine(null)).toEqual({ ok: null, text: 'Checking Claude on this Mac…' })
    expect(claudeCheckLine({ state: 'unknown', method: null, plan: null }).ok).toBeNull()
  })
})
