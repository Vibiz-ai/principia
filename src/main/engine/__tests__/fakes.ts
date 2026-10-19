/** Test doubles: in-memory EngineStore, fake EngineContext, fake agent adapters backed by real `node` processes. */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineContext, EngineStore } from '../../../shared/engine'
import { newId } from '../../../shared/ids'
import type {
  AdapterId,
  AgentProfile,
  EngineEvent,
  ProviderInfo,
  Repo,
  Run,
  RunDetail,
  RunStep,
  Schedule,
  ScheduleEvent,
  Settings,
  Workflow,
  WorkflowDraft
} from '../../../shared/types'
import { ADAPTER_IDS } from '../../../shared/types'
import { DEFAULT_ADAPTERS, type Adapter, type HeadlessRequest } from '../adapters'
import { createClaudeParser } from '../parse'
import { createEngineWith } from '../index'

export class MemStore implements EngineStore {
  runs = new Map<string, Run>()
  snapshots = new Map<string, WorkflowDraft | null>()
  steps = new Map<string, RunStep>()
  schedules = new Map<string, Schedule>()
  events: ScheduleEvent[] = []
  insertRun(run: Run, snap: WorkflowDraft | null): void {
    this.runs.set(run.id, { ...run })
    this.snapshots.set(run.id, snap)
  }
  updateRun(id: string, patch: Partial<Run>): Run {
    const r = { ...this.runs.get(id)!, ...patch }
    this.runs.set(id, r)
    return r
  }
  getRun(id: string): Run | null {
    return this.runs.get(id) ?? null
  }
  getRunDetail(id: string): RunDetail | null {
    const run = this.runs.get(id)
    if (!run) return null
    return { run, steps: this.stepsOf(id), workflow: this.snapshots.get(id) ?? null }
  }
  listRetries(): Run[] {
    return [...this.runs.values()].filter((r) => r.retryAt && !r.retryRunId).sort((a, b) => (a.retryAt! < b.retryAt! ? -1 : 1))
  }
  listActiveRuns(): Run[] {
    return [...this.runs.values()].filter((r) => r.status === 'queued' || r.status === 'running')
  }
  insertStep(s: RunStep): void {
    this.steps.set(s.id, { ...s })
  }
  updateStep(id: string, patch: Partial<RunStep>): RunStep {
    const s = { ...this.steps.get(id)!, ...patch }
    this.steps.set(id, s)
    return s
  }
  stepsOf(runId: string): RunStep[] {
    return [...this.steps.values()].filter((s) => s.runId === runId).sort((a, b) => a.seq - b.seq)
  }
  listSchedules(): Schedule[] {
    return [...this.schedules.values()]
  }
  getSchedule(id: string): Schedule | null {
    return this.schedules.get(id) ?? null
  }
  setScheduleFireState(id: string, patch: Partial<Schedule>): Schedule {
    const s = { ...this.schedules.get(id)!, ...patch }
    this.schedules.set(id, s)
    return s
  }
  insertScheduleEvent(e: Omit<ScheduleEvent, 'id' | 'createdAt'>): ScheduleEvent {
    const ev = { ...e, id: newId('scheduleEvent'), createdAt: new Date().toISOString() }
    this.events.push(ev)
    return ev
  }
}

export const DEFAULT_SETTINGS: Settings = {
  launchAtLogin: false,
  notifyOnSuccess: 'scheduled',
  notifyOnFailure: true,
  notificationSound: true,
  keepAwake: true,
  concurrency: 4,
  defaultAdapter: 'claude',
  lastRepoId: null,
  schedulesPaused: false,
  onboardingDone: false,
  sidebarCollapsed: false,
  terminalFontSize: 13,
  interactiveBypass: false,
  autoRetryRateLimit: true,
  stallMinutes: 10
}

export function profile(id: string, adapter: AdapterId, extra: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    name: id,
    adapter,
    model: null,
    extraArgs: [],
    permissionMode: 'bypass',
    secretNames: ['*'],
    useApiKeyAuth: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra
  }
}

export interface FakeCtx extends EngineContext {
  store: MemStore
  events: EngineEvent[]
  profiles: Map<string, AgentProfile>
  repos: Map<string, Repo>
  workflows: Map<string, Workflow>
  settings: Settings
  secretValues: Record<string, string>
  root: string
  clock: { now: Date | null }
}

