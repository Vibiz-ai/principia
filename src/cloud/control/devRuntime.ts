/**
 * A CloudRuntime that runs nothing: for control plane tests and `PRINCIPIA_RUNTIME=fake` smoke runs (no CLIs, no
 * engine). With `autoComplete`, every started run reports one passed step a moment later.
 */
import type { Id } from '../../shared/types'
import type { CloudRunStep } from '../../shared/cloud'
import type { ChatProcInfo, ChatSink, CloudRuntime, ControlPorts, RepoMaterial, RuntimeRunRequest } from '../contract'
import { adapterOfProfile } from './deps'

export interface DevRuntime extends CloudRuntime {
  readonly started: RuntimeRunRequest[]
  readonly calls: { method: string; args: unknown[] }[]
  readonly running: Set<Id>
  /** finish a started run (tests) */
  finish(runId: Id, status: 'passed' | 'failed' | 'needs_input', summary?: string | null): void
}

export function createDevRuntime(ports: ControlPorts, opts: { autoComplete?: boolean; delayMs?: number } = {}): DevRuntime {
  const started: RuntimeRunRequest[] = []
  const calls: { method: string; args: unknown[] }[] = []
  const running = new Set<Id>()
  const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }) }
  const logs = new Map<Id, string[]>()
  const shapes = new Map<Id, { nodeId: string | null; title: string; adapter: CloudRunStep['adapter'] }>()
  /** the run's first step as the real runtime would name it: the workflow node's label and its agent */
  const shapeOf = (req: RuntimeRunRequest): { nodeId: string | null; title: string; adapter: CloudRunStep['adapter'] } => {
    if (req.target.kind === 'prompt') return { nodeId: null, title: 'Prompt', adapter: req.target.adapter }
    const nodes = (req.workflowFile as { workflow?: { nodes?: { id?: string; label?: string; profileId?: unknown }[] } } | null)?.workflow?.nodes ?? []
    const n = nodes[0]
    return { nodeId: n?.id ?? null, title: n?.label || n?.id || 'Step', adapter: adapterOfProfile(n?.profileId) ?? 'shell' }
  }
  const step = (runId: Id, status: CloudRunStep['status']): CloudRunStep => {
    const s = shapes.get(runId) ?? { nodeId: null, title: 'Step', adapter: 'shell' as const }
    return { id: `${runId}_s1`, nodeId: s.nodeId, title: s.title, adapter: s.adapter, status, startedAt: new Date().toISOString(), endedAt: status === 'running' ? null : new Date().toISOString(), usage: null }
  }
  // cloud chats: an echo process (each stdin line comes back as {"type":"echo","line":…}) that runs at once
  const chatProcs = new Map<string, { info: ChatProcInfo; buf: string; sinks: Set<ChatSink> }>()
  const chatOut = (c: { info: ChatProcInfo; buf: string; sinks: Set<ChatSink> }, d: string) => {
    const at = c.info.out; c.buf += d; c.info.out += d.length
    for (const s of c.sinks) s.out(d, at)
  }
  const chatState = (c: { info: ChatProcInfo; sinks: Set<ChatSink> }) => { for (const s of c.sinks) s.state({ ...c.info }) }
  const chats: CloudRuntime['chats'] = {
    async start(spec) {
      record('chats.start', { ...spec, provider: spec.provider ? { ...spec.provider, value: '<secret>' } : null })
      const prev = chatProcs.get(spec.id)
      const c = { info: { id: spec.id, state: 'running' as const, detail: null, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, signal: null, error: null, repo: null, out: 0 }, buf: '', sinks: prev?.sinks ?? new Set<ChatSink>() }
      chatProcs.set(spec.id, c); chatState(c)
      return { ...c.info }
    },
    attach(id, from, sink) {
      const c = chatProcs.get(id); if (!c) return null
      sink.state({ ...c.info })
      if (from < c.info.out) sink.out(c.buf.slice(from), from)
      c.sinks.add(sink)
      return () => { c.sinks.delete(sink) }
    },
    write(id, data) {
      const c = chatProcs.get(id); if (!c || c.info.state === 'exited') return false
      for (const line of data.split('\n').filter(Boolean)) chatOut(c, JSON.stringify({ type: 'echo', line }) + '\n')
      return true
    },
    end(id) { record('chats.end', id) },
    signal(id, sig) {
      const c = chatProcs.get(id); if (!c || c.info.state === 'exited') return false
      c.info = { ...c.info, state: 'exited', signal: sig, endedAt: new Date().toISOString() }; chatState(c); return true
    },
    async stop(id) { chats.signal(id, 'SIGTERM') },
    async remove(id) { record('chats.remove', id); chats.signal(id, 'SIGTERM'); chatProcs.delete(id) },
    list: () => [...chatProcs.values()].map(c => ({ ...c.info })),
    live: () => [...chatProcs.values()].filter(c => c.info.state !== 'exited').length
  }
  const rt: DevRuntime = {
    version: 'dev-0',
    sandbox: 'process',
    started, calls, running, chats,
    async start() { record('start') },
    async close() { record('close'); for (const id of [...running]) { running.delete(id); ports.runStatus(id, 'canceled', 'shutdown') } },
    health: () => ({ status: 'ok', detail: null }),
    async ensureCompany(c) { record('ensureCompany', c) },
    async removeCompany(ws, cid) { record('removeCompany', ws, cid) },
    validateWorkflow(companyId, file) {
      record('validateWorkflow', companyId)
      const wf = (file as { workflow?: { worktree?: unknown; nodes?: { id?: string; profileId?: unknown }[] } })?.workflow
      const problems: string[] = []
      if (wf?.worktree) problems.push('Worktrees are not available in the cloud yet.')
      for (const n of wf?.nodes ?? []) if (typeof n.profileId === 'string' && !/^prof_(claude|codex|gemini)$/.test(n.profileId)) problems.push(`Step ${n.id ?? '?'} uses a profile the cloud does not know.`)
      return problems
    },
    startRun(req) {
      started.push(req); running.add(req.runId); record('startRun', req.runId)
      shapes.set(req.runId, shapeOf(req))
      ports.runStatus(req.runId, 'running', null)
      ports.runStep(req.runId, step(req.runId, 'running'))
      if (opts.autoComplete) setTimeout(() => rt.finish(req.runId, 'passed', 'Done.'), opts.delayMs ?? 20).unref()
    },
    finish(runId, status, summary = null) {
      if (!running.delete(runId)) return
      const s = shapes.get(runId)
      const lines = [`${s?.title ?? 'Step'} started`, 'This cloud runs with PRINCIPIA_RUNTIME=fake: no agent ran.', summary ?? `Step ${status}.`]
      logs.set(runId, lines)
      ports.runLog(runId, `${runId}_s1`, lines)
      ports.runStep(runId, step(runId, status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'needs_input'))
      ports.runStatus(runId, status, summary)
    },
    async cancelRun(runId) { record('cancelRun', runId); if (running.delete(runId)) ports.runStatus(runId, 'canceled', 'Canceled') },
    runDetail: () => null,
    runLog: (runId, stepId, tail) => { record('runLog', runId, stepId, tail); return (logs.get(runId) ?? []).slice(-Math.max(1, tail)) },
    artifactPath: () => null,
    async answerAsk(askId, answer) { record('answerAsk', askId, answer) },
    async syncRepo(companyId, repo: RepoMaterial) { record('syncRepo', companyId, repo.id); return repo.token === 'bad-token' ? { ok: false, detail: `GitHub said the token cannot read ${repo.url}` } : { ok: true, detail: null } },
    providers: {
      async test(m, o) { record('providers.test', m.adapter, o.live); return { ok: true, detail: `${m.adapter} dev-cli 0.0.0 · credential well-formed` } },
      async cliVersions() { return { claude: 'dev', codex: 'dev', gemini: 'dev' } },
      async startDeviceLogin() { throw new Error('not in v1') },
      deviceLoginStatus: () => null,
      cancelDeviceLogin: () => {}
    },
    forum: { channels: () => [], messages: () => [], post: () => { throw new Error('not in v1') } },
    triggers: {
      reloadSchedules: () => record('reloadSchedules'),
      async webhook() { return { status: 501, runId: null, detail: 'not in v1' } }
    }
  }
  return rt
}
