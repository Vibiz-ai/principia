import type { AgentProfile } from '../../shared/types'
import type { EngineContext } from '../../shared/engine'
import type { Adapter } from './adapters'

const DROP_PREFIXES = ['ELECTRON_', 'VITE_']
const DROP_NAMES = new Set(['NODE_OPTIONS'])

/**
 * Child env, CONTRACT 2.2 (later wins): baseEnv -> adapter env -> profile secrets ('*' = all)
 * -> strip adapter auth vars unless profile.useApiKeyAuth (SPEC A6) -> Hive vars.
 * Profile null (shell nodes, command checks) = all secrets.
 * `secretNames` overrides the profile's list (SLACK.md SA2: a Slack-triggered run gets only the keys its trigger
 * allow-lists, never '*').
 */
export function buildChildEnv(
  ctx: EngineContext,
  adapter: Adapter,
  profile: AgentProfile | null,
  hiveVars: Record<string, string>,
  secretNames?: string[]
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(ctx.baseEnv())) {
    if (DROP_NAMES.has(k) || DROP_PREFIXES.some((p) => k.startsWith(p))) continue
    env[k] = v
  }
  env.HIVE = '1'
  // an API-key-billed profile still needs its own auth key (the CLI cannot start without it)
  const names = secretSelection(adapter, profile, secretNames)
  if (names.length) Object.assign(env, ctx.secrets.resolve(names))
  if (!profile?.useApiKeyAuth) for (const name of adapter.authEnv) delete env[name]
  Object.assign(env, hiveVars)
  return env
}

function secretSelection(adapter: Adapter, profile: AgentProfile | null, secretNames?: string[]): string[] {
  return secretNames
    ? [...new Set([...secretNames.filter((n) => n !== '*'), ...(profile?.useApiKeyAuth ? adapter.authEnv : [])])]
    : (profile?.secretNames ?? ['*'])
}

/** The vault key names buildChildEnv puts in the env (same selection and auth stripping), without decrypting. */
export function childKeyNames(ctx: EngineContext, adapter: Adapter, profile: AgentProfile | null, secretNames?: string[]): string[] {
  const names = secretSelection(adapter, profile, secretNames)
  if (!names.length || !ctx.secrets.names) return []
  return ctx.secrets.names(names).filter((n) => profile?.useApiKeyAuth || !adapter.authEnv.includes(n))
}
