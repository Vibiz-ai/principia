/**
 * providers.test and cliVersions (CLOUD.md §7.2). The test checks that the CLI runs (`--version`) and that the
 * credential is well formed; Codex also reads its own sign-in (`codex login status`, no model call). Only with `live`
 * (the user agreed to spend one tiny request on their plan) does it ask the model for one word. Every detail is a
 * plain, redacted sentence: the readiness list and the pane show it verbatim.
 */
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { AdapterId } from '../../../shared/types'
import type { CloudAdapter, ProviderTestResponse } from '../../../shared/cloud'
import type { ProviderMaterial } from '../../contract'
import { classifyLimitText } from '../../../main/engine/live/limits'
import { isHarnessAuthFailure } from '../../../main/engine/harnessFailure'
import { capture, type CaptureResult } from '../proc'
import { Redactor } from '../redact'
import type { ProcessSandbox } from '../sandbox'
import { claudeShapeProblem } from './claude'
import { codexShapeProblem } from './codex'
import { geminiShapeProblem } from './gemini'
import { materializeProviders } from './materialize'

export const CLI_LABEL: Record<CloudAdapter, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }
const TINY_PROMPT = 'Reply with the single word OK.'

export type Bins = Record<CloudAdapter | 'git', string>

export const firstVersion = (s: string): string | null => {
  const m = s.match(/\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.]+)?/)
  return m ? m[0] : null
}

/** Authentication failures in any of the three CLIs' words. */
const AUTH_RE =
  /\b401\b|unauthori[sz]ed|authentication[_ ]error|invalid[ _-](?:api[ _-]?key|x-api-key|bearer|token|authentication)|invalid_api_key|incorrect api key|token (?:has )?expired|oauth token has expired|not logged in|please (?:run )?(?:\/)?log ?in|login required|refresh token|api key not valid|permission_denied|could not load the default credentials/i

/** The founder-readable sentence for an authentication failure of this credential kind. */
export function authFailureDetail(m: Pick<ProviderMaterial, 'adapter' | 'kind'>): string {
  switch (m.kind) {
    case 'claude_oauth_token':
      return 'Claude token expired. Connect Claude again.'
    case 'anthropic_api_key':
      return 'Anthropic rejected the API key.'
    case 'codex_auth_json':
      return 'Codex is signed out. Sign in with ChatGPT again.'
    case 'openai_api_key':
      return 'OpenAI rejected the API key.'
    case 'codex_access_token':
      return 'Codex rejected the access token.'
    case 'gemini_api_key':
      return 'Google rejected the Gemini API key.'
    case 'google_service_account':
      return 'Google rejected the service account. Check that it has Vertex AI access.'
  }
}

/**
 * Maps a CLI's output to the test outcome. Pure (tests feed it text). `text` is stdout + stderr of the live call or
 * `codex login status`; `version` the CLI version for the success line.
 */
export function classifyProviderOutput(m: Pick<ProviderMaterial, 'adapter' | 'kind'>, r: Pick<CaptureResult, 'code' | 'timedOut' | 'error'> & { text: string }, version: string | null, now: Date, redact: (s: string) => string): ProviderTestResponse {
  const label = CLI_LABEL[m.adapter]
  const limit = classifyLimitText(r.text, now)
  if (limit) {
    const at = limit.resetAt ? new Date(limit.resetAt) : null
    const when = at && Number.isFinite(at.getTime()) ? ` It resets at ${at.toISOString().slice(11, 16)} UTC.` : ''
    return { ok: false, detail: `${label} hit its usage limit.${when}` }
  }
  if (AUTH_RE.test(r.text)) return { ok: false, detail: authFailureDetail(m) }
  if (r.timedOut) return { ok: false, detail: `${label} did not answer within a minute.` }
  if (r.error) return { ok: false, detail: `${label} could not start.` }
  if (r.code !== 0) {
    const line = redact(r.text).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? `exit code ${r.code}`
    return { ok: false, detail: `${label} failed: ${line.slice(0, 160)}` }
  }
  return { ok: true, detail: `${m.adapter} ${version ?? ''} · ${acceptedLine(m)}`.replace(/\s+·/, ' ·') }
}

/**
 * A failed agent step's error, in the founder's words, when the account is the cause (CLOUD.md §7.2, §10.1): an
 * expired or rejected credential, or a usage limit with its reset time. null = not an account problem (the run keeps
 * the engine's own reason). Only the CLI's own wording counts, never an agent's prose about a 401 in someone's code.
 */
export function runFailureDetail(m: Pick<ProviderMaterial, 'adapter' | 'kind'> | null, adapter: AdapterId, error: string | null, now: Date): string | null {
  return accountOutcome(m, adapter, error, now)?.detail ?? null
}

/**
 * The same classification as a status the control plane stores on the account (ports.providerStatus): 'limited' with
 * the reset time, or 'expired' for a sign-in or key the CLI rejected. null = the step failed for another reason.
 */
