/**
 * SLACK.md §13.2 (AI): Slack triggers, `{{trigger.*}}`, reply binding, the slack toolset for headless claude.
 * A fake SlackBridge feeds FakeSlack-shaped SlackInboundMessages; no network, no sockets.
 */
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, SlackBridge, SlackTriggerState } from '../../../shared/engine'
import { newId } from '../../../shared/ids'
import type { SlackInboundMessage, SlackTrigger, SlackTriggerEvent, SlackTriggerInput } from '../../../shared/slack'
import type { AgentNode, Run, RunTarget, ShellNode, Workflow, WorkflowDraft } from '../../../shared/types'
import { claudeAdapter } from '../adapters'
import {
  createSlackTriggers,
  describeSlackTrigger,
  hardDrop,
  lastAgentNode,
  matchSlackTrigger,
  normalizeSlackTriggerInput,
  replyText,
  threadKeyOf,
  UNTRUSTED_SLACK_NOTE
} from '../slackTriggers'
import { render } from '../templates'
import { regexProbe, validateSlackTrigger, validateWorkflow } from '../validate'
import { MemStore, addWorkflow, fakeAdapter, fakeCtx, makeEngine, profile, waitRun, type FakeCall, type FakeCtx } from './fakes'
import { fakeBridge } from './liveFakes'

// ---------- fakes ----------

class SlackStore extends MemStore {
  triggers: SlackTrigger[] = []
  stateRows = new Map<string, SlackTriggerState>()
  trigEvents: SlackTriggerEvent[] = []
  listSlackTriggers(): SlackTrigger[] {
    return this.triggers.map((t) => ({ ...t }))
  }
  getSlackTriggerState(triggerId: string, channelId: string, threadKey: string): SlackTriggerState | null {
    return this.stateRows.get(`${triggerId}|${channelId}|${threadKey}`) ?? null
  }
  putSlackTriggerState(s: SlackTriggerState): void {
    this.stateRows.set(`${s.triggerId}|${s.channelId}|${s.threadKey}`, { ...s })
  }
  listSlackTriggerStates(): SlackTriggerState[] {
    return [...this.stateRows.values()]
  }
  insertSlackTriggerEvent(e: Omit<SlackTriggerEvent, 'id' | 'createdAt'>): SlackTriggerEvent {
    const ev = { ...e, id: newId('slackTriggerEvent'), createdAt: new Date().toISOString() }
    this.trigEvents.push(ev)
    return ev
  }
  kinds(): string[] {
    return this.trigEvents.map((e) => e.kind)
  }
}

interface FakeSlackBridge extends SlackBridge {
  emit(m: SlackInboundMessage): void
  replies: Parameters<SlackBridge['reply']>[0][]
  alerts: { triggerId: string; title: string; message: string }[]
  toolCalls: { stepId: string; runId: string }[]
  repliedRuns: Map<string, number>
  isConnected: boolean
  transcript: string
  mirror: Map<string, { userId: string | null; userName: string | null; plain: string }>
}

function fakeSlack(): FakeSlackBridge {
  const cbs = new Set<(m: SlackInboundMessage) => void>()
  const b: FakeSlackBridge = {
    replies: [],
    alerts: [],
    toolCalls: [],
    repliedRuns: new Map(),
    isConnected: true,
    transcript: '[2026-10-16 09:14] Dana Lee: how do I reset my password?',
    mirror: new Map(),
    connected: () => b.isConnected,
    onMessage(cb) {
      cbs.add(cb)
      return () => void cbs.delete(cb)
    },
    emit: (m) => cbs.forEach((cb) => cb(m)),
    threadTranscript: () => b.transcript,
    permalink: async (c, ts) => `https://acme.slack.com/archives/${c}/p${ts.replace('.', '')}`,
    resolveUserName: (id) => (id === 'U1' ? 'Dana Lee' : id),
    async reply(req) {
      b.replies.push(req)
      return { status: 'drafted', draftId: 'sdr_1' }
    },
    repliesForRun: (runId) => b.repliedRuns.get(runId) ?? 0,
    toolServer(owner) {
      b.toolCalls.push(owner)
      const spec: McpServerSpec = { name: 'hive', command: process.execPath, args: ['/x/hive-mcp.js'], env: { HIVE_TOOLSETS: 'slack' } }
      return spec
    },
    message: (q) => b.mirror.get(`${q.channelId}:${q.ts}`) ?? null,
    alert: (a) => void b.alerts.push(a)
  }
  return b
}

let tsSeq = 1_760_000_000
const nextTs = (): string => `${++tsSeq}.000100`

function msg(x: Partial<SlackInboundMessage> = {}): SlackInboundMessage {
  const ts = x.ts ?? nextTs()
  const nowMs = Date.now()
  return {
    teamId: 'T1',
    channelId: 'C1',
    channelKind: 'channel',
    channelName: 'support',
    ts,
    threadTs: null,
    userId: 'U1',
    userName: 'Dana Lee',
    botId: null,
    subtype: null,
    plain: '@hive how do I reset my password?',
    isMention: true,
    isDmToBot: false,
    isOwn: false,
    fromBot: false,
    eventTime: Math.floor(nowMs / 1000),
    receivedAt: nowMs,
    source: 'event',
    catchup: false,
    ...x
  }
}

function trig(workflowId: string, x: Partial<SlackTrigger> = {}, match: Partial<SlackTrigger['match']> = {}): SlackTrigger {
  return {
    id: x.id ?? newId('slackTrigger'),
    name: 'Support bot',
    workflowId,
    enabled: true,
    match: { on: ['mention'], channels: ['C1'], keywords: [], regex: null, fromUsers: [], ...match },
    reply: { mode: 'draft', autoChannels: [], replyNode: null },
    limits: { debounceSec: 0, maxRunsPerThreadPerHour: 4 },
    inputs: { question: '{{trigger.text}}', who: '{{trigger.user}} in {{trigger.channel}}' },
    access: { fullPermissions: false, secretNames: [] },
    origin: null,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    sentence: '',
    lastFiredAt: null,
    lastRunId: null,
    lastRunStatus: null,
    ...x
  }
}

