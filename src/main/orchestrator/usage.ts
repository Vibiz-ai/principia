/**
 * ORCHESTRATOR.md §5: Principia's own cheap calls (the chief of staff, the fallback extractor) are counted as usage
 * source `orchestrator` (table orch_usage), so Spend shows them as "Principia (chief of staff)" and a company's monthly
 * cap counts them. Tokens and the CLI's reported value are read from the CLI's stdout envelope. No Electron imports.
 */
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { OneshotCli } from '../oneshot'

export interface CallUsage { tokensIn: number; tokensOut: number; costUsd: number | null; model: string | null }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** Tokens of one headless call: claude json (`usage`, `total_cost_usd`, `modelUsage`), codex JSONL (`turn.completed`). */
export function cliUsage(cli: OneshotCli, stdout: string): CallUsage {
  const out: CallUsage = { tokensIn: 0, tokensOut: 0, costUsd: null, model: null }
  const s = stdout.trim()
  if (!s) return out
  if (cli === 'claude' || cli === 'gemini') {
    try {
      const v = JSON.parse(s) as { usage?: Record<string, unknown>; total_cost_usd?: unknown; modelUsage?: Record<string, unknown> }
      const u = v.usage ?? {}
      out.tokensIn = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
      out.tokensOut = num(u.output_tokens)
      out.costUsd = typeof v.total_cost_usd === 'number' && Number.isFinite(v.total_cost_usd) ? v.total_cost_usd : null
      out.model = v.modelUsage && typeof v.modelUsage === 'object' ? (Object.keys(v.modelUsage)[0] ?? null) : null
    } catch {
      /* no envelope: nothing to count */
    }
    return out
  }
  for (const line of s.split('\n')) {
    try {
      const v = JSON.parse(line) as { type?: string; usage?: Record<string, unknown>; model?: unknown }
      if (v.type === 'turn.completed' && v.usage) {
        out.tokensIn += num(v.usage.input_tokens)
        out.tokensOut += num(v.usage.output_tokens)
      }
      if (typeof v.model === 'string') out.model = v.model
    } catch {
      /* not an event line */
    }
  }
  return out
}

/** One call into orch_usage. Never throws. */
export function recordUsage(db: Database.Database, row: { companyId: string; purpose: 'coordinator' | 'extract'; cli: OneshotCli; usage: CallUsage; at: string }): void {
  try {
    db.prepare('INSERT INTO orch_usage(id,company_id,purpose,cli,model,tokens_in,tokens_out,cost_usd,at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      `ou_${randomBytes(6).toString('hex')}`,
      row.companyId,
      row.purpose,
      row.cli,
      row.usage.model,
      Math.round(row.usage.tokensIn),
      Math.round(row.usage.tokensOut),
      row.usage.costUsd,
      row.at
    )
  } catch {
    /* usage bookkeeping never fails a call */
  }
}
