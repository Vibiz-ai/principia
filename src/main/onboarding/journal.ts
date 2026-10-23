/**
 * The onboarding launch journal (docs/ONBOARDING.md §7.2–§7.4): one row per launch in hive.db's `meta` table under
 * `onboarding.journal.<id>`, written after every created item so a Retry (or a crash followed by Retry) resumes at the
 * failed step without duplicates, and Discard knows exactly what to undo.
 *
 * What a journal holds: per-step status, the ids each step created (`{kind, id}`), the plan ref → id maps the later
 * steps need, the flags before step 1 (`prevFlags`) and the created schedules (`scheduleRefs`). Never a key value: the
 * keys step records only `{kind:'secret', id: <key name>}`.
 *
 * The launch input (answers, plan, stash handle; no key) is kept beside it under `onboarding.launchInput.<id>` so
 * "Continue without this" can resume after a restart. Both are removed or trimmed when the journal ends.
 *
 * No Electron imports.
 */
import { randomBytes } from 'node:crypto'
import {
  LAUNCH_STEPS,
  type JournalMeta,
  type LaunchCreated,
  type LaunchInput,
  type LaunchJournal,
  type LaunchStepName,
  type LaunchStepState
} from '../../shared/onboarding'
import type { ExperimentalFlags } from '../../shared/types'

export const JOURNAL_PREFIX = 'onboarding.journal.'
export const LAUNCH_INPUT_PREFIX = 'onboarding.launchInput.'
/** Shown on the step that was running when the app quit or crashed (§7.4). */
export const INTERRUPTED_ERROR = 'Setup was interrupted'
/** Finished journals older than this are dropped on boot (failed and running ones are kept until resolved). */
export const JOURNAL_KEEP_MS = 30 * 24 * 60 * 60 * 1000

/** Plan ref → created id, per kind, plus the facts later steps and `start` need. */
export interface JournalRefs {
  /** Repos attached to the company, in plan order (the first one is "first repo"). */
  repoIds: string[]
  /** bundled workflow id → installed workflow id */
  workflows: Record<string, string>
  /** department preset key → department id */
  departments: Record<string, string>
  /** plan agent ref → company agent id */
  agents: Record<string, string>
  /** Agents the plan marked `auto` (raised only by onboarding:start). */
  autoAgents: string[]
  /** plan task ref → task id */
  tasks: Record<string, string>
}

/** What is stored: the public journal plus the ref maps. */
export interface StoredJournal extends LaunchJournal {
  refs: JournalRefs
  /** onboarding:start ran (Autopilot / schedules decided). */
  startedAt?: string
}

/** The meta table surface the journal needs (Store satisfies it). */
export interface MetaStore {
  getMeta(key: string): string | null
  setMeta(key: string, value: string | null): void
  db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } }
}

const JOURNAL_ID = /^[A-Za-z0-9_-]{1,64}$/

export function newJournalId(): string {
  return `obj_${randomBytes(9).toString('hex')}`
}

export function emptyRefs(): JournalRefs {
  return { repoIds: [], workflows: {}, departments: {}, agents: {}, autoAgents: [], tasks: {} }
}

function freshSteps(): LaunchStepState[] {
  return LAUNCH_STEPS.map((name) => ({ name, status: 'pending', created: [] }))
}

/** A stored value parsed back into a journal, or null when it is not one (a corrupt row is ignored, never thrown). */
export function parseJournal(raw: string | null): StoredJournal | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const j = v as Partial<StoredJournal>
  if (typeof j.id !== 'string' || !JOURNAL_ID.test(j.id) || typeof j.draftId !== 'string') return null
  if (!['running', 'failed', 'done', 'discarded'].includes(j.status as string)) return null
  const byName = new Map((Array.isArray(j.steps) ? j.steps : []).map((s) => [s?.name, s]))
  const steps: LaunchStepState[] = LAUNCH_STEPS.map((name) => {
    const s = byName.get(name)
    return {
      name,
      status: s && ['pending', 'running', 'done', 'failed', 'skipped'].includes(s.status) ? s.status : 'pending',
      created: Array.isArray(s?.created) ? s!.created.filter((c): c is LaunchCreated => !!c && typeof c.kind === 'string' && typeof c.id === 'string') : [],
      ...(s?.error ? { error: String(s.error) } : {})
    }
  })
  const refs = { ...emptyRefs(), ...(j.refs && typeof j.refs === 'object' ? j.refs : {}) }
  return {
    id: j.id,
    draftId: j.draftId,
    mode: j.mode === 'first' ? 'first' : 'new',
    status: j.status!,
    companyId: typeof j.companyId === 'string' ? j.companyId : null,
    ...(typeof j.companyName === 'string' ? { companyName: j.companyName } : {}),
    steps,
    ...(j.prevFlags && typeof j.prevFlags === 'object' ? { prevFlags: j.prevFlags as ExperimentalFlags } : {}),
    scheduleRefs: Array.isArray(j.scheduleRefs) ? j.scheduleRefs.filter((r) => r && typeof r.ref === 'string' && typeof r.id === 'string').map((r) => ({ ref: r.ref, id: r.id, costly: !!r.costly })) : [],
    createdAt: typeof j.createdAt === 'string' ? j.createdAt : new Date(0).toISOString(),
    updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : new Date(0).toISOString(),
    refs,
    ...(typeof j.startedAt === 'string' ? { startedAt: j.startedAt } : {})
  }
}

