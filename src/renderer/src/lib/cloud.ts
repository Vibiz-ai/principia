/**
 * Principia Cloud pane: pure view models (docs/CLOUD.md §13.1). No React, no window. Plain copy for keys, money and
 * permissions (VOICE.md §2); the pane adds flavour only to its headline.
 */
import { SUBSCRIPTION_KINDS, isPublicHttpsUrl, knownKey, type CloudAdapter, type CloudAsk, type CloudFix, type CloudPassportLink, type CloudRunStatus, type CloudRunSummary, type ProviderAccount, type ProviderCredentialKind, type WorkspaceSummary } from '@shared/cloud'
import type { CloudLinkState, CloudLoginStatus, CloudMoveChoices, CloudMovePlan } from '@shared/types'

// ---------- status tesserae ----------

export type Tessera = 'ok' | 'needs' | 'fail' | 'running' | 'q'
const TESSERA: Record<CloudRunStatus, Tessera> = { passed: 'ok', needs_input: 'needs', failed: 'fail', running: 'running', queued: 'q', canceled: 'q' }
export const runTessera = (s: CloudRunStatus | string): Tessera => TESSERA[s as CloudRunStatus] ?? 'q'
export const stepTessera = (s: string): Tessera => (s === 'skipped' ? 'q' : runTessera(s))

// ---------- accounts ----------

export const ADAPTER_LABEL: Record<CloudAdapter, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }

