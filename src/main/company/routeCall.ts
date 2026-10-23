/**
 * DEPARTMENTS.md §2 step 4 in production: the `ModelCall` suggestRoute is injected with. One headless Claude turn with
 * the onboarding plan call's conventions (oneshot.ts): `claude -p --output-format json --max-turns 1 --model haiku
 * --tools '' --strict-mcp-config --permission-mode dontAsk --no-session-persistence`, an empty temp cwd, the login env
 * minus every provider / workflow key, the request's timeout, and the task text inside a neutralized `<data>` frame
 * (suggestRoute already redacted and capped it). The abort signal kills the process group.
 *
 * `routeModelCall` returns null when no Claude CLI is installed: suggestions are then simply off. No Electron imports.
 */
import type { ProviderInfo } from '../../shared/types'
import { claudeCliAvailable, cliText, emptyCwd, neutralizeFrame, startOneshot, type ExecFn } from '../oneshot'
import { planArgs, planChildEnv } from '../onboarding/plan'
import type { ModelCall, ModelCallRequest } from './router'

export const ROUTE_CWD_PREFIX = 'principia-route-'
const FRAME = ['data'] as const

/** The prompt on stdin: the router's system text, then the task as data. */
export function routePrompt(req: Pick<ModelCallRequest, 'system' | 'input'>): string {
  return [req.system, '', 'The task:', '<data>', neutralizeFrame(req.input, FRAME), '</data>', '', 'Answer with the JSON object only.'].join('\n')
}

export interface RouteCallDeps {
  providers: () => readonly ProviderInfo[]
  exec?: ExecFn
  baseEnv?: () => Record<string, string>
  cwd?: () => string
}

/** The ModelCall for suggestRoute, or null without a Claude CLI (checked on every call site, so an install turns it on). */
export function routeModelCall(deps: RouteCallDeps): ModelCall | null {
  const cli = claudeCliAvailable(deps.providers())
  if (!cli) return null
  return async (req) => {
    if (req.signal.aborted) throw new Error('aborted')
    const h = (deps.exec ?? startOneshot)(cli.bin, planArgs(false), {
      cwd: deps.cwd ? deps.cwd() : emptyCwd(ROUTE_CWD_PREFIX),
      env: planChildEnv(deps.baseEnv?.()),
      stdin: routePrompt(req),
      timeoutMs: req.timeoutMs
    })
    const kill = (): void => void h.kill()
    req.signal.addEventListener('abort', kill, { once: true })
    try {
      const r = await h.promise
      if (r.killed || r.timedOut || r.spawnError || r.code !== 0 || r.truncated) throw new Error('the route call failed')
      return cliText('claude', r.stdout)
    } finally {
      req.signal.removeEventListener('abort', kill)
    }
  }
}
