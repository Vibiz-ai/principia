/**
 * Usage per step (CLOUD.md §9, §10.2), read from the step's own log through the engine's parsers: Claude stream-json
 * `result` (usage, total_cost_usd), Codex `--json` `turn.completed` token counts (summed over turns), Gemini
 * stream-json `result` stats. Subscription credentials bill the user's plan, so their dollars are never reported.
 */
import { readFileSync } from 'node:fs'
import { SUBSCRIPTION_KINDS, type ProviderCredentialKind } from '../../shared/cloud'
import type { AdapterId } from '../../shared/types'
import { DEFAULT_ADAPTERS } from '../../main/engine/adapters'

export interface StepUsage { inputTokens: number; outputTokens: number; usd: number | null }

/** Pure: the usage of one step's raw stdout lines. null when the CLI reported none (shell, a crash before the result). */
export function usageFromLog(adapter: AdapterId, raw: string, kind: ProviderCredentialKind | null): StepUsage | null {
  if (adapter === 'shell' || adapter === 'cursor') return null
  const parser = DEFAULT_ADAPTERS[adapter].createParser()
  let last: { tokensIn: number | null; tokensOut: number | null; costUsd: number | null } | null = null
  let sumIn = 0
  let sumOut = 0
  let seen = false
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let events
    try {
      events = parser.line(line)
    } catch {
      continue
    }
    for (const ev of events) {
      if (ev.kind !== 'usage' || (ev.tokensIn == null && ev.tokensOut == null)) continue
      seen = true
      last = ev
      sumIn += ev.tokensIn ?? 0
      sumOut += ev.tokensOut ?? 0
    }
  }
  if (!seen || !last) return null
  // codex reports each turn; claude and gemini report cumulative totals in their final result
  const inputTokens = adapter === 'codex' ? sumIn : (last.tokensIn ?? 0)
  const outputTokens = adapter === 'codex' ? sumOut : (last.tokensOut ?? 0)
  const subscription = !!kind && SUBSCRIPTION_KINDS.includes(kind)
  const usd = subscription || last.costUsd == null || !Number.isFinite(last.costUsd) ? null : last.costUsd
  return { inputTokens, outputTokens, usd }
}

export function usageFromLogFile(adapter: AdapterId, path: string | null, kind: ProviderCredentialKind | null): StepUsage | null {
  if (!path) return null
  try {
    return usageFromLog(adapter, readFileSync(path, 'utf8'), kind)
  } catch {
    return null
  }
}
