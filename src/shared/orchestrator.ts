/**
 * ORCHESTRATOR.md: Principia's own layer between runs, the same on every harness. Shared types (main, renderer). Pure:
 * no node or electron imports.
 *
 * Before a run Principia hands the agent its context (inbox, related tasks, teammates' recent work) and the report
 * contract. After the run Principia reads the report (a trailing fenced block, or a file at $PRINCIPIA_RUN_REPORT) and
 * acts on it itself: the team update post, follow-up tasks, the handoff, questions to teammates (the mailbox), facts
 * as memory proposals and blockers into Needs you. MCP tools stay an optional fast path inside a task; what the agent
 * already did over MCP is never done twice.
 */

/** Settings → orchestrator. */
export interface OrchestratorSettings {
  /** off: nothing; shadow: record what Principia would do, do nothing; on: act */
  mode: 'off' | 'shadow' | 'on'
  /** the chief of staff between runs (phases 3-4): off, rules only, or rules plus a cheap model call */
  coordinator: 'off' | 'rules' | 'model'
  /** which CLI the cheap calls use (the founder's own login) */
  cli: 'auto' | 'claude' | 'codex'
  /** model calls per company per day (fallback extractor and coordinator together) */
  callsPerDay: number
  /** a run that ended without a report gets one cheap call that reads its answer (its result only proposes) */
  extractFallback: boolean
  /** This company > Team & autonomy > "Principia runs the team": one company's own switches over the ones above */
  companies?: Record<string, OrchestratorCompanySettings>
}

/** One company's "Principia runs the team" switches (absent fields = the app-wide setting). */
export interface OrchestratorCompanySettings {
  mode?: 'off' | 'on'
  coordinator?: 'off' | 'rules' | 'model'
  callsPerDay?: number
}

export const DEFAULT_ORCHESTRATOR: OrchestratorSettings = { mode: 'on', coordinator: 'rules', cli: 'auto', callsPerDay: 20, extractFallback: true }
export const ORCHESTRATOR_RANGES = { callsPerDay: { min: 0, max: 200 } } as const

/** The stored (partial) setting, filled and clamped. */
export function orchestratorSettings(raw?: Partial<OrchestratorSettings> | null): OrchestratorSettings {
  const r = raw ?? {}
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d)
  const n = Number(r.callsPerDay)
  return {
    mode: pick(r.mode, ['off', 'shadow', 'on'] as const, DEFAULT_ORCHESTRATOR.mode),
    coordinator: pick(r.coordinator, ['off', 'rules', 'model'] as const, DEFAULT_ORCHESTRATOR.coordinator),
    cli: pick(r.cli, ['auto', 'claude', 'codex'] as const, DEFAULT_ORCHESTRATOR.cli),
    callsPerDay: Number.isFinite(n) ? Math.min(ORCHESTRATOR_RANGES.callsPerDay.max, Math.max(ORCHESTRATOR_RANGES.callsPerDay.min, Math.round(n))) : DEFAULT_ORCHESTRATOR.callsPerDay,
    extractFallback: typeof r.extractFallback === 'boolean' ? r.extractFallback : DEFAULT_ORCHESTRATOR.extractFallback
  }
}

/**
 * The setting one company runs with: the app-wide one, then that company's own switches (Team & autonomy). A company
 * can only turn the layer off or on; shadow mode stays an app-wide debugging switch (a company 'on' keeps it).
 */
export function orchestratorFor(raw: Partial<OrchestratorSettings> | null | undefined, companyId: string | null | undefined): OrchestratorSettings {
  const base = orchestratorSettings(raw)
  const own = companyId ? raw?.companies?.[companyId] : undefined
  if (!own) return base
  const merged = orchestratorSettings({
    ...base,
    ...(own.mode === 'off' ? { mode: 'off' as const } : own.mode === 'on' && base.mode === 'off' ? { mode: 'on' as const } : {}),
    ...(own.coordinator ? { coordinator: own.coordinator } : {}),
    ...(own.callsPerDay !== undefined ? { callsPerDay: own.callsPerDay } : {})
  })
  return merged
}

// ---------- the run report contract (v1) ----------

/** The trailing fenced block that carries a run report. */
export const RUN_REPORT_FENCE = 'principia-run-report'
/** The env var that points at the report file of one step (`<run logs>/<run id>/<step id>.report.json`). */
export const RUN_REPORT_ENV = 'PRINCIPIA_RUN_REPORT'

export const RUN_REPORT_LIMITS = {
  summary: 2000,
  evidence: 20,
  evidenceItem: 500,
  followUps: 5,
  title: 200,
  goal: 2000,
  questions: 3,
  question: 1000,
  why: 500,
  facts: 10,
  fact: 500,
  topic: 120,
  blockers: 5,
  blocker: 1000,
  suggestions: 5,
  suggestion: 500,
  answers: 5,
  answer: 2000
} as const

export type RunOutcome = 'review' | 'blocked' | 'answered' | 'progress'
/** `agentHandle`: the teammate who should do it (its department follows); else `departmentKey`, else the routing rules. */
export interface RunFollowUp { title: string; goal: string; departmentKey?: string; agentHandle?: string; blocksCurrent?: boolean }
export interface RunHandoff { departmentKey?: string; agentHandle?: string; why: string }
export interface RunQuestion { to: string; question: string; why: string; blocking: boolean }
export interface RunFact { text: string; topic?: string }
export interface RunBlocker { text: string; needs: 'decision' | 'access' | 'money' | 'connection'; connectionId?: string }
export interface RunSuggestion { kind: 'routine' | 'connection' | 'task'; text: string; cron?: string; connectionId?: string }
/** An answer to a question a teammate asked this agent (its ask's ref, e.g. m1c). */
export interface RunAnswer { ref: string; text: string }

