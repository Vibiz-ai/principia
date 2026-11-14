/**
 * The simplified Principia: no per-agent setup (departments, seats, the Board, the Forum) and no Autopilot. Agents
 * are picked automatically, so the experimental switches that turn that layer on are held off at every start. The
 * code behind them stays (and keeps its tests) but nothing in the app reaches it.
 *
 * Pure, so the rule is tested without Electron.
 */
import type { ExperimentalFlags } from '@shared/types'

/** The flags this build never runs with. */
export const RETIRED_FLAGS = ['departments', 'plans'] as const

/**
 * The patch that turns the retired flags off, or null when they already are. Every other flag (companies, the vault,
 * vault AI) is left exactly as the founder set it.
 */
export function retiredFlagsPatch(cur: ExperimentalFlags | null | undefined): ExperimentalFlags | null {
  const on = RETIRED_FLAGS.filter((f) => !!cur?.[f])
  if (!on.length) return null
  return { ...(cur ?? {}), ...Object.fromEntries(on.map((f) => [f, false])) } as ExperimentalFlags
}
