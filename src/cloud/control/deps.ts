/**
 * What a synced workflow needs in the cloud (CLOUD.md §7.9): the adapters its steps run, the company keys it reads and
 * the connections it names. Pure and conservative: only a missing thing the workflow clearly uses becomes a fix.
 */
import { CLOUD_ADAPTERS, type CloudAdapter } from '../../shared/cloud'

export interface WorkflowDeps { adapters: CloudAdapter[]; secrets: string[]; connections: string[] }

/** Provider and engine variables the runtime supplies itself: never asked for as company keys. */
const SUPPLIED = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN'])
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|DSN)$|_API_/
const ENV_REF = /\$\{?([A-Z][A-Z0-9_]{2,63})\}?|process\.env\.([A-Z][A-Z0-9_]{2,63})|process\.env\[['"]([A-Z][A-Z0-9_]{2,63})['"]\]|os\.environ(?:\.get\(|\[)\s*['"]([A-Z][A-Z0-9_]{2,63})['"]|os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,63})['"]/g
/**
 * A key named in plain prose ("Read the key from the FAL_KEY environment variable", "Use FAL_KEY for images"): an
 * all-caps name with an underscore that ends like a secret. Generic words (API_KEY alone) are not a key name.
 */
const BARE_KEY = /(?<![$A-Za-z0-9_.])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD))(?![A-Za-z0-9_])/g
const GENERIC = new Set(['API_KEY', 'ACCESS_TOKEN', 'AUTH_TOKEN', 'SECRET_KEY', 'API_TOKEN', 'API_SECRET', 'BEARER_TOKEN', 'REFRESH_TOKEN', 'ID_TOKEN', 'PRIVATE_KEY', 'PUBLIC_KEY', 'SESSION_TOKEN', 'CSRF_TOKEN'])
const CONNECTION_REF = /["']?connection["']?\s*[:=]\s*["']([a-zA-Z0-9_-]{1,64})["']/g

export const adapterOfProfile = (profileId: unknown): CloudAdapter | null => {
  const m = typeof profileId === 'string' ? /^prof_([a-z]+)$/.exec(profileId) : null
  return m && (CLOUD_ADAPTERS as readonly string[]).includes(m[1]!) ? (m[1] as CloudAdapter) : null
}

const wanted = (name: string): boolean => SECRET_NAME.test(name) && !SUPPLIED.has(name) && !/^(HIVE|PRINCIPIA|GIT)_/.test(name)

/** Key names a workflow uses: environment references plus well-formed names in plain prose, plus `declared` (the desktop's own list). */
export function workflowDeps(file: unknown, declared: readonly string[] = []): WorkflowDeps {
  const wf = (file as { workflow?: { nodes?: unknown[] } } | null)?.workflow
  const nodes = Array.isArray(wf?.nodes) ? (wf!.nodes as Record<string, unknown>[]) : []
  const adapters = new Set<CloudAdapter>()
  const texts: string[] = []
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const a = adapterOfProfile(n.profileId)
    if (a) adapters.add(a)
    if (Array.isArray(n.participants)) for (const p of n.participants as { profileId?: unknown }[]) { const pa = adapterOfProfile(p?.profileId); if (pa) adapters.add(pa) }
    for (const k of ['prompt', 'command', 'topic', 'criteria', 'message', 'title']) if (typeof n[k] === 'string') texts.push(n[k] as string)
  }
  const secrets = new Set<string>()
  const connections = new Set<string>()
  for (const t of texts) {
    for (const m of t.matchAll(ENV_REF)) {
      const name = m.slice(1).find(Boolean)!
      if (wanted(name)) secrets.add(name)
    }
    for (const m of t.matchAll(BARE_KEY)) if (!GENERIC.has(m[1]!) && wanted(m[1]!)) secrets.add(m[1]!)
    for (const m of t.matchAll(CONNECTION_REF)) if (m[1] !== 'passport') connections.add(m[1]!)
  }
  for (const name of declared) if (/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) && !SUPPLIED.has(name) && !/^(HIVE|PRINCIPIA|GIT)_/.test(name)) secrets.add(name)
  return { adapters: [...adapters].sort(), secrets: [...secrets].sort(), connections: [...connections].sort() }
}

export const workflowName = (file: unknown): string => {
  const n = (file as { workflow?: { name?: unknown } } | null)?.workflow?.name
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 200) : 'Untitled workflow'
}

export const ADAPTER_LABEL: Record<CloudAdapter, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }
export const ADAPTER_ACTION: Record<CloudAdapter, string> = { claude: 'Connect Claude.', codex: 'Sign in with ChatGPT.', gemini: 'Add a Gemini key.' }
