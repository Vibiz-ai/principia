/**
 * AGENT-COLLAB.md §4: a small price table for estimating dollars when a CLI reports tokens but no cost.
 *
 * Claude Code reports its own cost (`total_cost_usd`, stored in agents.cost_usd): that number always wins. Codex and
 * Gemini report tokens only, and some Claude rows have none, so team_usage estimates those from this table and marks
 * the figure with "~". Source: Anthropic's published API list prices per million tokens (input / output, first-party
 * API, prompts without caching), as cached in the Claude API reference on 2026-10-06. Models not in the table
 * (OpenAI, Google) are reported as tokens with no dollar figure rather than guessed. Subscription plans bill the plan,
 * not these rates: the estimate is "what this would cost on the API".
 */

export interface ModelPrice { inPerM: number; outPerM: number }

export const PRICE_SOURCE = 'Anthropic API list prices (Claude API reference, cached 2026-10-06)'

/** Longest prefix wins (`claude-opus-5-5[1m]` → claude-opus-5-5). */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { inPerM: 10, outPerM: 50 },
  'claude-fable-5': { inPerM: 10, outPerM: 50 },
  'claude-opus-5-5': { inPerM: 4, outPerM: 20 },
  'claude-opus-5': { inPerM: 5, outPerM: 25 },
  'claude-opus-4-8': { inPerM: 5, outPerM: 25 },
  'claude-opus-4-7': { inPerM: 5, outPerM: 25 },
  'claude-opus-4-6': { inPerM: 5, outPerM: 25 },
  'claude-sonnet-5-5': { inPerM: 2, outPerM: 10 },
  'claude-sonnet-5': { inPerM: 2, outPerM: 10 },
  'claude-sonnet-4-6': { inPerM: 3, outPerM: 15 },
  'claude-haiku-5-5': { inPerM: 0.1, outPerM: 0.5 },
  'claude-haiku-4-5': { inPerM: 1, outPerM: 5 }
}

export function priceOf(model: string | null | undefined): ModelPrice | null {
  if (!model) return null
  const m = model.toLowerCase().trim()
  let best: string | null = null
  for (const k of Object.keys(MODEL_PRICES)) if (m.startsWith(k) && (!best || k.length > best.length)) best = k
  return best ? MODEL_PRICES[best] : null
}

/** Estimated dollars for a token count, or null when the model is unknown. */
export function estimateUsd(model: string | null | undefined, tokensIn: number, tokensOut: number): number | null {
  const p = priceOf(model)
  if (!p) return null
  return (Math.max(0, tokensIn) * p.inPerM + Math.max(0, tokensOut) * p.outPerM) / 1_000_000
}

/** A reported cost when there is one, else the estimate (flagged). */
export function costOf(row: { model: string | null; tokensIn: number | null; tokensOut: number | null; costUsd: number | null }): { usd: number | null; estimated: boolean } {
  if (row.costUsd != null && Number.isFinite(row.costUsd)) return { usd: row.costUsd, estimated: false }
  if (row.tokensIn == null && row.tokensOut == null) return { usd: null, estimated: false }
  const usd = estimateUsd(row.model, row.tokensIn ?? 0, row.tokensOut ?? 0)
  return { usd, estimated: usd != null }
}

export function fmtUsd(usd: number | null, estimated = false): string {
  if (usd == null) return '$?'
  const v = usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)
  return `${estimated ? '~' : ''}$${v}`
}
