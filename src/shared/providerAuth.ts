/**
 * Five doors E12: the real Claude check. Settings › AI providers (and anything that says "Runs on your Claude plan")
 * reads `claude auth status --json`; it never guesses. Wire types plus the one pure parser.
 */

/** ok: signed in; signedOut: the CLI answers, nobody is signed in; missing: no Claude Code on this Mac;
 * unknown: this Claude Code can't say (an older version without `claude auth status`, or it timed out). */
export type ClaudeAuthState = 'ok' | 'signedOut' | 'missing' | 'unknown'

export interface ClaudeAuthStatus {
  state: ClaudeAuthState
  /** 'claude.ai' (a Pro / Max / Team plan), 'api_key' / 'console' (pay per use), … as the CLI says it */
  method: string | null
  /** 'pro' | 'max' | 'team' | 'enterprise' …, only when the CLI reports it */
  plan: string | null
  checkedAt: string
}

/** What the plans cost, said where we ask someone to sign in (claude.com/pricing, checked 2026-10-25). */
export const CLAUDE_PLAN_PRICES = 'Claude Pro is $20 a month; Max starts at $100. Principia adds nothing on top.'

/** "Pro plan", "Max plan", or null when the CLI didn't say. */
export function claudePlanLabel(plan: string | null | undefined): string | null {
  const p = (plan ?? '').trim().toLowerCase()
  if (!p) return null
  return `${p.charAt(0).toUpperCase()}${p.slice(1)} plan`
}

/** True when the sign-in bills a subscription (agents use the plan), false for API-key billing, null when unknown. */
export function onPlan(s: Pick<ClaudeAuthStatus, 'state' | 'method'> | null | undefined): boolean | null {
  if (!s || s.state !== 'ok' || !s.method) return null
  return /claude\.ai|subscription|oauth/i.test(s.method)
}

/**
 * `claude auth status --json` (Claude Code 2.1+): `{ loggedIn, authMethod, subscriptionType, … }`. A non-JSON answer
 * with a non-zero exit means this version has no such command: unknown, never "signed out".
 */
export function parseClaudeAuth(r: { code: number | null; stdout: string; missing?: boolean; timedOut?: boolean }, now = new Date()): ClaudeAuthStatus {
  const at = now.toISOString()
  if (r.missing) return { state: 'missing', method: null, plan: null, checkedAt: at }
  let j: unknown = null
  try {
    const text = r.stdout.trim()
    const start = text.indexOf('{')
    j = start >= 0 ? JSON.parse(text.slice(start)) : null
  } catch {
    j = null
  }
  if (!j || typeof j !== 'object' || typeof (j as { loggedIn?: unknown }).loggedIn !== 'boolean') return { state: 'unknown', method: null, plan: null, checkedAt: at }
  const o = j as { loggedIn: boolean; authMethod?: unknown; subscriptionType?: unknown }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v !== 'none' ? v.trim().slice(0, 40) : null)
  return { state: o.loggedIn ? 'ok' : 'signedOut', method: o.loggedIn ? str(o.authMethod) : null, plan: o.loggedIn ? str(o.subscriptionType) : null, checkedAt: at }
}

/** PR-30, "Sign in to Claude" (`claude auth login`): started = the CLI waits on the browser (url: the page to open by
 * hand if it didn't open); done / failed / canceled are final. */
export interface ClaudeSignInStatus {
  phase: 'started' | 'done' | 'failed' | 'canceled'
  url: string | null
  message: string | null
}

/** A code from the claude.com sign-in page: letters, digits and a few URL-safe marks (it usually holds a '#'). */
export const SIGN_IN_CODE_RE = /^[A-Za-z0-9#_\-.~]{8,600}$/