/** Unit harness: createSlackTriggers over a fake startRun whose runs the test ends by hand. */
function unit(opts: { triggers?: (wfId: string) => SlackTrigger[] } = {}) {
  const store = new SlackStore()
  const slack = fakeSlack()
  const runs = new Map<string, Run>()
  const started: { target: RunTarget; slack: Run['slack'] }[] = []
  const settings = { schedulesPaused: false, slackTriggerCatchupMin: 10 } as ReturnType<FakeCtx['getSettings']>
  const wf = { id: 'wf_1', name: 'Support answers', nodes: [], inputs: [], description: '' } as unknown as Workflow
  store.triggers = opts.triggers?.(wf.id) ?? [trig(wf.id)]
  const st = createSlackTriggers({
    store,
    slack,
    getWorkflow: () => wf,
    getSettings: () => settings,
    startRun(target, o) {
      const run = { id: newId('run'), status: 'running', trigger: o.trigger, slack: o.slack ?? null, target } as Run
      runs.set(run.id, run)
      started.push({ target, slack: o.slack ?? null })
      return run
    },
    getRun: (id) => runs.get(id) ?? null,
    activeRuns: () => [...runs.values()].filter((r) => r.status === 'running'),
    emit: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => new Date()
  })
  const end = async (runId: string, status: Run['status'] = 'passed'): Promise<void> => {
    const r = { ...runs.get(runId)!, status }
    runs.set(runId, r)
    await st.runEnded(r)
  }
  return { store, slack, runs, started, settings, st, end, wf }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// ---------- 1, 2: firing, dedupe, loop guards ----------

describe('slack triggers: firing and loop guards', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00.000Z') }))
  afterEach(() => vi.useRealTimers())

  it('a mention in an allowed channel starts one run with the inputs rendered; mention + message for one ts → one run', async () => {
    const u = unit()
    u.st.start()
    const m = msg()
    u.slack.emit({ ...m }) // app_mention
    u.slack.emit({ ...m }) // message.channels for the same ts
    await flush()
    expect(u.started).toHaveLength(1)
    expect(u.started[0]!.target).toEqual({
      kind: 'workflow',
      workflowId: 'wf_1',
      inputs: { question: '@hive how do I reset my password?', who: 'Dana Lee in #support' }
    })
    expect(u.started[0]!.slack).toMatchObject({
      channelId: 'C1',
      channelKind: 'channel',
      threadTs: m.ts,
      messageTs: [m.ts],
      userId: 'U1',
      userName: 'Dana Lee',
      isMention: true,
      isDm: false,
      permalink: `https://acme.slack.com/archives/C1/p${m.ts.replace('.', '')}`
    })
    expect(u.store.kinds()).toEqual(['fired'])
    // a mention in a channel the trigger does not list
    u.slack.emit(msg({ channelId: 'C9', channelName: 'random' }))
    await flush()
    expect(u.started).toHaveLength(1)
  })

  it("never fires on Hive's own messages (bot user, bot id, hive_ref, hive_post metadata) and logs nothing", async () => {
    const u = unit()
    u.st.start()
    u.slack.emit(msg({ isOwn: true, userId: 'UBOT', botId: 'BBOT' }))
    u.slack.emit(msg({ isOwn: true, subtype: 'bot_message', botId: 'BBOT' }))
    await flush()
    expect(u.started).toHaveLength(0)
    expect(u.store.trigEvents).toHaveLength(0)
  })

  it('another bot → skipped_bot; edits / joins / backfill never trigger', async () => {
    const u = unit()
    u.st.start()
    u.slack.emit(msg({ fromBot: true, botId: 'BOTHER', userId: 'UOTHER' }))
    u.slack.emit(msg({ subtype: 'message_changed' }))
    u.slack.emit(msg({ subtype: 'channel_join' }))
    u.slack.emit(msg({ source: 'backfill' as never }))
    u.slack.emit(msg({ source: 'gapfill', catchup: false }))
    await flush()
    expect(u.started).toHaveLength(0)
    expect(u.store.kinds()).toEqual(['skipped_bot'])
  })

  it('stale and paused messages are logged, not run; gap-fill catch-up runs', async () => {
    const u = unit()
    u.st.start()
    u.slack.emit(msg({ eventTime: Math.floor(Date.now() / 1000) - 300 }))
    u.settings.schedulesPaused = true
    u.slack.emit(msg())
    u.settings.schedulesPaused = false
    u.slack.isConnected = true
    u.slack.emit(msg({ source: 'gapfill', catchup: true, eventTime: Math.floor(Date.now() / 1000) - 300 }))
    await flush()
    expect(u.store.kinds()).toEqual(['skipped_stale', 'skipped_paused', 'fired'])
    expect(u.started[0]!.slack!.catchup).toBe(true)
  })
})

// ---------- 3: debounce, coalesce ----------

