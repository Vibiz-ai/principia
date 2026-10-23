/**
 * Readiness (CLOUD.md §7.9): can this company run unattended at 09:00? Computed from stored data only, never by running
 * an agent. Each fix is one plain founder sentence; the desktop maps `kind` to the one-click action.
 */
import { CLOUD_ADAPTERS, type CloudAdapter, type CloudFix, type ProviderStatus } from '../../shared/cloud'
import { ADAPTER_ACTION, ADAPTER_LABEL, type WorkflowDeps } from './deps'
import { knownKey } from '../../shared/cloud'

export interface ReadinessInput {
  workflows: { id: string; name: string; problems: string[]; deps: WorkflowDeps }[]
  providers: Record<CloudAdapter, ProviderStatus>
  /** the stored detail of a failing account (a test failure, or the usage limit a real run hit) */
  providerDetails?: Partial<Record<CloudAdapter, string | null>>
  secretNames: string[]
  connections: { id: string; name: string; authentication: string; authStatus: string | null }[]
  repos: { id: string; name: string; url: string; status: string; detail: string | null; lastSyncOk: boolean | null }[]
  passport: { configured: boolean; hostUp: boolean; passportId: string | null }
}

/** "fal.ai key (FAL_KEY)": a human name for the env var, when one is known */
export const keyLabel = (name: string): string => { const k = knownKey(name); return k ? `the ${k} (${name})` : `the key ${name}` }

const sentence = (s: string): string => { const t = s.trim().replace(/\s+/g, ' '); return /[.!?]$/.test(t) ? t : `${t}.` }

export function computeReadiness(r: ReadinessInput): { ready: boolean; fixes: CloudFix[] } {
  const fixes: CloudFix[] = []
  for (const adapter of CLOUD_ADAPTERS) {
    const users = r.workflows.filter(w => w.deps.adapters.includes(adapter))
    if (!users.length) continue
    const status = r.providers[adapter]
    if (status === 'ok' || status === 'expiring') continue
    const label = ADAPTER_LABEL[adapter]
    const who = users.length === 1 ? users[0]!.name : `${users[0]!.name} and ${users.length - 1} more`
    const detail = r.providerDetails?.[adapter] ?? null
    if (status === 'failing' && detail && /usage limit/i.test(detail)) {
      fixes.push({ kind: 'account', ref: adapter, message: sentence(`${detail} ${who} ${users.length === 1 ? 'waits' : 'wait'} until then`), action: 'wait' })
      continue
    }
    const message = status === 'expired' ? `Your ${label} sign-in expired. ${ADAPTER_ACTION[adapter]}`
      : status === 'failing' ? `${label} rejected the saved sign-in. ${ADAPTER_ACTION[adapter]}`
      : `${who} ${users.length === 1 ? 'uses' : 'use'} ${label}. ${ADAPTER_ACTION[adapter]}`
    fixes.push({ kind: 'account', ref: adapter, message })
  }
  const have = new Set(r.secretNames)
  const seenKeys = new Set<string>()
  for (const w of r.workflows) for (const name of w.deps.secrets) {
    if (have.has(name) || seenKeys.has(name)) continue
    seenKeys.add(name)
    fixes.push({ kind: 'key', ref: name, message: `${w.name} uses ${keyLabel(name)}, which is not in the cloud yet. Copy it from your Mac.` })
  }
  const conns = new Map(r.connections.map(c => [c.id, c]))
  const seenConns = new Set<string>()
  for (const w of r.workflows) for (const id of w.deps.connections) {
    if (conns.has(id) || seenConns.has(id)) continue
    seenConns.add(id)
    fixes.push({ kind: 'connection', ref: id, message: `${w.name} uses the ${id} connection. Copy it to the cloud from your Mac.` })
  }
  for (const c of r.connections) if (c.authentication === 'oauth' && c.authStatus !== 'connected') {
    fixes.push({ kind: 'connection', ref: c.id, message: c.authStatus === 'error' ? `${c.name} needs you to sign in again. Press Authorize.` : `${c.name} needs you to sign in. Press Authorize.` })
  }
  for (const repo of r.repos) {
    if (repo.status === 'ready' && repo.lastSyncOk !== false) continue
    const message = repo.status === 'failed' || repo.lastSyncOk === false
      ? sentence(`The ${repo.name} repo did not sync: ${repo.detail ?? 'GitHub refused it'}`)
      : `The ${repo.name} repo has not been cloned yet. Press Sync.`
    fixes.push({ kind: 'repo', ref: repo.id, message })
  }
  if (!r.passport.configured) fixes.push({ kind: 'passport', ref: '', message: 'This cloud has no passport host. Start it with docker compose so the passport container runs.' })
  else if (!r.passport.hostUp) fixes.push({ kind: 'passport', ref: r.passport.passportId ?? '', message: 'The passport host is not answering. Check that the passport container is running.' })
  else if (!r.passport.passportId) fixes.push({ kind: 'passport', ref: '', message: 'This company has no passport in the cloud yet. Move it to the cloud again from your Mac.' })
  for (const w of r.workflows) if (w.problems.length) fixes.push({ kind: 'workflow', ref: w.id, message: sentence(`${w.name} cannot run in the cloud: ${w.problems[0]}`) })
  return { ready: fixes.length === 0, fixes }
}
