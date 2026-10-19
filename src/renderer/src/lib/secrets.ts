import type { AgentProfile, SecretMeta } from '@shared/types'

export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

/** Adapter auth vars stripped unless the profile opts into API-key auth (SPEC A6). */
export const ADAPTER_AUTH_VARS: Partial<Record<string, string[]>> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY']
}

/** Names of secrets a profile's processes actually receive. */
export function injectedNames(profile: AgentProfile | undefined, secrets: SecretMeta[]): string[] {
  if (!profile) return []
  const all = secrets.map((s) => s.name)
  const chosen = profile.secretNames.includes('*') ? all : all.filter((n) => profile.secretNames.includes(n))
  if (profile.useApiKeyAuth) return chosen
  const strip = new Set(ADAPTER_AUTH_VARS[profile.adapter] ?? [])
  return chosen.filter((n) => !strip.has(n))
}

/** The grey note on ANTHROPIC_API_KEY / OPENAI_API_KEY rows, or null. */
export function subscriptionNote(name: string, profiles: AgentProfile[]): string | null {
  for (const [adapter, vars] of Object.entries(ADAPTER_AUTH_VARS)) {
    if (!vars?.includes(name)) continue
    const optedIn = profiles.some((p) => p.adapter === adapter && p.useApiKeyAuth)
    if (optedIn) return null
    const label = adapter === 'claude' ? 'Claude' : 'Codex'
    return `Not given to ${label} (uses your subscription login)`
  }
  return null
}

/** Profiles that reference a key explicitly by name (not via '*'). */
export function profilesReferencing(name: string, profiles: AgentProfile[]): AgentProfile[] {
  return profiles.filter((p) => p.secretNames.includes(name))
}

export function isLiveKey(masked: string): boolean {
  return /^(sk|rk)_live/.test(masked)
}

/** Looks like a pasted .env blob (several KEY=VALUE lines). */
export function looksLikeEnvBlob(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
  return lines.length >= 2 && lines.filter((l) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).length >= 2
}