describe('slack triggers: debounce and one active run per thread', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00.000Z') }))
  afterEach(() => vi.useRealTimers())

  it('3 messages in 10 s → one run with all 3 in trigger.text; a message during the run → exactly one follow-up run', async () => {
    const u = unit({ triggers: (w) => [trig(w, { limits: { debounceSec: 3, maxRunsPerThreadPerHour: 4 } })] })
    u.st.start()
    const parent = msg({ plain: 'first' })
    u.slack.emit(parent)
    await vi.advanceTimersByTimeAsync(2000)
    u.slack.emit(msg({ threadTs: parent.ts, plain: 'second' }))
    await vi.advanceTimersByTimeAsync(2000)
    u.slack.emit(msg({ threadTs: parent.ts, plain: 'third' }))
    expect(u.started).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(u.started).toHaveLength(1)
    expect(u.started[0]!.target).toMatchObject({ inputs: { question: 'first\n\nsecond\n\nthird' } })
    expect(u.started[0]!.slack!.messageTs).toHaveLength(3)
    expect(u.started[0]!.slack!.threadTs).toBe(parent.ts)
    expect(u.store.kinds()).toEqual(['debounced', 'debounced', 'fired'])

    // typed while the run works: coalesced, then one follow-up after the run ends
    const runId = [...u.runs.keys()][0]!
    u.slack.emit(msg({ threadTs: parent.ts, plain: 'also this' }))
    u.slack.emit(msg({ threadTs: parent.ts, plain: 'and this' }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(u.started).toHaveLength(1)
    await u.end(runId)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(u.started).toHaveLength(2)
    expect(u.started[1]!.target).toMatchObject({ inputs: { question: 'also this\n\nand this' } })
    expect(u.store.kinds().filter((k) => k === 'coalesced')).toHaveLength(2)
  })

  it('the window is capped at 3 × debounce from its start (trailing debounce with a max wait)', async () => {
    const u = unit({ triggers: (w) => [trig(w, { limits: { debounceSec: 3, maxRunsPerThreadPerHour: 4 } })] })
    u.st.start()
    const parent = msg()
    u.slack.emit(parent)
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(2000)
      u.slack.emit(msg({ threadTs: parent.ts, plain: `m${i}` }))
    }
    // 12 s of chatter, but the window started at 0 and caps at 9 s
    expect(u.started).toHaveLength(1)
  })

  it('a DM is one conversation (PO-S4): top-level DMs share the key dm:<channel> and are debounced together', async () => {
    const u = unit({ triggers: (w) => [trig(w, { limits: { debounceSec: 3, maxRunsPerThreadPerHour: 4 } }, { on: ['dm'], channels: [] })] })
    u.st.start()
    const dm = { channelId: 'D1', channelKind: 'dm' as const, channelName: 'Dana Lee', isDmToBot: true, isMention: false }
    u.slack.emit(msg({ ...dm, plain: 'hi' }))
    await vi.advanceTimersByTimeAsync(1000)
    u.slack.emit(msg({ ...dm, plain: 'are you there?' }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(u.started).toHaveLength(1)
    expect(u.started[0]!.slack).toMatchObject({ isDm: true, channelKind: 'dm' })
    expect(u.started[0]!.target).toMatchObject({ inputs: { question: 'hi\n\nare you there?', who: 'Dana Lee in DM with Dana Lee' } })
    expect(u.st.states()[0]!.threadKey).toBe('dm:D1')
    expect(threadKeyOf(msg({ ...dm }))).toBe('dm:D1')
    expect(threadKeyOf(msg({ channelKind: 'group_dm', channelId: 'G1' }))).toBe('dm:G1')
    expect(threadKeyOf(msg({ threadTs: '1.1', ts: '2.2' }))).toBe('1.1')
  })
})

// ---------- 4: limits ----------

describe('slack triggers: limits', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00.000Z') }))
  afterEach(() => vi.useRealTimers())

  it('the 5th run in an hour for one thread → skipped_limit + one notification', async () => {
    const u = unit()
    u.st.start()
    const parent = msg()
    u.slack.emit(parent)
    await flush()
    for (let i = 0; i < 6; i++) {
      await u.end([...u.runs.keys()].at(-1)!)
      u.slack.emit(msg({ threadTs: parent.ts, plain: `again ${i}` }))
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(u.started).toHaveLength(4)
    expect(u.store.kinds().filter((k) => k === 'skipped_limit')).toHaveLength(3)
    expect(u.slack.alerts).toHaveLength(1)
    expect(u.slack.alerts[0]!.message).toBe("Slack trigger 'Support bot' hit its limit (4 runs per thread per hour)")
    // an hour later the thread may run again
    await vi.advanceTimersByTimeAsync(61 * 60_000)
    u.slack.emit(msg({ threadTs: parent.ts, plain: 'later' }))
    await vi.advanceTimersByTimeAsync(100)
    expect(u.started).toHaveLength(5)
  })

  it('spam soak: 200 mentions in an hour from 50 users and threads → at most 30 runs (fixed per trigger); the rest skipped_limit', async () => {
    const u = unit()
    u.st.start()
    for (let i = 0; i < 200; i++) {
      u.slack.emit(msg({ userId: `U${100 + (i % 50)}`, userName: `user${i % 50}`, plain: `@hive help ${i}` }))
      await vi.advanceTimersByTimeAsync(15_000)
      for (const r of u.runs.values()) if (r.status === 'running') await u.end(r.id)
    }
    expect(u.started.length).toBe(30)
    expect(u.store.kinds().filter((k) => k === 'skipped_limit')).toHaveLength(170)
    expect(u.slack.alerts).toHaveLength(1)
  })

  it('at most 4 Slack-triggered runs active across Hive; a 5th window re-arms in 30 s', async () => {
    const u = unit()
    u.st.start()
    for (let i = 0; i < 5; i++) u.slack.emit(msg({ plain: `t${i}` }))
    await flush()
    expect(u.started).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(u.started).toHaveLength(4)
    await u.end([...u.runs.keys()][0]!)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(u.started).toHaveLength(5)
  })

  it('a workflow that fails to start → error event + one notification per hour', async () => {
    const u = unit()
    u.st.start()
    const bad = createSlackTriggers({
      store: u.store,
      slack: u.slack,
      getWorkflow: () => null,
      getSettings: () => u.settings,
      startRun: () => {
        throw new Error('Workflow "x" is invalid')
      },
      getRun: () => null,
      activeRuns: () => [],
      emit: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => new Date()
    })
    u.st.stop()
    bad.start()
    u.slack.emit(msg())
    u.slack.emit(msg())
    await flush()
    expect(u.store.kinds()).toEqual(['error', 'error'])
    expect(u.slack.alerts).toHaveLength(1)
  })
})

// ---------- 5: matching ----------

describe('slack triggers: matching', () => {
  const t = (match: Partial<SlackTrigger['match']>) => trig('wf', {}, match)
  it('keywords (word boundaries, case-insensitive), regex, fromUsers are ANDed', () => {
    const m = msg({ plain: 'Deploy is BROKEN again' })
    expect(matchSlackTrigger(t({ keywords: ['broken'] }), m).ok).toBe(true)
    expect(matchSlackTrigger(t({ keywords: ['broke'] }), m).ok).toBe(false)
    expect(matchSlackTrigger(t({ keywords: ['nope', 'deploy'] }), m).ok).toBe(true)
    expect(matchSlackTrigger(t({ regex: 'deploy\\s+is' }), m).ok).toBe(true)
    expect(matchSlackTrigger(t({ regex: '^broken' }), m).ok).toBe(false)
    expect(matchSlackTrigger(t({ fromUsers: ['U1'] }), m).ok).toBe(true)
    expect(matchSlackTrigger(t({ fromUsers: ['U2'] }), m).ok).toBe(false)
    expect(matchSlackTrigger(t({ keywords: ['broken'], regex: 'again$', fromUsers: ['U1'] }), m).ok).toBe(true)
    expect(matchSlackTrigger(t({ keywords: ['broken'], regex: 'again$', fromUsers: ['U2'] }), m).ok).toBe(false)
  })
  it('on: mention (channels empty = any), dm, message (needs channels)', () => {
    expect(matchSlackTrigger(t({ on: ['mention'], channels: [] }), msg({ channelId: 'C77' })).ok).toBe(true)
    expect(matchSlackTrigger(t({ on: ['mention'] }), msg({ isMention: false })).ok).toBe(false)
    expect(matchSlackTrigger(t({ on: ['message'] }), msg({ isMention: false })).ok).toBe(true)
    expect(matchSlackTrigger(t({ on: ['message'] }), msg({ isMention: false, channelId: 'C2' })).ok).toBe(false)
    expect(matchSlackTrigger(t({ on: ['dm'], channels: [] }), msg({ isMention: false, isDmToBot: true, channelKind: 'dm' })).ok).toBe(true)
    expect(matchSlackTrigger(t({ on: ['dm'], channels: [] }), msg({ isMention: false })).ok).toBe(false)
  })
  it('hard drops', () => {
    expect(hardDrop(msg())).toBeNull()
    expect(hardDrop(msg({ subtype: 'thread_broadcast' }))).toBeNull()
    expect(hardDrop(msg({ subtype: 'file_share' }))).toBeNull()
    expect(hardDrop(msg({ isOwn: true }))).toMatch(/own/)
    expect(hardDrop(msg({ subtype: 'message_deleted' }))).toMatch(/Subtype/)
  })
})

// ---------- validation (5, 6) ----------

describe('slack triggers: save-time validation', () => {
  const wf: WorkflowDraft = {
    name: 'w',
    description: '',
    inputs: [
      { name: 'question', label: 'Q' },
      { name: 'cmd', label: 'C', default: 'ls' },
      { name: 'repo', label: 'R', type: 'repo', default: 'repo_x' },
      { name: 'dry_run', label: 'D', type: 'boolean', default: 'true' }
    ],
    nodes: [
      { id: 'answer', type: 'agent', label: 'a', after: [], cwd: null, timeoutMin: 5, profileId: 'p', prompt: '{{inputs.question}}' } as AgentNode,
      { id: 'run', type: 'shell', label: 's', after: ['answer'], cwd: null, timeoutMin: 5, command: 'echo {{inputs.cmd}}' } as ShellNode
    ]
  }
  const input = (x: Partial<SlackTriggerInput> = {}, match: Partial<SlackTriggerInput['match']> = {}): SlackTriggerInput => ({
    name: 'Support',
    workflowId: 'wf',
    match: { on: ['mention'], channels: [], keywords: [], regex: null, fromUsers: [], ...match },
    reply: { mode: 'draft', autoChannels: [] },
    inputs: { question: '{{trigger.text}}' },
    ...x
  })
  const v = (i: SlackTriggerInput) => validateSlackTrigger(i, { workflow: wf }).map((e) => e.message)

  it('accepts a plain mention trigger', () => {
    expect(v(input())).toEqual([])
  })
  it('a catastrophic regex is rejected at save; a sane one passes', () => {
    expect(v(input({}, { regex: '(a+)+$' })).join()).toMatch(/catastrophic/)
    expect(v(input({}, { regex: '(x+x+)+y' })).join()).toMatch(/catastrophic/)
    expect(v(input({}, { regex: '(' })).join()).toMatch(/not valid/)
    expect(v(input({}, { regex: 'deploy (failed|broken)' }))).toEqual([])
    expect(regexProbe('^\\d+$')).toBeNull()
  })
  it('PO-S3c: auto on any message without a filter fails; with a keyword it passes; auto needs an allow-list', () => {
    const auto = { reply: { mode: 'auto' as const, autoChannels: ['C0SUPPORT', 'dm'] } }
    expect(v(input(auto, { on: ['message'], channels: ['C0SUPPORT'] })).join()).toMatch(/keyword, regex or person/)
    expect(v(input(auto, { on: ['message'], channels: ['C0SUPPORT'], keywords: ['deploy'] }))).toEqual([])
    expect(v(input(auto, { on: ['mention', 'dm'] }))).toEqual([])
    expect(v(input({ reply: { mode: 'auto', autoChannels: [] } })).join()).toMatch(/allow-listed/)
  })
  it('message needs channels; ids are checked; limits are ranged', () => {
    expect(v(input({}, { on: ['message'] })).join()).toMatch(/at least one channel/)
    expect(v(input({}, { channels: ['#support'] })).join()).toMatch(/not a channel id/)
    expect(v(input({}, { fromUsers: ['@dana'] })).join()).toMatch(/not a user id/)
    expect(v(input({ limits: { debounceSec: 601 } })).join()).toMatch(/0-600/)
    expect(v(input({ limits: { maxRunsPerThreadPerHour: 31 } })).join()).toMatch(/1-30/)
    expect(v(input({}, { on: [] })).join()).toMatch(/Pick when it fires/)
  })
  it('inputs: only {{trigger.*}}; unmapped required inputs; never into a command, a repo or a checkbox', () => {
    expect(v(input({ inputs: {} })).join()).toMatch(/"question" has no default/)
    expect(v(input({ inputs: { question: '{{inputs.cmd}}' } })).join()).toMatch(/not allowed here/)
    expect(v(input({ inputs: { question: 'x', cmd: '{{trigger.text}}' } })).join()).toMatch(/used in a command: Slack text is untrusted/)
    expect(v(input({ inputs: { question: 'x', repo: '{{trigger.text}}' } })).join()).toMatch(/Slack text cannot choose it/)
    expect(v(input({ inputs: { question: 'x', dry_run: '{{trigger.text}}' } })).join()).toMatch(/checkbox/)
    expect(v(input({ inputs: { question: 'x', dry_run: 'false' } }))).toEqual([])
    expect(v(input({ inputs: { question: 'x', nope: 'y' } })).join()).toMatch(/not an input/)
  })
  it('replyNode must exist and not be a notify/check', () => {
    expect(v(input({ reply: { mode: 'draft', autoChannels: [], replyNode: 'ghost' } })).join()).toMatch(/not in the workflow/)
    expect(v(input({ reply: { mode: 'draft', autoChannels: [], replyNode: 'answer' } }))).toEqual([])
  })
  it('normalize: replyNode defaults to the last agent node (PO-S10); debounce 3 s mention/DM, 15 s message', () => {
    const n = normalizeSlackTriggerInput(input(), wf)
    expect(n.reply.replyNode).toBe('answer')
    expect(n.limits).toEqual({ debounceSec: 3, maxRunsPerThreadPerHour: 4 })
    expect(normalizeSlackTriggerInput(input({}, { on: ['message'], channels: ['C0SUPPORT'] }), wf).limits.debounceSec).toBe(15)
    expect(normalizeSlackTriggerInput(input({ reply: { mode: 'draft', autoChannels: [], replyNode: null } }), wf).reply.replyNode).toBeNull()
    expect(lastAgentNode({ nodes: [] })).toBeNull()
  })
  it('the trigger sentence', () => {
    const s = describeSlackTrigger(normalizeSlackTriggerInput(input({}, { channels: ['C1'] }), wf), { channel: () => 'support' })
    expect(s).toBe('When @hive is mentioned in #support · replies as drafts')
    const a = describeSlackTrigger(
      normalizeSlackTriggerInput(input({ reply: { mode: 'auto', autoChannels: ['C1', 'dm'] } }, { on: ['mention', 'dm'], channels: ['C1'] }), wf),
      { channel: () => 'support' }
    )
    expect(a).toBe('When @hive is mentioned in #support or someone DMs @hive · AUTO-replies in #support or DMs')
  })
})

describe('{{trigger.*}} templates (SLACK.md §9.2)', () => {
  const sh = (command: string): ShellNode => ({ id: 's', type: 'shell', label: 's', after: [], cwd: null, timeoutMin: 5, command })
  const draft = (nodes: WorkflowDraft['nodes']): WorkflowDraft => ({ name: 'w', description: '', inputs: [], nodes })
  const deps = { getProfile: () => ({ id: 'p', adapter: 'claude' }) as never, getRepo: () => null }
  it('{{trigger.*}} in a shell / wait / check command is an error for every workflow', () => {
    const errs = validateWorkflow(draft([sh('echo {{trigger.text}}')]), deps).map((e) => e.message)
    expect(errs).toContain('Node "s": {{trigger.text}} in command: Slack text is untrusted; pass it through a file or an agent prompt')
    const agent = { id: 'a', type: 'agent', label: 'a', after: [], cwd: null, timeoutMin: 5, profileId: 'p', prompt: 'Reply to {{trigger.user}}: {{trigger.text}}' } as AgentNode
    expect(validateWorkflow(draft([agent]), deps)).toEqual([])
    expect(validateWorkflow(draft([sh('echo {{trigger.nope}}')]), deps).map((e) => e.message).join()).toMatch(/not a valid template/)
  })
  it('renders "" outside Slack runs', () => {
    const scope = { inputs: {}, nodeOutput: () => null, nodeTranscript: () => null, artifactsDir: '/a' }
    expect(render('[{{trigger.text}}|{{trigger.permalink}}]', scope)).toBe('[|]')
  })
  it('replyText strips a trailing HIVE_STOP line', () => {
    expect(replyText('Answer\n\nHIVE_STOP: nope')).toBe('Answer')
    expect(replyText('  hello  ')).toBe('hello')
    expect(replyText(null)).toBe('')
  })
})

// ---------- 8: restart ----------

describe('slack triggers: restart', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00.000Z') }))
  afterEach(() => vi.useRealTimers())

  it('a window that ended while Hive was off fires when fresh, else skipped_stale; a dead active run is cleared', async () => {
    const u = unit()
    const t = u.store.triggers[0]!
    const nowS = Math.floor(Date.now() / 1000)
    const fresh = `${nowS - 60}.000100`
    const old = `${nowS - 3600}.000100`
    u.slack.mirror.set(`C1:${fresh}`, { userId: 'U1', userName: 'Dana Lee', plain: 'still there?' })
    u.store.putSlackTriggerState({ triggerId: t.id, channelId: 'C1', threadKey: fresh, pending: [fresh], windowEndsAt: new Date(Date.now() - 5000).toISOString(), activeRunId: null, firedAt: [] })
    u.store.putSlackTriggerState({ triggerId: t.id, channelId: 'C1', threadKey: old, pending: [old], windowEndsAt: new Date(Date.now() - 5000).toISOString(), activeRunId: null, firedAt: [] })
    u.store.putSlackTriggerState({ triggerId: t.id, channelId: 'C1', threadKey: '1.1', pending: [], windowEndsAt: null, activeRunId: 'r_gone', firedAt: [] })
    u.st.start()
    await flush()
    expect(u.started).toHaveLength(1)
    expect(u.started[0]!.target).toMatchObject({ inputs: { question: 'still there?' } })
    expect(u.started[0]!.slack!.catchup).toBe(true)
    expect(u.store.kinds()).toEqual(['skipped_stale', 'fired'])
    expect(u.store.getSlackTriggerState(t.id, 'C1', '1.1')!.activeRunId).toBeNull()
  })

  it('a window still open at boot fires on time', async () => {
    const u = unit()
    const t = u.store.triggers[0]!
    const ts = `${Math.floor(Date.now() / 1000)}.000100`
    u.store.putSlackTriggerState({ triggerId: t.id, channelId: 'C1', threadKey: ts, pending: [ts], windowEndsAt: new Date(Date.now() + 2000).toISOString(), activeRunId: null, firedAt: [] })
    u.st.start()
    await flush()
    expect(u.started).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2500)
    expect(u.started).toHaveLength(1)
  })
})

