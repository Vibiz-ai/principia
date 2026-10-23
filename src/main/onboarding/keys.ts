/**
 * Onboarding key check and in-memory key stash (docs/ONBOARDING.md §8).
 *
 * A key the user pastes in S5 crosses renderer → main once (`onboarding:key check`). It is format-checked, optionally
 * checked against the provider with one free, read-only request, and held here in main memory until launch saves it to
 * the company namespace. Nothing in this module logs, journals, echoes or throws the value: every result and every error
 * carries metadata only (status, stash handle, last four characters, a fixed detail word). The only way to get a value
 * back out is `KeyStash.take`, which launch calls right before `secrets.set`.
 */
import { randomUUID } from 'node:crypto'
import { HiveError } from '../../shared/errors'
import { ONBOARDING_KEY_NAMES } from '../../shared/onboarding'
import type { KeyCheckResult, KeyCheckStatus, OnboardingKeyName } from '../../shared/onboarding'

export const KEY_CHECK_TIMEOUT_MS = 8_000
export const KEY_STASH_TTL_MS = 30 * 60_000
/** Upper bound on a pasted key; anything longer is not a provider key and is never sent anywhere. */
export const KEY_MAX_LENGTH = 512
/** At most this many live keys at once (one per provider is the norm); the oldest is wiped when a new one comes in. */
export const KEY_STASH_MAX_ENTRIES = 16

export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'
/** Authenticated status read of a request id that cannot exist. Costs nothing and starts no job. */
export const FAL_STATUS_URL = 'https://queue.fal.run/fal-ai/flux/dev/requests/00000000-0000-0000-0000-000000000000/status'

/**
 * Whether the fal network check runs. The §8 target mapping (401/403 invalid, 400/404/422 valid) has not been confirmed
 * against recorded live responses, so the shipped fal check is "format check, then unknown" with no request made.
 * To turn it on: record the valid / revoked / no-key responses as fixtures in keys.test.ts, flip this, update §8.
 */
export const FAL_NETWORK_CHECK = false

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** Fixed detail words. `offline` means the request failed or timed out; the renderer keys its wording off it. */
export type KeyCheckDetail = 'offline' | 'format' | 'no-check'
export interface KeyCheckOutcome {
  status: KeyCheckStatus
  detail?: KeyCheckDetail
}

export function isOnboardingKeyName(name: unknown): name is OnboardingKeyName {
  return typeof name === 'string' && (ONBOARDING_KEY_NAMES as readonly string[]).includes(name)
}

// Printable ASCII only: a header value outside Latin-1 makes fetch throw before any request, which would otherwise be
// misreported as "offline". Real fal and OpenAI keys are plain ASCII.
const FAL_FORMAT = /^[\x21-\x7e]{20,}$/
const OPENAI_FORMAT = /^sk-[\x21-\x7e]{17,}$/

/** Pasted keys often carry a trailing newline or surrounding spaces; strip those before anything else. */
export function normalizeKey(value: string): string {
  return typeof value === 'string' ? value.trim() : value
}

/** §8 format check: fal is a non-space `key_id:secret`-like string of 20+ chars; OpenAI starts with `sk-`. */
export function keyFormatOk(name: OnboardingKeyName, value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > KEY_MAX_LENGTH) return false
  if (name === 'FAL_KEY') return FAL_FORMAT.test(value)
  if (name === 'OPENAI_API_KEY') return OPENAI_FORMAT.test(value)
  return false
}

/** Last four characters for display ("ends in 4f2a"). Empty for anything too short to show part of safely. */
export function keyLast4(value: string): string {
  return typeof value === 'string' && value.length >= 12 ? value.slice(-4) : ''
}

/** OpenAI `/v1/models`: 200 valid, 401 invalid, anything else unknown. */
export function mapOpenAiStatus(status: number): KeyCheckStatus {
  if (status === 200) return 'valid'
  if (status === 401) return 'invalid'
  return 'unknown'
}

/** fal target mapping (§8, not yet confirmed live): 401/403 invalid, 400/404/422 valid (authenticated, no such request). */
export function mapFalStatus(status: number): KeyCheckStatus {
  if (status === 401 || status === 403) return 'invalid'
  if (status === 400 || status === 404 || status === 422) return 'valid'
  return 'unknown'
}

export interface CheckKeyOptions {
  timeoutMs?: number
  /** Overrides FAL_NETWORK_CHECK (tests, and the eventual switch-on). */
  falNetwork?: boolean
  signal?: AbortSignal
}

/**
 * Check one key. Format first (no request for a malformed key), then at most one request with an 8 s timeout and no
 * retries. Never throws and never returns or mentions the value.
 */
export async function checkKey(
  name: OnboardingKeyName,
  value: string,
  fetchImpl: FetchLike = fetch,
  opts: CheckKeyOptions = {}
): Promise<KeyCheckOutcome> {
  value = normalizeKey(value)
  if (!isOnboardingKeyName(name) || !keyFormatOk(name, value)) return { status: 'invalid', detail: 'format' }
  const falNetwork = opts.falNetwork ?? FAL_NETWORK_CHECK
  if (name === 'FAL_KEY' && !falNetwork) return { status: 'unknown', detail: 'no-check' }

  const url = name === 'OPENAI_API_KEY' ? OPENAI_MODELS_URL : FAL_STATUS_URL
  const authorization = name === 'OPENAI_API_KEY' ? `Bearer ${value}` : `Key ${value}`
  const timeoutMs = opts.timeoutMs ?? KEY_CHECK_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let status: number
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    const request = Promise.resolve().then(() =>
      fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
        redirect: 'manual',
        cache: 'no-store',
        signal
      })
    )
    request.catch(() => undefined)
    // Hard deadline even if the fetch implementation ignores the abort signal: the check can never hang the step.
    const deadline = new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      guard.unref?.()
    })
    const res = await Promise.race([request, deadline])
    status = res.status
    void res.body?.cancel().catch(() => undefined)
  } catch {
    // Network failure, DNS, TLS or timeout. The error is dropped on purpose: it could quote the request.
    return { status: 'unknown', detail: 'offline' }
  } finally {
    if (guard) clearTimeout(guard)
  }
  return { status: name === 'OPENAI_API_KEY' ? mapOpenAiStatus(status) : mapFalStatus(status) }
}