/** The renderer's view (onboarding:status, LaunchResult): metadata only. */
export function journalMeta(j: StoredJournal): JournalMeta {
  return {
    id: j.id,
    draftId: j.draftId,
    mode: j.mode,
    status: j.status,
    companyId: j.companyId,
    ...(j.companyName ? { companyName: j.companyName } : {}),
    steps: j.steps.map((s) => ({ ...s, created: [...s.created] })),
    scheduleRefs: j.scheduleRefs.map((r) => ({ ...r })),
    updatedAt: j.updatedAt
  }
}

export function stepOf(j: StoredJournal, name: LaunchStepName): LaunchStepState {
  return j.steps.find((s) => s.name === name)!
}

export class JournalStore {
  constructor(
    private readonly meta: MetaStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  private key(id: string): string {
    return `${JOURNAL_PREFIX}${id}`
  }

  get(id: string): StoredJournal | null {
    if (!JOURNAL_ID.test(id)) return null
    return parseJournal(this.meta.getMeta(this.key(id)))
  }

  /** Every stored journal, newest first. */
  list(): StoredJournal[] {
    const rows = this.meta.db.prepare(`SELECT value FROM meta WHERE key LIKE '${JOURNAL_PREFIX}%'`).all() as { value: string }[]
    return rows
      .map((r) => parseJournal(r.value))
      .filter((j): j is StoredJournal => !!j)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  }

  create(input: { draftId: string; mode: 'first' | 'new'; id?: string }): StoredJournal {
    const at = this.now().toISOString()
    const j: StoredJournal = {
      id: input.id ?? newJournalId(),
      draftId: input.draftId,
      mode: input.mode,
      status: 'running',
      companyId: null,
      steps: freshSteps(),
      scheduleRefs: [],
      createdAt: at,
      updatedAt: at,
      refs: emptyRefs()
    }
    this.save(j)
    return j
  }

  /** Writes the journal (stamping updatedAt). Synchronous, so it can share a db transaction with the write it records. */
  save(j: StoredJournal): void {
    j.updatedAt = this.now().toISOString()
    this.meta.setMeta(this.key(j.id), JSON.stringify(j))
  }

  /** The latest journal of a draft (any status). */
  forDraft(draftId: string): StoredJournal | null {
    return this.list().find((j) => j.draftId === draftId) ?? null
  }

  /**
   * What onboarding:status reports: the newest running or failed journal (the flow reopens at the Launch step), else
   * the newest journal of any status (so a draft left on a Launch step can be reconciled), else null.
   */
  latest(): StoredJournal | null {
    const all = this.list()
    return all.find((j) => j.status === 'running' || j.status === 'failed') ?? all[0] ?? null
  }

  /**
   * §7.4, on boot: a `running` journal belongs to a launch the app did not finish (quit or crash). It becomes `failed`
   * and its running step carries "Setup was interrupted", so the flow opens at Retry / Discard. Returns the ids.
   * Finished journals older than JOURNAL_KEEP_MS are dropped.
   */
  markInterrupted(): string[] {
    const ids: string[] = []
    const cutoff = this.now().getTime() - JOURNAL_KEEP_MS
    for (const j of this.list()) {
      if ((j.status === 'done' || j.status === 'discarded') && Date.parse(j.updatedAt) < cutoff) {
        this.meta.setMeta(this.key(j.id), null)
        this.meta.setMeta(`${LAUNCH_INPUT_PREFIX}${j.id}`, null)
        continue
      }
      if (j.status !== 'running') continue
      j.status = 'failed'
      for (const s of j.steps) if (s.status === 'running') ((s.status = 'failed'), (s.error = INTERRUPTED_ERROR))
      if (!j.steps.some((s) => s.status === 'failed')) {
        const next = j.steps.find((s) => s.status === 'pending')
        if (next) ((next.status = 'failed'), (next.error = INTERRUPTED_ERROR))
      }
      this.save(j)
      ids.push(j.id)
    }
    return ids
  }

  // ---------- the launch input (no key values: only the stash handle) ----------

  saveInput(id: string, input: LaunchInput): void {
    this.meta.setMeta(`${LAUNCH_INPUT_PREFIX}${id}`, JSON.stringify(input))
  }
  /** The raw stored input (the caller re-validates it with LaunchInputSchema). */
  loadInput(id: string): unknown {
    const raw = this.meta.getMeta(`${LAUNCH_INPUT_PREFIX}${id}`)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  dropInput(id: string): void {
    this.meta.setMeta(`${LAUNCH_INPUT_PREFIX}${id}`, null)
  }
}