// ---------- test() ----------

describe('slackTriggers.test (never starts a run)', () => {
  it('reports the reasons and the rendered inputs', () => {
    const u = unit()
    const r = u.st.test(
      { name: 'x', workflowId: 'wf_1', match: { on: ['mention'], channels: [], keywords: ['password'], regex: null, fromUsers: [] }, reply: { mode: 'draft', autoChannels: [] }, inputs: { question: '{{trigger.text}}' } },
      msg()
    )
    expect(r.fires).toBe(true)
    expect(r.inputs).toEqual({ question: '@hive how do I reset my password?' })
    expect(r.reasons.join(' ')).toMatch(/Keyword "password" found/)
    const r2 = u.st.test({ name: 'x', workflowId: 'wf_1', match: { on: ['mention'], channels: [], keywords: [], regex: null, fromUsers: [] }, reply: { mode: 'draft', autoChannels: [] } }, msg({ fromBot: true }))
    expect(r2.fires).toBe(false)
    expect(u.started).toHaveLength(0)
  })
})

// ---------- 7 + run wiring: the real engine ----------

describe('slack-triggered runs in the engine (reply binding, env, tools, untrusted note)', () => {
  const agentNode = (prompt: string, x: Partial<AgentNode> = {}): AgentNode => ({
    id: 'answer',
    type: 'agent',
    label: 'Answer',
    after: [],
    cwd: null,
    timeoutMin: 5,
    profileId: 'p_claude',
    prompt,
    ...x
  })

  async function setup(
    reply: (n: number) => { output?: string; exitCode?: number },
    opts: {
      replyNode?: string | null
      mode?: 'draft' | 'auto' | 'none'
      dm?: boolean
      slackTools?: boolean
      echo?: boolean | string[]
      access?: SlackTrigger['access']
      adapter?: 'claude' | 'codex'
    } = {}
  ) {
    const ctx = fakeCtx()
    const store = new SlackStore()
    ctx.store = store as never
    ctx.live = fakeBridge(ctx.root)
    const slack = fakeSlack()
    ctx.slack = slack
    ctx.profiles.set('p_claude', profile('p_claude', 'claude'))
    const calls: FakeCall[] = []
    const mcpFiles: string[] = []
    const claude = fakeAdapter('claude', calls, (req, n) => {
      const i = req.mcpArgs?.indexOf('--mcp-config') ?? -1
      if (i >= 0 && existsSync(req.mcpArgs![i + 1]!)) mcpFiles.push(readFileSync(req.mcpArgs![i + 1]!, 'utf8'))
      return { ...reply(n), ...(opts.echo ? { echoEnv: Array.isArray(opts.echo) ? opts.echo : ['HIVE_SLACK_CHANNEL', 'HIVE_SLACK_THREAD_TS', 'SLACK_BOT_TOKEN'] } : {}) }
    })
    ctx.profiles.set('p_codex', profile('p_codex', 'codex'))
    const codex = fakeAdapter('codex', calls, () => ({ output: 'codex ran' }))
    const wf = addWorkflow(ctx, {
      name: 'Support answers',
      description: '',
      inputs: [{ name: 'question', label: 'Q' }],
      nodes: [agentNode('Answer this from {{trigger.user}} in {{trigger.channel}}: {{inputs.question}}\nThread:\n{{trigger.thread}}', opts.adapter === 'codex' ? { profileId: 'p_codex' } : {})],
      ...(opts.slackTools ? { slackTools: true } : {})
    })
    store.triggers = [
      trig(wf.id, {
        reply: { mode: opts.mode ?? 'draft', autoChannels: opts.mode === 'auto' ? ['C1'] : [], replyNode: opts.replyNode === undefined ? 'answer' : opts.replyNode },
        inputs: { question: '{{trigger.text}}' },
        ...(opts.access ? { access: opts.access } : {})
      }, opts.dm ? { on: ['dm'], channels: [] } : {})
    ]
    const engine = await makeEngine(ctx, { adapters: { claude, codex }, available: ['claude', 'codex', 'shell'] })
    engine.slackTriggers!.start()
    const waitStarted = async (): Promise<Run> => {
      for (let i = 0; i < 200; i++) {
        const r = [...store.runs.values()][0]
        if (r) return r
        await new Promise((res) => setTimeout(res, 10))
      }
      throw new Error('no run')
    }
    const settle = async (r: Run): Promise<Run> => {
      const done = await waitRun(ctx, r.id)
      for (let i = 0; i < 50 && slack.replies.length === 0 && done.status === 'passed'; i++) await new Promise((res) => setTimeout(res, 10))
      await new Promise((res) => setTimeout(res, 30))
      return done
    }
    return { ctx, store, slack, calls, mcpFiles, engine, wf, waitStarted, settle }
  }

  it('replyNode output → slack.reply once, in the thread; untrusted note, env ids, no token, slack toolset attached', async () => {
    const s = await setup(() => ({ output: 'Go to Settings › Security › Reset.' }), { echo: true })
    const m = msg({ plain: 'how do I reset my password?' })
    s.slack.emit(m)
    const run = await s.waitStarted()
    expect(run).toMatchObject({ trigger: 'slack', title: 'Support answers · #support' })
    expect(run.slack).toMatchObject({ channelId: 'C1', threadTs: m.ts, userName: 'Dana Lee' })
    const done = await s.settle(run)
    expect(done.status).toBe('passed')
    expect(s.slack.replies).toEqual([
      expect.objectContaining({ runId: run.id, channelId: 'C1', threadTs: m.ts, origin: 'reply_node', text: expect.stringContaining('Go to Settings › Security › Reset.') })
    ])
    const call = s.calls[0]!
    expect(call.prompt).toContain('Answer this from Dana Lee in #support: how do I reset my password?')
    expect(call.prompt).toContain('Dana Lee: how do I reset my password?') // {{trigger.thread}}
    expect(call.systemNote).toBe(UNTRUSTED_SLACK_NOTE)
    const step = s.store.stepsOf(run.id)[0]!
    expect(step.output).toContain(`HIVE_SLACK_CHANNEL=C1`)
    expect(step.output).toContain(`HIVE_SLACK_THREAD_TS=${m.ts}`)
    expect(step.output).toContain('SLACK_BOT_TOKEN=<unset>')
    // one --mcp-config: hive with only the slack tools, pre-allowed
    expect(s.slack.toolCalls).toEqual([{ stepId: step.id, runId: run.id }])
    const i = call.mcpArgs!.indexOf('--allowedTools')
    expect(call.mcpArgs![i + 1]!.split(',')).toEqual(expect.arrayContaining(['mcp__hive__slack_post', 'mcp__hive__slack_draft_reply', 'mcp__hive__slack_read_thread']))
    expect(call.mcpArgs![i + 1]).not.toMatch(/hive_workflow/)
    const cfg = JSON.parse(s.mcpFiles[0]!)
    expect(cfg.mcpServers.hive.env).toMatchObject({ HIVE_TOOLSETS: 'slack', HIVE_LIVE_DIR: expect.stringContaining(step.id) })
  })

  it('a DM run replies top-level (threadTs null)', async () => {
    const s = await setup(() => ({ output: 'Hi Dana!' }), { dm: true })
    s.slack.emit(msg({ channelId: 'D1', channelKind: 'dm', channelName: 'Dana Lee', isDmToBot: true, isMention: false, plain: 'hi' }))
    const run = await s.settle(await s.waitStarted())
    expect(run.title).toBe('Support answers · DM with Dana Lee')
    expect(s.slack.replies).toHaveLength(1)
    expect(s.slack.replies[0]).toMatchObject({ channelId: 'D1', threadTs: null })
  })

  it('HIVE_STOP → no reply; failed run → no reply; already replied via a tool → no second reply; mode none / replyNode null → no reply', async () => {
    const a = await setup(() => ({ output: 'Not a question for me.\nHIVE_STOP: not for me' }))
    a.slack.emit(msg())
    const ra = await a.settle(await a.waitStarted())
    expect(ra.outcome).toBe('nothing_to_do')
    expect(a.slack.replies).toHaveLength(0)

    const b = await setup(() => ({ output: 'boom', exitCode: 3 }))
    b.slack.emit(msg())
    const rb = await b.settle(await b.waitStarted())
    expect(rb.status).toBe('failed')
    expect(b.slack.replies).toHaveLength(0)

    const c = await setup(() => ({ output: 'answer' }))
    c.slack.emit(msg())
    const runC = await c.waitStarted()
    c.slack.repliedRuns.set(runC.id, 1)
    await c.settle(runC)
    expect(c.slack.replies).toHaveLength(0)

    const d = await setup(() => ({ output: 'answer' }), { mode: 'none' })
    d.slack.emit(msg())
    await d.settle(await d.waitStarted())
    expect(d.slack.replies).toHaveLength(0)

    const e = await setup(() => ({ output: 'answer' }), { replyNode: null })
    e.slack.emit(msg())
    await e.settle(await e.waitStarted())
    expect(e.slack.replies).toHaveLength(0)
  })

  it('a manual run of a slackTools workflow gets the slack toolset but no trigger values or note', async () => {
    const s = await setup(() => ({ output: 'x' }), { slackTools: true })
    const run = s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: { question: 'q' } }, { trigger: 'manual' })
    await waitRun(s.ctx, run.id)
    expect(s.calls[0]!.prompt).toContain('Answer this from  in : q')
    expect(s.calls[0]!.systemNote).toBeUndefined()
    expect(s.calls[0]!.mcpArgs!.join(' ')).toContain('mcp__hive__slack_search')
  })

  // ---- SA2: the blast radius of a Slack-driven step ----
  const VAULT = { GH_TOKEN: 'ghp_vaultvalue123', OPENAI_API_KEY: 'sk-vaultvalue456' }
  const bypassClaude = { id: 'p', adapter: 'claude', model: null, extraArgs: ['--permission-mode', 'bypassPermissions', '--add-dir', '/', '--effort', 'high', '--dangerously-skip-permissions'], permissionMode: 'bypass', secretNames: ['*'], useApiKeyAuth: false } as never

  it('a Slack-triggered step is restricted: never --dangerously-skip-permissions, never the profile\'s * keys', async () => {
    const s = await setup(() => ({ output: 'answer' }), { echo: ['GH_TOKEN', 'OPENAI_API_KEY'] })
    s.ctx.secretValues = { ...VAULT }
    s.slack.emit(msg())
    const run = await s.settle(await s.waitStarted())
    expect(run.status).toBe('passed')
    expect(run.slack?.access).toEqual({ fullPermissions: false, secretNames: [], readChannels: [] })
    const call = s.calls[0]!
    expect(call.restricted).toBe(true)
    // the real claude argv for this exact request (profile: bypass + '*' keys + widening extraArgs)
    const inv = claudeAdapter.headless({ ...call, profile: bypassClaude })
    expect(inv.args).not.toContain('--dangerously-skip-permissions')
    expect(inv.args).not.toContain('bypassPermissions')
    expect(inv.args).not.toContain('--add-dir')
    expect(inv.args).not.toContain('--permission-prompt-tool')
    expect(inv.args).toContain('--effort') // harmless extraArgs survive
    const pm = inv.args.indexOf('--permission-mode')
    expect(inv.args[pm + 1]).toBe('dontAsk')
    expect(inv.args.filter((a) => a === '--permission-mode')).toHaveLength(1)
    expect(inv.args).toContain('--strict-mcp-config')
    const denied = inv.args[inv.args.indexOf('--disallowedTools') + 1]!.split(',')
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']))
    // variadic flags are always followed by another flag, never the prompt
    expect(inv.args.indexOf('--disallowedTools')).toBeLessThan(inv.args.indexOf('--session-id'))
    // env: no vault keys at all (profile says '*')
    const out = s.store.stepsOf(run.id)[0]!.output!
    expect(out).toContain('GH_TOKEN=<unset>')
    expect(out).toContain('OPENAI_API_KEY=<unset>')
  })

  it('a trigger may allow-list keys; only those reach the step, still restricted', async () => {
    const s = await setup(() => ({ output: 'answer' }), { echo: ['GH_TOKEN', 'OPENAI_API_KEY'], access: { fullPermissions: false, secretNames: ['GH_TOKEN', '*'] } })
    s.ctx.secretValues = { ...VAULT }
    s.slack.emit(msg())
    const run = await s.settle(await s.waitStarted())
    expect(s.calls[0]!.restricted).toBe(true)
    const out = s.store.stepsOf(run.id)[0]!.output!
    expect(out).toContain('GH_TOKEN=••••GH_TOKEN') // present (redacted in the stored output)
    expect(out).toContain('OPENAI_API_KEY=<unset>')
  })

  it('unsafe full permissions restores the profile mode (explicit, per trigger) but keys stay allow-listed', async () => {
    const s = await setup(() => ({ output: 'answer' }), { echo: ['GH_TOKEN'], access: { fullPermissions: true, secretNames: [] } })
    s.ctx.secretValues = { ...VAULT }
    s.slack.emit(msg())
    const run = await s.settle(await s.waitStarted())
    expect(s.calls[0]!.restricted).toBeUndefined()
    expect(claudeAdapter.headless({ ...s.calls[0]!, profile: bypassClaude }).args).toContain('--dangerously-skip-permissions')
    expect(s.store.stepsOf(run.id)[0]!.output).toContain('GH_TOKEN=<unset>')
  })

  it('a non-claude agent in a Slack-triggered run is refused unless the trigger has full permissions', async () => {
    const s = await setup(() => ({ output: 'answer' }), { adapter: 'codex' })
    s.slack.emit(msg())
    const run = await s.settle(await s.waitStarted())
    expect(run.status).toBe('failed')
    expect(s.calls).toHaveLength(0)
    expect(s.store.stepsOf(run.id)[0]!.error).toMatch(/only Claude Code supports that mode/)
    expect(s.slack.replies).toHaveLength(0)
  })

  it('a slackTools workflow run manually is restricted but keeps its profile keys', async () => {
    const s = await setup(() => ({ output: 'x' }), { slackTools: true, echo: ['GH_TOKEN'] })
    s.ctx.secretValues = { ...VAULT }
    const run = s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: { question: 'q' } }, { trigger: 'manual' })
    await waitRun(s.ctx, run.id)
    expect(s.calls[0]!.restricted).toBe(true)
    expect(s.store.stepsOf(run.id)[0]!.output).toContain('GH_TOKEN=••••GH_TOKEN')
  })

  it('a plain manual run is unchanged (profile mode and keys)', async () => {
    const s = await setup(() => ({ output: 'x' }), { echo: ['GH_TOKEN'] })
    s.ctx.secretValues = { ...VAULT }
    const run = s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: { question: 'q' } }, { trigger: 'manual' })
    await waitRun(s.ctx, run.id)
    expect(s.calls[0]!.restricted).toBeUndefined()
    expect(s.store.stepsOf(run.id)[0]!.output).toContain('GH_TOKEN=••••GH_TOKEN')
  })

  it('without a Slack connection, steps get no slack toolset', async () => {
    const s = await setup(() => ({ output: 'x' }), { slackTools: true })
    s.slack.isConnected = false
    const run = s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: { question: 'q' } }, { trigger: 'manual' })
    await waitRun(s.ctx, run.id)
    expect(s.slack.toolCalls).toHaveLength(0)
    expect((s.calls[0]!.mcpArgs ?? []).join(' ')).not.toContain('mcp__hive__')
  })
})