interface StashEntry {
  name: OnboardingKeyName
  value: string
  last4: string
  expires: number
  timer?: ReturnType<typeof setTimeout>
}

export interface StashMeta {
  stashId: string
  name: OnboardingKeyName
  last4: string
  expiresAt: number
}

export interface KeyStashOptions {
  ttlMs?: number
  now?: () => number
  newId?: () => string
}

/**
 * Main-memory key stash: `stashId → {name, value, expires}`, 30 min TTL. Wiped on take (launch), forget, clear (window
 * close and quit) and expiry. Entries live in a private field, so inspecting, logging or serializing the stash shows a
 * count only.
 */
export class KeyStash {
  readonly #entries = new Map<string, StashEntry>()
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #newId: () => string

  constructor(opts: KeyStashOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? KEY_STASH_TTL_MS
    this.#now = opts.now ?? Date.now
    this.#newId = opts.newId ?? randomUUID
  }

  stash(name: OnboardingKeyName, value: string): { stashId: string; last4: string } {
    if (!isOnboardingKeyName(name)) throw new HiveError('bad_request', 'Unknown key name')
    if (typeof value !== 'string' || value.length === 0 || value.length > KEY_MAX_LENGTH) {
      throw new HiveError('bad_request', 'That does not look like a key')
    }
    this.#prune()
    while (this.#entries.size >= KEY_STASH_MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#drop(oldest)
    }
    const stashId = this.#newId()
    const last4 = keyLast4(value)
    const entry: StashEntry = { name, value, last4, expires: this.#now() + this.#ttlMs }
    // Belt and braces for the lazy expiry: wipe even if nothing touches the stash again. unref so it never holds the app open.
    const timer = setTimeout(() => this.#drop(stashId), this.#ttlMs)
    timer.unref?.()
    entry.timer = timer
    this.#entries.set(stashId, entry)
    return { stashId, last4 }
  }

  /** Metadata of a live entry (preflight "stashIds alive"), never the value. */
  peek(stashId: string): StashMeta | null {
    const e = this.#live(stashId)
    return e ? { stashId, name: e.name, last4: e.last4, expiresAt: e.expires } : null
  }

  has(stashId: string): boolean {
    return this.#live(stashId) !== null
  }

  /** Removes and returns the key. Launch only, immediately before saving it to the company namespace. */
  take(stashId: string): { name: OnboardingKeyName; value: string } | null {
    const e = this.#live(stashId)
    if (!e) return null
    const out = { name: e.name, value: e.value }
    this.#drop(stashId)
    return out
  }

  forget(stashIds: Iterable<string>): void {
    for (const id of stashIds) this.#drop(id)
  }

  clear(): void {
    for (const id of [...this.#entries.keys()]) this.#drop(id)
  }

  get size(): number {
    this.#prune()
    return this.#entries.size
  }

  toJSON(): { size: number } {
    return { size: this.size }
  }

  toString(): string {
    return `KeyStash(${this.size})`
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString()
  }

  #live(stashId: string): StashEntry | null {
    if (typeof stashId !== 'string') return null
    const e = this.#entries.get(stashId)
    if (!e) return null
    if (this.#now() >= e.expires) {
      this.#drop(stashId)
      return null
    }
    return e
  }

  #drop(stashId: string): void {
    const e = this.#entries.get(stashId)
    if (!e) return
    if (e.timer) clearTimeout(e.timer)
    e.value = ''
    this.#entries.delete(stashId)
  }

  #prune(): void {
    const now = this.#now()
    for (const [id, e] of this.#entries) if (now >= e.expires) this.#drop(id)
  }
}

/** The app's one stash. The onboarding handler checks into it, launch takes from it, window close and quit clear it. */
export const keyStash = new KeyStash()

/**
 * `onboarding:key {op:'check'}`: check, then stash on valid or unknown (§8). `invalid` keeps nothing and returns an empty
 * stashId and last4. The result is metadata only.
 */
export async function checkAndStash(
  name: OnboardingKeyName,
  value: string,
  opts: { stash?: KeyStash; fetchImpl?: FetchLike } & CheckKeyOptions = {}
): Promise<KeyCheckResult> {
  const { stash = keyStash, fetchImpl = fetch, ...checkOpts } = opts
  value = normalizeKey(value)
  const outcome = await checkKey(name, value, fetchImpl, checkOpts)
  if (outcome.status === 'invalid') return { status: 'invalid', stashId: '', last4: '', ...(outcome.detail ? { detail: outcome.detail } : {}) }
  const { stashId, last4 } = stash.stash(name, value)
  return { status: outcome.status, stashId, last4, ...(outcome.detail ? { detail: outcome.detail } : {}) }
}
