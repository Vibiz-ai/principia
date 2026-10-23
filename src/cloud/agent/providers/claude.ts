/** Claude Code credentials in a run (CLOUD.md §7.2): a `claude setup-token` subscription token or a Console API key. */
import type { ProviderMaterial } from '../../contract'
import type { RunSandbox } from '../sandbox'
import type { ProviderSetup } from './materialize'

export const CLAUDE_OAUTH_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/
export const ANTHROPIC_API_KEY_RE = /^sk-ant-(?:api\d\d-)?[A-Za-z0-9_-]{20,}$/

/**
 * claude_oauth_token -> CLAUDE_CODE_OAUTH_TOKEN (inference only; never `--bare`, which would ignore it), with HOME and
 * CLAUDE_CONFIG_DIR the run's own (the sandbox sets them). anthropic_api_key -> ANTHROPIC_API_KEY.
 */
export function materializeClaude(_box: RunSandbox, m: ProviderMaterial): ProviderSetup {
  const value = m.value.trim()
  if (m.kind === 'claude_oauth_token') return { env: { CLAUDE_CODE_OAUTH_TOKEN: value }, files: [] }
  if (m.kind === 'anthropic_api_key') return { env: { ANTHROPIC_API_KEY: value }, files: [] }
  throw new Error(`Claude cannot use a ${m.kind} credential`)
}

/** Well-formedness, in the founder's words. null = fine. */
export function claudeShapeProblem(m: ProviderMaterial): string | null {
  const v = m.value.trim()
  if (m.kind === 'claude_oauth_token') return CLAUDE_OAUTH_TOKEN_RE.test(v) ? null : "That doesn't look like a Claude token. Run claude setup-token and use the line that starts with sk-ant-oat01-."
  if (m.kind === 'anthropic_api_key') return ANTHROPIC_API_KEY_RE.test(v) ? null : "That doesn't look like an Anthropic API key (it starts with sk-ant-)."
  return 'Claude uses a Claude token or an Anthropic API key.'
}