describe('claude adapter (SLACK.md §9.2, §12.3)', () => {
  it('systemNote joins --append-system-prompt (new conversations only)', () => {
    const p = { id: 'p', adapter: 'claude', model: null, extraArgs: [], permissionMode: 'bypass', secretNames: [], useApiKeyAuth: false } as never
    const inv = claudeAdapter.headless({ profile: p, prompt: 'x', artifactsDir: '/a', resumeId: null, shell: '/bin/sh', systemNote: UNTRUSTED_SLACK_NOTE })
    const i = inv.args.indexOf('--append-system-prompt')
    expect(inv.args[i + 1]).toContain(UNTRUSTED_SLACK_NOTE)
    const resumed = claudeAdapter.headless({ profile: p, prompt: 'x', artifactsDir: '/a', resumeId: 'abc', shell: '/bin/sh', systemNote: UNTRUSTED_SLACK_NOTE })
    expect(resumed.args).not.toContain('--append-system-prompt')
  })
  it('initialPrompt is a positional right after --session-id, never after a variadic flag', () => {
    const p = { id: 'p', adapter: 'claude', model: 'opus', extraArgs: [], permissionMode: 'bypass', secretNames: [], useApiKeyAuth: false } as never
    const inv = claudeAdapter.interactive({ profile: p, artifactsDir: '/a', resumeId: null, sessionId: 'sid', mcpArgs: ['--mcp-config', '/f', '--allowedTools', 'a,b'], initialPrompt: 'Read this Slack thread' })
    const i = inv.args.indexOf('sid')
    expect(inv.args[i - 1]).toBe('--session-id')
    expect(inv.args[i + 1]).toBe('Read this Slack thread')
    const none = claudeAdapter.interactive({ profile: p, artifactsDir: '/a', resumeId: null, sessionId: 'sid' })
    expect(none.args).not.toContain('Read this Slack thread')
  })
})

