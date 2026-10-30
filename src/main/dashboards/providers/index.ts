/** DASHBOARDS.md §4: every catalog kind's provider, plus the keyless Claude CLI answer engine for GEO. No Electron imports. */
import type { DashboardKind } from '../../../shared/dashboards'
import { claudeCliAvailable, cliText, emptyCwd, startOneshot, type ExecFn } from '../../oneshot'
import { planArgs, planChildEnv } from '../../onboarding/plan'
import type { ProviderInfo } from '../../../shared/types'
import { DashboardFetchError } from '../http'
import { activationProvider } from './activation'
import { plausibleProvider, posthogProvider } from './analytics'
import { geoProvider } from './geo'
import { githubProvider } from './github'
import { gscProvider } from './gsc'
import { stripeProvider } from './stripe'
import type { DashboardProvider, GeoEngine } from './types'

export const PROVIDERS: Record<DashboardKind, DashboardProvider> = {
  gsc: gscProvider,
  geo: geoProvider,
  plausible: plausibleProvider,
  posthog: posthogProvider,
  activation: activationProvider,
  stripe: stripeProvider,
  github: githubProvider
}

const GEO_CWD_PREFIX = 'principia-geo-'
const CLAUDE_GEO_TIMEOUT_MS = 90_000

/**
 * The installed Claude CLI as a GEO engine: one headless turn (haiku, no tools, no MCP, no session) in an empty temp
 * cwd with every provider key stripped from its env, the tracked prompt on stdin. null without the CLI.
 */
export function claudeGeoEngine(providers: readonly ProviderInfo[], exec: ExecFn = startOneshot): GeoEngine | null {
  const cli = claudeCliAvailable(providers)
  if (!cli) return null
  return {
    id: 'claude',
    label: 'Claude',
    async ask(prompt) {
      const h = exec(cli.bin, planArgs(false), { cwd: emptyCwd(GEO_CWD_PREFIX), env: planChildEnv(), stdin: prompt, timeoutMs: CLAUDE_GEO_TIMEOUT_MS })
      const r = await h.promise
      if (r.timedOut) throw new DashboardFetchError('unavailable', 'Claude took too long to answer.')
      if (r.spawnError || r.code !== 0) throw new DashboardFetchError('unavailable', 'The Claude CLI did not answer. Check that it is signed in.')
      try {
        return { text: cliText('claude', r.stdout), citations: [] }
      } catch {
        throw new DashboardFetchError('unavailable', 'The Claude CLI reported an error.')
      }
    }
  }
}
