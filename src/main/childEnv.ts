import type { AdapterId, AgentProfile } from '../shared/types'

/** SPEC A6: auth vars that silently switch a subscription login to metered API billing. */
export const ADAPTER_AUTH_VARS: Partial<Record<AdapterId, string[]>> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY']
}

export interface ChildEnvInput {
  base: Record<string, string>
  specEnv?: Record<string, string>
  secrets: Record<string, string>
  stripEnv?: string[]
  profile: Pick<AgentProfile, 'adapter' | 'useApiKeyAuth'>
  hive: Record<string, string>
}

/** CONTRACT §2.2, later wins: base -> adapter env -> secrets -> strip auth vars (unless useApiKeyAuth) -> Hive vars. */
export function buildChildEnv(i: ChildEnvInput): Record<string, string> {
  const env: Record<string, string> = { ...i.base, ...(i.specEnv ?? {}), ...i.secrets }
  if (!i.profile.useApiKeyAuth) {
    for (const k of new Set([...(i.stripEnv ?? []), ...(ADAPTER_AUTH_VARS[i.profile.adapter] ?? [])])) delete env[k]
  }
  Object.assign(env, i.hive)
  return env
}