export function accountOutcome(m: Pick<ProviderMaterial, 'adapter' | 'kind'> | null, adapter: AdapterId, error: string | null, now: Date): { status: 'expired' | 'limited'; detail: string } | null {
  if (!error || !(adapter in CLI_LABEL)) return null
  const label = CLI_LABEL[adapter as CloudAdapter]
  const text = error.replace(/^Exited with code \S+: /, '')
  const limit = classifyLimitText(text, now)
  if (limit) {
    const at = limit.resetAt ? new Date(limit.resetAt) : null
    const when = at && Number.isFinite(at.getTime()) ? ` It resets at ${at.toISOString().slice(11, 16)} UTC.` : ''
    return { status: 'limited', detail: `${label} hit its usage limit.${when}` }
  }
  if (isHarnessAuthFailure(adapter, text)) return { status: 'expired', detail: m ? authFailureDetail(m) : `${label} rejected its account. Connect it again.` }
  return null
}

function acceptedLine(m: Pick<ProviderMaterial, 'kind'>): string {
  switch (m.kind) {
    case 'claude_oauth_token':
      return 'subscription token accepted'
    case 'anthropic_api_key':
      return 'API key accepted'
    case 'codex_auth_json':
      return 'signed in with ChatGPT'
    case 'openai_api_key':
      return 'API key accepted'
    case 'gemini_api_key':
      return 'API key accepted'
    case 'google_service_account':
      return 'service account accepted'
    default:
      return 'accepted'
  }
}

export function shapeProblem(m: ProviderMaterial): string | null {
  if (m.adapter === 'claude') return claudeShapeProblem(m)
  if (m.adapter === 'codex') return codexShapeProblem(m)
  if (m.adapter === 'gemini') return geminiShapeProblem(m)
  return 'Unknown account type.'
}

export function liveArgs(adapter: CloudAdapter): string[] {
  if (adapter === 'claude') return ['-p', TINY_PROMPT, '--output-format', 'json', '--max-turns', '1']
  if (adapter === 'codex') return ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', TINY_PROMPT]
  return ['-p', TINY_PROMPT, '-o', 'json']
}

export interface TestDeps {
  sandbox: ProcessSandbox
  bins: Bins
  now: () => Date
  redactor: Redactor
}

/** providers.test. Never throws; the material is written into a throwaway run home that is deleted after. */
export async function testProvider(m: ProviderMaterial, opts: { live: boolean }, d: TestDeps): Promise<ProviderTestResponse> {
  const label = CLI_LABEL[m.adapter] ?? 'This account'
  const redactor = new Redactor()
  redactor.add(m.value)
  const redact = (s: string) => redactor.redact(d.redactor.redact(s))
  const shape = shapeProblem(m)
  if (shape) return { ok: false, detail: shape }
  const box = d.sandbox.prepare(`ptest_${randomBytes(6).toString('hex')}`)
  try {
    const bin = d.bins[m.adapter]
    const base = d.sandbox.buildEnv(box)
    const v = await capture(bin, ['--version'], { env: base, cwd: box.home, timeoutMs: 15_000 })
    if (v.error || v.code !== 0) return { ok: false, detail: `${label} is not installed in this cloud.` }
    const version = firstVersion(v.stdout || v.stderr)
    let mat
    try {
      mat = materializeProviders(box, [m], [m.adapter], { codex: d.bins.codex })
    } catch (e) {
      return { ok: false, detail: redact(e instanceof Error ? e.message : String(e)) }
    }
    const env = d.sandbox.buildEnv(box, mat.env)
    try {
      await mat.before(env)
    } catch {
      return { ok: false, detail: authFailureDetail(m) }
    }
    if (m.adapter === 'codex') {
      const s = await capture(bin, ['login', 'status'], { env, cwd: box.home, timeoutMs: 15_000 })
      const text = `${s.stdout}\n${s.stderr}`
      if (s.code !== 0 || /not logged in|logged out/i.test(text)) return { ok: false, detail: authFailureDetail(m) }
    }
    if (!opts.live) return { ok: true, detail: `${m.adapter} ${version ?? ''} · ${acceptedLine(m).replace('accepted', 'saved')}${m.adapter === 'codex' ? '' : ' (not checked live)'}`.replace(/\s+·/, ' ·') }
    const r = await capture(bin, liveArgs(m.adapter), { env, cwd: box.home, timeoutMs: 60_000 })
    return classifyProviderOutput(m, { ...r, text: `${r.stdout}\n${r.stderr}` }, version, d.now(), redact)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
}

/** `--version` of each CLI (cached by the caller). */
export async function cliVersions(d: Pick<TestDeps, 'sandbox' | 'bins'>): Promise<Partial<Record<AdapterId, string>>> {
  const out: Partial<Record<AdapterId, string>> = {}
  await Promise.all(
    (['claude', 'codex', 'gemini'] as const).map(async (a) => {
      const r = await capture(d.bins[a], ['--version'], { env: d.sandbox.baseEnv(), cwd: d.sandbox.neutralHome, timeoutMs: 15_000 })
      const v = r.code === 0 ? firstVersion(r.stdout || r.stderr) : null
      if (v) out[a] = v
    })
  )
  return out
}