export function fakeCtx(): FakeCtx {
  const root = mkdtempSync(join(tmpdir(), 'hive-engine-'))
  const paths = {
    userData: root,
    artifactsRoot: join(root, 'artifacts'),
    runLogsDir: join(root, 'logs', 'runs'),
    scratchDir: join(root, 'scratch'),
    home: join(root, 'home')
  }
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true })
  const ctx: FakeCtx = {
    root,
    paths: { userData: paths.userData, artifactsRoot: paths.artifactsRoot, runLogsDir: paths.runLogsDir, scratchDir: paths.scratchDir },
    store: new MemStore(),
    events: [],
    profiles: new Map(),
    repos: new Map(),
    workflows: new Map(),
    settings: { ...DEFAULT_SETTINGS },
    secretValues: {},
    clock: { now: null },
    baseEnv: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: paths.home, SHELL: '/bin/sh' }),
    secrets: {
      resolve(names) {
        const all = ctx.secretValues
        if (names.includes('*')) return { ...all }
        return Object.fromEntries(names.filter((n) => n in all).map((n) => [n, all[n]]))
      },
      names(names) {
        return Object.keys(ctx.secretValues).filter((n) => names.includes('*') || names.includes(n))
      },
      redact(text) {
        let t = text
        for (const [k, v] of Object.entries(ctx.secretValues)) if (v.length >= 4) t = t.split(v).join(`••••${k}`)
        return t
      }
    },
    getSettings: () => ctx.settings,
    getProfile: (id) => ctx.profiles.get(id) ?? null,
    getRepo: (id) => ctx.repos.get(id) ?? null,
    getWorkflow: (id) => ctx.workflows.get(id) ?? null,
    emit: (e) => void ctx.events.push(e),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => ctx.clock.now ?? new Date()
  }
  return ctx
}

export function addWorkflow(ctx: FakeCtx, draft: WorkflowDraft): Workflow {
  const wf: Workflow = { ...draft, id: newId('workflow'), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  ctx.workflows.set(wf.id, wf)
  return wf
}

// ---------- fake agent adapter ----------

export interface FakeReply {
  output?: string
  exitCode?: number
  delayMs?: number
  isError?: boolean
  /** Print this env var's value (or "<unset>") into the output, for env assertions. */
  echoEnv?: string[]
}
export interface FakeCall extends HeadlessRequest {
  adapter: AdapterId
  n: number
}

/**
 * Emits Claude-style stream-json from a real `node` child, so the real runner, parser, kill and env paths run.
 * argv[1] = JSON reply.
 */
const FAKE_SCRIPT = `
const r = JSON.parse(process.argv[1]);
let text = r.output ?? 'ok';
for (const k of r.echoEnv ?? []) text += '\\n' + k + '=' + (process.env[k] ?? '<unset>');
const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
w({ type: 'system', subtype: 'init', session_id: r.sid });
setTimeout(() => {
  w({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }, { type: 'text', text }] } });
  w({ type: 'result', subtype: r.isError ? 'error_during_execution' : 'success', is_error: !!r.isError, result: text, total_cost_usd: 0.001, num_turns: 1, usage: { input_tokens: 3, output_tokens: 1 } });
  process.exit(r.exitCode ?? 0);
}, r.delayMs ?? 0);
`

/** Steps really run in /bin/sh, so a fake output that deletes things will actually delete things. */
const DESTRUCTIVE = /\brm\s+-[a-z]*[rf]|\bmkfs\b|\bdd\s+if=|>\s*\/dev\/sd|\bshutdown\b|\bsudo\b|:\(\)\s*\{/i
function assertHarmless(output: string | undefined): void {
  if (output && DESTRUCTIVE.test(output)) throw new Error(`fake agent output looks destructive, refusing: ${output}`)
}

export function fakeAdapter(
  id: AdapterId,
  calls: FakeCall[],
  respond: (req: HeadlessRequest, n: number) => FakeReply,
  canResume = id === 'claude'
): Adapter {
  const base = DEFAULT_ADAPTERS[id]
  let n = 0
  return {
    ...base,
    canResume,
    headless(req) {
      n++
      calls.push({ ...req, adapter: id, n })
      const sid = req.resumeId ?? (canResume ? `sess-${id}-${n}` : null)
      const reply = respond(req, n)
      assertHarmless(reply.output)
      return { args: ['-e', FAKE_SCRIPT, JSON.stringify({ ...reply, sid })], agentSessionId: sid }
    },
    createParser: createClaudeParser
  }
}

export function fakeProviders(available: AdapterId[] = [...ADAPTER_IDS]): () => Promise<ProviderInfo[]> {
  return async () =>
    ADAPTER_IDS.map((id) => ({
      id,
      label: DEFAULT_ADAPTERS[id].label,
      available: available.includes(id),
      version: '1.0.0',
      binPath: available.includes(id) ? (id === 'shell' ? '/bin/sh' : process.execPath) : null,
      installHint: DEFAULT_ADAPTERS[id].installHint,
      checkedAt: new Date().toISOString()
    }))
}

/** Engine with fake detection, already init()ed (so the real PATH is never consulted). */
export async function makeEngine(
  ctx: FakeCtx,
  opts: { adapters?: Partial<Record<AdapterId, Adapter>>; available?: AdapterId[] } = {}
) {
  const engine = createEngineWith(ctx, { adapters: opts.adapters, detect: fakeProviders(opts.available) })
  await engine.init()
  return engine
}

export async function waitRun(ctx: FakeCtx, runId: string, timeoutMs = 15000): Promise<Run> {
  const t0 = Date.now()
  for (;;) {
    const r = ctx.store.getRun(runId)!
    if (r.status !== 'queued' && r.status !== 'running') return r
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} still ${r.status}`)
    await new Promise((res) => setTimeout(res, 20))
  }
}