export type BillingBadge = 'Subscription' | 'API billing'
/** Every connected account says how it bills: the user's own plan, or per token. */
export function billingBadge(kind: ProviderCredentialKind | null | undefined): BillingBadge | null {
  if (!kind) return null
  return SUBSCRIPTION_KINDS.includes(kind) ? 'Subscription' : 'API billing'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "expires Oct 2027", "expired", or null when the credential has no fixed end (ChatGPT sign-ins refresh). */
export function expiryLabel(iso: string | null | undefined, now = new Date()): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  if (d.getTime() <= now.getTime()) return 'expired'
  return `expires ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

const hhmm = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface AccountRow {
  adapter: CloudAdapter
  name: string
  /** one line under the name */
  line: string
  badge: BillingBadge | null
  status: { tone: 'ok' | 'warn' | 'err' | 'off'; label: string }
  primary: { kind: 'connectClaude' | 'signInChatGPT' | 'addKey' | 'test'; label: string }
}

export function accountRow(a: ProviderAccount, now = new Date()): AccountRow {
  const name = ADAPTER_LABEL[a.adapter]
  const badge = billingBadge(a.credential?.kind)
  const connect: AccountRow['primary'] =
    a.adapter === 'claude' ? { kind: 'connectClaude', label: 'Connect Claude' } : a.adapter === 'codex' ? { kind: 'signInChatGPT', label: 'Sign in with ChatGPT' } : { kind: 'addKey', label: 'Add key' }
  if (!a.credential || a.status === 'missing') return { adapter: a.adapter, name, line: 'Not connected', badge: null, status: { tone: 'off', label: 'Off' }, primary: connect }
  const exp = expiryLabel(a.credential.expiresAt, now)
  if (a.status === 'expired') return { adapter: a.adapter, name, line: a.detail ?? 'The sign-in expired', badge, status: { tone: 'err', label: 'Expired' }, primary: connect }
  if (a.status === 'failing') {
    const out = a.adapter === 'codex' && a.credential.kind === 'codex_auth_json'
    return { adapter: a.adapter, name, line: out && a.credential.lastUsedAt ? `Signed out at ${hhmm(a.credential.lastUsedAt)}` : (a.detail ?? 'The last test failed'), badge, status: { tone: 'err', label: out ? 'Signed out' : 'Failing' }, primary: connect }
  }
  const line = ['Connected', exp].filter(Boolean).join(' · ')
  return { adapter: a.adapter, name, line, badge, status: a.status === 'expiring' ? { tone: 'warn', label: 'Expiring' } : { tone: 'ok', label: 'OK' }, primary: { kind: 'test', label: 'Test' } }
}

/** What "Use an API key instead" pastes, per adapter (Gemini's primary is already a key). */
export const API_KEY_KIND: Record<CloudAdapter, ProviderCredentialKind> = { claude: 'anthropic_api_key', codex: 'openai_api_key', gemini: 'gemini_api_key' }
/** What "Paste a token" pastes. */
export const PASTE_KIND: Record<CloudAdapter, ProviderCredentialKind> = { claude: 'claude_oauth_token', codex: 'openai_api_key', gemini: 'gemini_api_key' }

/** A pasted value's shape, before it leaves for the cloud (never echoed back). */
export function pasteProblem(kind: ProviderCredentialKind, value: string): string | null {
  const v = value.trim()
  if (!v) return 'Paste a key or token.'
  if (kind === 'claude_oauth_token' && !/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(v)) return 'That is not a Claude token. It starts with sk-ant-oat01-.'
  if (kind === 'anthropic_api_key' && !/^sk-ant-api\d\d-[A-Za-z0-9_-]{20,}$/.test(v)) return 'That is not an Anthropic API key. It starts with sk-ant-api.'
  if (kind === 'openai_api_key' && !/^sk-[A-Za-z0-9_-]{20,}$/.test(v)) return 'That is not an OpenAI API key. It starts with sk-.'
  if (kind === 'google_service_account') {
    try {
      const j = JSON.parse(v) as { type?: string; private_key?: string }
      if (j.type !== 'service_account' || !j.private_key) return 'That is not a service account JSON file.'
    } catch {
      return 'That is not a service account JSON file.'
    }
  }
  return null
}

/** The row under an account while Connect Claude / Sign in with ChatGPT runs on this Mac. */
export function loginLine(l: CloudLoginStatus | null, adapter: CloudAdapter): { busy: boolean; text: string; failed: boolean } | null {
  if (!l || l.adapter !== adapter) return null
  const busy = l.phase === 'starting' || l.phase === 'waiting' || l.phase === 'uploading' || l.phase === 'testing'
  if (l.phase === 'done' || l.phase === 'canceled') return null
  return { busy, text: l.message ?? '', failed: l.phase === 'failed' }
}

// ---------- header, setup strip ----------

export function statusLine(s: Pick<CloudLinkState, 'online' | 'offlineSince'>): { tone: 'ok' | 'err'; label: string } {
  if (s.online) return { tone: 'ok', label: 'Online' }
  return { tone: 'err', label: s.offlineSince ? `Offline since ${hhmm(s.offlineSince)}` : 'Offline' }
}
export const usageLine = (u: WorkspaceSummary['usage24h'] | null | undefined): string | null => (u ? `24 h · ${u.runs} run${u.runs === 1 ? '' : 's'} · ${Math.round(u.runMinutes)} min` : null)

export interface SetupStep {
  key: 'claude' | 'codex' | 'company'
  label: string
  state: 'done' | 'running' | 'todo'
}
/** The three-step strip under the header; null once all three are done (it disappears). */
export function setupSteps(summary: Pick<WorkspaceSummary, 'providers' | 'companies'> | null, login: CloudLoginStatus | null): SetupStep[] | null {
  if (!summary) return null
  const linked = (a: CloudAdapter) => summary.providers.some((p) => p.adapter === a && p.credential && (p.status === 'ok' || p.status === 'expiring'))
  const busy = (a: 'claude' | 'codex') => !!login && login.adapter === a && ['starting', 'waiting', 'uploading', 'testing'].includes(login.phase)
  const steps: SetupStep[] = [
    { key: 'claude', label: 'Connect Claude', state: linked('claude') ? 'done' : busy('claude') ? 'running' : 'todo' },
    { key: 'codex', label: 'Sign in with ChatGPT', state: linked('codex') ? 'done' : busy('codex') ? 'running' : 'todo' },
    { key: 'company', label: 'Run a company in the cloud', state: summary.companies.length ? 'done' : 'todo' }
  ]
  return steps.every((s) => s.state === 'done') ? null : steps
}

// ---------- companies, readiness ----------

export interface FixAction {
  label: string
  kind: 'connectClaude' | 'signInChatGPT' | 'addKey' | 'manage' | 'copyKey' | 'authorize' | 'repoToken' | 'none'
}
/** CLOUD.md §7.9: the desktop maps each fix kind to its one-click action. */
export function fixAction(f: CloudFix): FixAction {
  switch (f.kind) {
    case 'account':
      // a usage limit resets on its own: nothing to click
      if (f.action === 'wait') return { label: '', kind: 'none' }
      return f.ref === 'claude' ? { label: 'Connect Claude', kind: 'connectClaude' } : f.ref === 'codex' ? { label: 'Sign in with ChatGPT', kind: 'signInChatGPT' } : { label: 'Add key', kind: 'addKey' }
    case 'key':
      return { label: `Copy ${f.ref}`, kind: 'copyKey' }
    case 'connection':
      return { label: 'Authorize', kind: 'authorize' }
    case 'repo':
      return { label: 'Add a token', kind: 'repoToken' }
    case 'workflow':
      return { label: 'Manage', kind: 'manage' }
    default:
      return { label: 'Retry', kind: 'none' }
  }
}

export function readinessLabel(r: { ready: boolean; fixes: CloudFix[] } | undefined): { tone: Tessera; label: string } {
  if (!r) return { tone: 'q', label: 'Checking…' }
  if (r.ready) return { tone: 'ok', label: 'Ready' }
  return { tone: 'fail', label: `${r.fixes.length} fix${r.fixes.length === 1 ? '' : 'es'}` }
}

// ---------- the move checklist (CLOUD.md §3 step 5) ----------

export interface Checklist {
  workflows: string[]
  schedules: string[]
  repos: Record<string, { on: boolean; token: string }>
  keys: string[]
  connections: string[]
}

/** Initial ticks: every runnable workflow, the schedules already in the cloud (or all runnable on a first move), every GitHub repo, and every key and connection those workflows use. */
export function initChecklist(plan: CloudMovePlan): Checklist {
  const wfs = plan.workflows.filter((w) => w.ok).map((w) => w.id)
  const scheduled = plan.schedules.filter((s) => s.ok)
  return {
    workflows: wfs,
    schedules: (plan.inCloud ? scheduled.filter((s) => s.placement === 'cloud') : scheduled).map((s) => s.id),
    repos: Object.fromEntries(plan.repos.filter((r) => r.ok).map((r) => [r.id, { on: true, token: '' }])),
    keys: plan.needs.keys.map((k) => k.name),
    connections: plan.needs.connections.map((c) => c.id)
  }
}

export type ChecklistAction =
  | { type: 'workflow' | 'schedule' | 'key' | 'connection'; id: string; on: boolean }
  | { type: 'repo'; id: string; on: boolean }
  | { type: 'repoToken'; id: string; token: string }

const toggle = (list: string[], id: string, on: boolean): string[] => (on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id))

export function reduceChecklist(plan: CloudMovePlan, s: Checklist, a: ChecklistAction): Checklist {
  switch (a.type) {
    case 'workflow': {
      if (!plan.workflows.some((w) => w.id === a.id && w.ok)) return s
      const workflows = toggle(s.workflows, a.id, a.on)
      // a schedule cannot fire in the cloud without its workflow
      const schedules = a.on ? s.schedules : s.schedules.filter((sid) => plan.schedules.find((x) => x.id === sid)?.workflowId !== a.id)
      return { ...s, workflows, schedules }
    }
    case 'schedule': {
      const row = plan.schedules.find((x) => x.id === a.id)
      if (!row?.ok) return s
      const schedules = toggle(s.schedules, a.id, a.on)
      // ticking a schedule ticks its workflow
      const workflows = a.on && row.workflowId ? toggle(s.workflows, row.workflowId, true) : s.workflows
      return { ...s, schedules, workflows }
    }
    case 'key':
      return { ...s, keys: toggle(s.keys, a.id, a.on) }
    case 'connection':
      return { ...s, connections: toggle(s.connections, a.id, a.on) }
    case 'repo':
      return s.repos[a.id] ? { ...s, repos: { ...s.repos, [a.id]: { ...s.repos[a.id], on: a.on } } } : s
    case 'repoToken':
      return s.repos[a.id] ? { ...s, repos: { ...s.repos, [a.id]: { ...s.repos[a.id], token: a.token } } } : s
  }
}

/** "What these workflows need": only what the ticked workflows use. Unused secrets are never shown. */
export function visibleNeeds(plan: CloudMovePlan, s: Checklist): { keys: string[]; connections: { id: string; name: string }[]; oauth: { id: string; name: string }[] } {
  const used = (by: string[]) => by.some((w) => s.workflows.includes(w))
  return {
    keys: plan.needs.keys.filter((k) => used(k.usedBy)).map((k) => k.name),
    connections: plan.needs.connections.filter((c) => used(c.usedBy)).map(({ id, name }) => ({ id, name })),
    oauth: plan.oauth.filter((c) => used(c.usedBy)).map(({ id, name }) => ({ id, name }))
  }
}

/** The IPC request: only ticked items that are still visible; repo tokens trimmed (null = none typed). */
export function toChoices(plan: CloudMovePlan, s: Checklist, overwrite?: string[]): CloudMoveChoices {
  const needs = visibleNeeds(plan, s)
  return {
    companyId: plan.companyId,
    workflows: s.workflows.filter((id) => plan.workflows.some((w) => w.id === id && w.ok)),
    schedules: s.schedules.filter((id) => plan.schedules.some((x) => x.id === id && x.ok)),
    repos: Object.entries(s.repos)
      .filter(([, r]) => r.on)
      .map(([id, r]) => ({ id, token: r.token.trim() || null })),
    keys: s.keys.filter((k) => needs.keys.includes(k)),
    connections: s.connections.filter((c) => needs.connections.some((x) => x.id === c)),
    ...(overwrite?.length ? { overwrite } : {})
  }
}

/** "fal.ai key (FAL_KEY)", or the name alone when it is not a well-known one. */
export const keyLabel = (name: string): string => {
  const k = knownKey(name)
  return k ? `${k} (${name})` : name
}

/** "used by Quest content", "used by Morning brief and 2 more": which ticked workflows need it. */
export function usedByLine(usedBy: string[], workflows: { id: string; name: string }[]): string {
  const names = usedBy.map((id) => workflows.find((w) => w.id === id)?.name).filter((n): n is string => !!n)
  if (!names.length) return ''
  return `used by ${names.length <= 2 ? andList(names) : `${names[0]} and ${names.length - 1} more`}`
}

/**
 * The Passport line on a company row, in words (revisions only on hover): "Passport · 3 new facts" or
 * "Passport · in sync". `title` keeps the revision for whoever wants it.
 */
export function passportLine(p: Pick<CloudPassportLink, 'revision' | 'pendingProposals'> | null | undefined): { text: string; title: string | undefined } {
  if (!p) return { text: 'No passport yet', title: undefined }
  const n = p.pendingProposals ?? 0
  return { text: n > 0 ? `Passport · ${n} new ${n === 1 ? 'fact' : 'facts'}` : 'Passport · in sync', title: p.revision ? `Passport revision ${p.revision}` : undefined }
}

/**
 * "Copy Passport URL for ChatGPT and Claude" (CLOUD.md §7.1): ChatGPT and Claude.ai connect only to a public https
 * origin, so a local address is never copied. The message says why, and the fix.
 */
export function passportCopy(p: Pick<CloudPassportLink, 'mcpUrl'> | null | undefined): { ok: true; url: string } | { ok: false; message: string; detail: string } {
  if (p?.mcpUrl && isPublicHttpsUrl(p.mcpUrl)) return { ok: true, url: p.mcpUrl }
  return {
    ok: false,
    message: 'ChatGPT and Claude.ai need a public HTTPS address',
    detail: `Your Passport is at ${p?.mcpUrl ? new URL(p.mcpUrl).origin : 'an address'} that only your own machines reach. Give your cloud two domains and start it with the caddy profile, or deploy it on Render with one button. Your cloud agents already use the Passport either way.`
  }
}

/** Where a founder starts a cloud (CLOUD.md §12.1): one hosted button, or one file on their own machine. */
export const RENDER_DEPLOY_URL = 'https://render.com/deploy?repo=https://github.com/Vibiz-ai/principia'
export const CLOUD_SETUP_URL = 'https://github.com/Vibiz-ai/principia/blob/main/cloud/README.md'
export const PUBLIC_HTTPS_URL = 'https://github.com/Vibiz-ai/principia/blob/main/cloud/README.md#public-https'
export const COMPOSE_COMMANDS = 'curl -fsSL https://raw.githubusercontent.com/Vibiz-ai/principia/main/cloud/compose.yml -o compose.yml\ndocker compose up -d'

/** "FAL_KEY and FIRECRAWL_API_KEY", "A, B and C". */
export function andList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "Create a token for owner/repo": GitHub's fine-grained token page. */
export const tokenLinkLabel = (ownerRepo: string | null): string => (ownerRepo ? `Create a token for ${ownerRepo}` : 'Create a token')

// ---------- needs you ----------

/** The answer a click or the free-text field sends. null = nothing to send (blank, or not an open ask). */
export function askAnswer(ask: Pick<CloudAsk, 'id' | 'status' | 'options'>, input: { option?: string; text?: string }): { id: string; answer: string } | null {
  if (ask.status !== 'open') return null
  if (input.option !== undefined) return ask.options.includes(input.option) ? { id: ask.id, answer: input.option } : null
  const t = (input.text ?? '').trim()
  return t ? { id: ask.id, answer: t.slice(0, 8000) } : null
}

/** "Marcus · Copywriter" -> name and role. */
export function agentParts(agentName: string | null): { name: string; role: string | null } {
  if (!agentName) return { name: 'An agent', role: null }
  const [name, ...rest] = agentName.split(' · ')
  return { name: name.trim() || 'An agent', role: rest.join(' · ').trim() || null }
}

export const openAsks = (asks: CloudAsk[]): CloudAsk[] => asks.filter((a) => a.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt))

// ---------- runs ----------

export function runTimeLabel(r: Pick<CloudRunSummary, 'status' | 'createdAt' | 'startedAt' | 'endedAt' | 'summary'>, now = new Date()): string {
  const at = r.startedAt ?? r.createdAt
  const d = new Date(at)
  const sameDay = d.toDateString() === now.toDateString()
  const when = sameDay ? hhmm(at) : now.getTime() - d.getTime() < 2 * 86_400_000 ? 'yesterday' : `${MONTHS[d.getMonth()]} ${d.getDate()}`
  if (r.status === 'needs_input') return `${when} · needs you`
  if (r.status === 'running') return `${when} · running`
  if (r.status === 'queued') return `${when} · queued`
  if (r.status === 'failed' && r.summary) return `${when} · ${r.summary.slice(0, 40)}`
  if (r.startedAt && r.endedAt && sameDay) {
    const mins = Math.max(1, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 60_000))
    return `${when} · ${mins} min`
  }
  return when
}

export const TRIGGER_LABEL: Record<string, string> = { manual: 'manual', schedule: 'schedule', webhook: 'webhook', desktop: 'run once', console: 'phone', answer: 'answer' }

/** The pane shows the last 8. */
export const recentRuns = (runs: CloudRunSummary[], n = 8): CloudRunSummary[] => [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, n)

/** Total pending passport facts across cloud companies (the "3 new facts" line and the badge). */
export const pendingFacts = (summary: Pick<WorkspaceSummary, 'companies'> | null): number => (summary?.companies ?? []).reduce((n, c) => n + (c.passport?.pendingProposals ?? 0), 0)
