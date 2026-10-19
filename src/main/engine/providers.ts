import type { AdapterId, ProviderInfo } from '../../shared/types'
import { ADAPTER_IDS } from '../../shared/types'
import type { Adapter } from './adapters'
import { HOOKS_VERIFIED } from './live/attach'
import { memoryTransport } from './memory'
import { capture } from './process'
import { which } from './util'

/** Resolves an adapter's binary on the (login) PATH. Shell = $SHELL or /bin/zsh. */
export function resolveBin(adapter: Adapter, env: Record<string, string>): string | null {
  if (adapter.id === 'shell') return which(env.SHELL || '/bin/zsh', env.PATH) ?? which('/bin/zsh', env.PATH)
  return which(adapter.bin, env.PATH)
}

const firstVersion = (s: string): string | null => {
  const m = s.match(/\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.]+)?/)
  return m ? m[0] : s.trim().split('\n')[0]?.slice(0, 40) || null
}

/** Detects all 5 adapters in parallel (PATH lookup + `--version`, 5 s each). Never throws. */
export async function detectProviders(
  adapters: Record<AdapterId, Adapter>,
  env: Record<string, string>,
  now: Date
): Promise<ProviderInfo[]> {
  return Promise.all(
    ADAPTER_IDS.map(async (id): Promise<ProviderInfo> => {
      const a = adapters[id]
      const binPath = resolveBin(a, env)
      let version: string | null = null
      if (binPath) {
        const r = await capture(binPath, a.versionArgs, env, 5000)
        version = firstVersion(r.stdout || r.stderr)
      }
      return {
        id,
        label: a.label,
        available: binPath !== null,
        version,
        binPath,
        installHint: a.installHint,
        checkedAt: now.toISOString(),
        ...(memoryTransport(id) ? { memory: memoryTransport(id)! } : {}),
        ...(id === 'claude' || id === 'gemini' || id === 'cursor' ? { headlessAsks: id === 'claude' || HOOKS_VERIFIED[id] } : {})
      }
    })
  )
}

export const sameProviders = (a: ProviderInfo[], b: ProviderInfo[]): boolean =>
  a.length === b.length &&
  a.every((p, i) => p.id === b[i].id && p.available === b[i].available && p.version === b[i].version && p.binPath === b[i].binPath)