describe('slack triggers: fallback (the built-in "Reply when tagged")', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00.000Z') }))
  afterEach(() => vi.useRealTimers())

  const fallback = (wfId: string): SlackTrigger => trig(wfId, { id: 'stg_fallback', reply: { mode: 'auto', autoChannels: ['*'], replyNode: 'reply' } }, { on: ['mention', 'dm'], channels: [], fallback: true })

  it('fires for a mention no specific trigger takes, and stays out when one does', async () => {
    const u = unit({ triggers: (wf) => [trig(wf, { id: 'stg_support' }), fallback(wf)] })
    u.st.start()
    u.slack.emit(msg({ channelId: 'C9', channelName: 'random' })) // only the fallback matches
    await flush()
    u.slack.emit(msg()) // #support: the specific trigger matches → fallback stays out
    await flush()
    expect(u.started.map((s) => s.slack?.triggerId)).toEqual(['stg_fallback', 'stg_support'])
  })

  it('a disabled specific trigger does not block the fallback', async () => {
    const u = unit({ triggers: (wf) => [trig(wf, { id: 'stg_support', enabled: false }), fallback(wf)] })
    u.st.start()
    u.slack.emit(msg())
    await flush()
    expect(u.started.map((s) => s.slack?.triggerId)).toEqual(['stg_fallback'])
  })

  it('describes itself and validates', () => {
    expect(describeSlackTrigger(fallback('wf_1'))).toBe('When @hive is mentioned or someone DMs @hive · AUTO-replies wherever it is tagged')
    const input = { name: 'Reply when tagged', workflowId: 'wf_1', match: { on: ['mention', 'dm'], channels: [], keywords: [], regex: null, fromUsers: [], fallback: true }, reply: { mode: 'auto', autoChannels: ['*'], replyNode: null } } as SlackTriggerInput
    expect(validateSlackTrigger(input, { workflow: { nodes: [], inputs: [] } as unknown as WorkflowDraft })).toEqual([])
    const onMessage = { ...input, match: { ...input.match, on: ['message'], channels: ['C1'], keywords: ['x'] } } as SlackTriggerInput
    expect(validateSlackTrigger(onMessage, { workflow: { nodes: [], inputs: [] } as unknown as WorkflowDraft }).map((e) => e.path)).toContain('reply.autoChannels')
  })
})

describe('the built-in responder workflow', () => {
  it('is a valid workflow and a valid fallback trigger target', async () => {
    const { defaultResponderDraft } = await import('../../connectors/slack/service')
    const draft = defaultResponderDraft('p_claude')
    const deps = { getProfile: (id: string) => (id === 'p_claude' ? profile('p_claude', 'claude') : null), getRepo: () => null, slackTriggered: true }
    expect(validateWorkflow(draft, deps)).toEqual([])
    const input = { name: 'Reply when tagged', workflowId: 'wf_1', match: { on: ['mention', 'dm'], channels: [], keywords: [], regex: null, fromUsers: [], fallback: true }, reply: { mode: 'auto', autoChannels: ['*'], replyNode: 'reply' } } as SlackTriggerInput
    expect(validateSlackTrigger(input, { workflow: draft })).toEqual([])
  })
})