export interface RunReport {
  v: 1
  outcome: RunOutcome
  summary: string
  evidence: string[]
  followUps: RunFollowUp[]
  handoff?: RunHandoff
  questions: RunQuestion[]
  facts: RunFact[]
  blockers: RunBlocker[]
  suggestions: RunSuggestion[]
  answers: RunAnswer[]
}

/** Where the report came from: the fenced block, the file, the fallback extractor, or only MCP calls. */
export type RunReportSource = 'fence' | 'file' | 'extracted' | 'mcp' | 'none'

// ---------- what Principia did after a run (the Run view) ----------

export type OrchActionKind = 'post' | 'follow_up' | 'handoff' | 'question' | 'answer' | 'fact' | 'blocker' | 'founder_question' | 'suggestion'
/**
 * done: Principia did it; skipped: nothing to do (the agent already did it over MCP, a duplicate, a cap); shadow: what
 * it would have done (shadow mode); proposed: waits for the founder (facts, an extracted report's ideas); failed.
 */
export type OrchActionStatus = 'done' | 'skipped' | 'shadow' | 'proposed' | 'failed'
export interface OrchAction {
  kind: OrchActionKind
  status: OrchActionStatus
  /** plain words for the founder */
  detail: string
  /** a task identifier, a Forum message ref, a proposal id */
  ref?: string
  /** a principia:// link (a connection to set up) */
  link?: string
}

export interface RunOrchestration {
  runId: string
  companyId: string
  mode: 'shadow' | 'on'
  source: RunReportSource
  summary: string | null
  actions: OrchAction[]
  createdAt: string
  appliedAt: string | null
}

// ---------- the chief of staff (the coordinator, ORCHESTRATOR.md §3) ----------

/** What wakes the coordinator of one company (debounced into one batch). */
export type OrchEventKind = 'run_ended' | 'task_done' | 'task_created' | 'ask_answered' | 'forum_human_post' | 'tick'
export interface OrchEvent {
  id: string
  kind: OrchEventKind
  companyId: string
  at: string
  runId?: string | null
  taskId?: string | null
  agentId?: string | null
  messageId?: string | null
  /** short plain text (a human post, a task title) */
  text?: string
}

/**
 * The coordinator's closed set of verbs. Anything else (spending, publishing, external messages, deleting, approving
 * or closing tasks, creating companies or departments) is refused in code.
 */
export const ORCH_VERBS = ['pump', 'wake_task', 'ask_agent', 'file_task', 'suggest', 'digest_post'] as const
export type OrchVerb = (typeof ORCH_VERBS)[number]

export type SuggestionKind = 'routine' | 'connection' | 'task'
export interface OrchDecision {
  verb: string
  /** a task identifier (NC-4) or id */
  task?: string
  /** an agent handle (@support) or department key */
  to?: string
  /** ask_agent: the agent who asks */
  from?: string
  title?: string
  text?: string
  kind?: SuggestionKind
  cron?: string
  connectionId?: string
  why?: string
}
export type OrchDecisionStatus = 'done' | 'refused' | 'skipped' | 'shadow' | 'failed'
export interface OrchDecisionResult {
  verb: string
  status: OrchDecisionStatus
  /** plain words for the founder */
  detail: string
  ref?: string
}
/** One batch the chief of staff handled (orch_decisions), as Activity shows it. */
export interface OrchDecisionRecord {
  id: string
  companyId: string
  events: OrchEventKind[]
  mode: 'rules' | 'model'
  /** why the model was not asked (budget used up, the call failed), when it was wanted */
  note: string | null
  results: OrchDecisionResult[]
  costTokens: number
  createdAt: string
}

export const COORDINATOR_LIMITS = {
  /** events are debounced this long, then handled as one batch */
  debounceMs: 2 * 60_000,
  /** a busy company still gets its batch this long after the first event */
  maxWaitMs: 10 * 60_000,
  /** decisions taken from one batch */
  decisions: 8,
  /** a daily tick per company */
  tickMs: 24 * 3_600_000,
  text: 1000,
  digest: 900
} as const

// ---------- feature pushes (suggestions in Needs you, ORCHESTRATOR.md §3) ----------

export const SUGGESTION_LIMITS = { perDay: 3, cooldownDays: 14, title: 160, detail: 600 } as const
export type SuggestionStatus = 'open' | 'accepted' | 'dismissed' | 'expired'
export interface OrchSuggestion {
  id: string
  companyId: string
  kind: SuggestionKind
  title: string
  detail: string
  status: SuggestionStatus
  /** routine: its cron (5 fields); connection: its principia://connect link; task: the board task (if filed) */
  cron?: string
  link?: string
  /** a ready-made routine (shared/routines.ts): its link opens Automations › Routines with it */
  routineId?: string
  taskId?: string
  taskIdentifier?: string
  agentId?: string
  createdAt: string
  decidedAt: string | null
}

/** Open suggestions per company: each one counts once in Needs you (rail, sidebar, status bar, the phone). */
export function suggestionCounts(list: readonly Pick<OrchSuggestion, 'companyId' | 'status'>[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of list) if (s.status === 'open') out[s.companyId] = (out[s.companyId] ?? 0) + 1
  return out
}
