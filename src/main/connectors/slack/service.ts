/**
 * SlackService (SLACK.md §2.3): the Electron-side owner of the Slack connector. Builds the connector on the SQLite
 * store, the vault-backed secrets and the production transport (or the dev-only fake), and adapts it to Hive:
 * IPC events, Mac notifications, the engine's SlackBridge, the broker's slack_* tools, trigger config and the
 * Needs-you mirror. Everything safety-critical (posting policy, drafts) lives in core/.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { LiveOwner, McpServerSpec, SlackBridge } from '../../../shared/engine'
import { HiveError } from '../../../shared/errors'
import { newId } from '../../../shared/ids'
import type { AgentNode, Ask } from '../../../shared/live'
import type {
  SlackChannel,
  SlackDraft,
  SlackDraftDetail,
  SlackDraftStatus,
  SlackInboundMessage,
  SlackMessage,
  SlackMessagePage,
  SlackReplyMode,
  SlackRunContext,
  SlackStatus,
  SlackThread,
  SlackTrigger,
  SlackTriggerInput,
  SlackTriggerTestResult,
  SlackUser
} from '../../../shared/slack'
import { slackAuthorKind, slackAuthorProblem, slackWhoCanTrigger } from '../../../shared/slack'
import type { Id, Session, ValidationError, WorkflowDraft } from '../../../shared/types'
import { matchSlackTrigger, validateSlackTrigger } from '../../engine'
import { PERSONAL_COMPANY_ID } from '../../../shared/company'
import type { Hive } from '../../hive'
import { emit } from '../../ipc'
import { log } from '../../log'
import { notify } from '../../notify'
import { liveRoot } from '../../live/bridge'
import type { NotifyNode, SlackAlertPort } from '../../notifyNode'
import type { NotifyResult } from '../../../shared/authoring'
import type { Cipher } from '../../vault'
import { SlackConnector } from './core/connector'
import { buildManifest } from './core/manifest'
import { buildTranscript, maskTokens, parsePermalink, transcriptLine, tsCmp } from './core/format'
import { userLabel } from './core/ingest'
import type { Clock, HttpPort, SlackDraftRow, SocketPort } from './core/ports'
import { slackCompanyMismatch, type ReplyTriggerView, type SlackCompanyRef } from './core/policy'
import { createSlackAskPort } from './asks'
import { diskImageSink } from './images'
import { ConnectorSecrets } from './secrets'
import { SlackSqlite, createSqliteSlackStore } from './store/sqlite'
import { SlackTools } from './tools'
import { SlackWork, claudeLastAssistant, sendWorkReport } from './work'
import type { SlackWorkSession } from './store/sqlite'
import { historyRoots } from '../../history'
import { entriesFrom } from '../../history/transcript'
import { normalizeTrigger, triggerCompanyErrors, triggerDepartmentErrors, triggerSentence } from './triggerConfig'
import { departmentsEnabled } from '../../../shared/company'
import { SlackTriggerStore } from './triggerStore'
import { nodeHttp, nodeSocket } from './transport/node'

const HOUR = 3600_000
const DAY = 86400_000

const DEFAULT_RESPONDER_META = 'slack_default_responder'
const DEFAULT_RESPONDER_SEED = 'slack-default-reply'
const DEFAULT_RESPONDER_NAME = 'Reply in Slack'

/** The responder prompt shipped before Slack-started work (an unedited copy is upgraded in place at start). */
export const LEGACY_RESPONDER_PROMPT = [
  'You are Hive, the team assistant in Slack. {{trigger.user}} addressed you in {{trigger.channel}}.',
  '',
  'The conversation so far:',
  '{{trigger.thread}}',
  '',
  'The message(s) to you:',
  '{{trigger.text}}',
  '',
  'Images shared in the thread (local files; open each with your Read tool before answering; empty = none):',
  '{{trigger.images}}',
  '',
  'Write your reply for that thread. Answer directly and helpfully, Slack style: short, plain words, bullets only when they help.',
  'Use your Slack tools to read more of the channel or search when you need context. If you cannot help, say so in one line.',
  'Output only the reply text, nothing else.'
].join('\n')

/** The built-in responder: one Claude step whose output is the reply (restricted like every Slack-triggered agent). */
export function defaultResponderDraft(profileId: Id): WorkflowDraft {
  return {
    name: DEFAULT_RESPONDER_NAME,
    description: 'Answers when someone tags @hive or DMs it in Slack. Used by the "Reply when tagged" trigger.',
    inputs: [],
    nodes: [
      {
        id: 'reply',
        type: 'agent',
        label: 'Write the reply',
        after: [],
        cwd: null,
        timeoutMin: 10,
        profileId,
        prompt: [
          'You are Hive, the team assistant in Slack. {{trigger.user}} addressed you in {{trigger.channel}}.',
          '',
          'The conversation so far:',
          '{{trigger.thread}}',
          '',
          'The message(s) to you:',
          '{{trigger.text}}',
          '',
          'Images shared in the thread (local files; open each with your Read tool before answering; empty = none):',
          '{{trigger.images}}',
          '',
          'Write your reply for that thread. Answer directly and helpfully, Slack style: short, plain words, bullets only when they help.',
          'Use your Slack tools to read more of the channel or search when you need context.',
          '',
          'When the message asks for real work in code (fix it, implement it, "go ahead and take it", "you do it", investigate in the repo), do not refuse and do not say you lack repo access: start a Principia session.',
          '1. Call principia_repos. Match the thread (product names, file paths, error names, URLs, stack traces) against each repo\'s name, path, remote and readme; prefer the one marked hint (last used from this channel) when it fits.',
          '2. Only if two or three repos fit equally well, reply asking which one, as a numbered list of 2-3 options (name and one-line why), and start nothing.',
          '3. Otherwise call principia_start_session with repo_id, a short title and task: what to do and the done criteria in your own words, including the key facts from the thread. Then reply in one line: started <claude|codex> session "<title>" in <repo>, will report back here.',
          'To add to work this thread already started (the thread shows "session ... in ..."), pass continue_session_id only if you know that session id; otherwise start a new one.',
          'Never start work for questions, opinions or discussion: answer those. If a tool refuses (another company, disabled), say so in one line.',
          '',
          'If you cannot help, say so in one line. Output only the reply text, nothing else.'
        ].join('\n')
      }
    ]
  }
}
const MIRROR_EVERY_MS = 120_000

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
}

export interface SlackServiceOpts {
  cipher: Cipher
  mainDir: string
  /** Dev-only fake build (devFake.ts) or tests: replaces the whole transport. Never set in production builds. */
  transport?: { http: HttpPort; socket: SocketPort; fake?: boolean } | null
}

export class SlackService {
  readonly sql: SlackSqlite
  readonly triggers: SlackTriggerStore
  readonly secrets: ConnectorSecrets
  readonly connector: SlackConnector
  readonly tools: SlackTools
  /** SLACK.md §11.4: sessions started from Slack threads + their report back. */
  readonly work: SlackWork
  private listeners = new Set<(m: SlackInboundMessage) => void>()
  private msgBuf = new Map<string, Map<string, SlackMessage>>()
  private msgTimer: NodeJS.Timeout | null = null
  private lastFatalAt = 0
  private mirrorAt = 0
  private mirrorPending: string[] = []
  private mirrorTimer: NodeJS.Timeout | null = null
  private maintTimer: NodeJS.Timeout | null = null
  private notifiedDrafts = new Set<string>()
  /** Ask an agent: session id -> its thread transcript file. */
  private askFiles = new Map<Id, string>()
  /** COMPANY.md §6: last company-mismatch note per trigger (one slack_trigger_events row per trigger per hour). */
  private companyNotes = new Map<Id, number>()

  constructor(
    private h: Hive,
    private opts: SlackServiceOpts
  ) {
    this.sql = new SlackSqlite(h.db)
    const store = createSqliteSlackStore(this.sql)
    this.secrets = new ConnectorSecrets(h.db, opts.cipher, h.vault)
    this.secrets.loadRedactions()
    this.triggers = new SlackTriggerStore(h.db, (id) => this.connector?.names.channel(id) ?? id)
    const t = opts.transport ?? null
    this.connector = new SlackConnector({
      store,
      secrets: this.secrets,
      http: t?.http ?? nodeHttp,
      socket: t?.socket ?? nodeSocket,
      asks: createSlackAskPort(h),
      clock,
      log: {
        info: (m, meta) => log.info(`slack: ${m}`, this.safeMeta(meta)),
        warn: (m, meta) => log.warn(`slack: ${m}`, this.safeMeta(meta)),
        error: (m, meta) => log.error(`slack: ${m}`, this.safeMeta(meta))
      },
      events: {
        status: (s) => emit('slack:status', s),
        messages: (b) => this.queueMessages(b.channelId, b.messages),
        channels: (list) => emit('slack:channels', list),
        inbound: (m) => this.dispatchInbound(m),
        alertSuggestion: (s) =>
          notify({
            title: `Got it from ${s.name}`,
            body: 'Send your Hive alerts to this Slack DM? Open Settings › Connections to say yes.',
            sound: h.settings().notificationSound,
            onClick: () => h.windows.command({ kind: 'openSettings' })
          }),
        draft: (row) => this.onDraft(row),
        fatal: (message) => {
          if (Date.now() - this.lastFatalAt < HOUR) return
          this.lastFatalAt = Date.now()
          notify({ title: 'Slack disconnected', body: `${message}`.slice(0, 200), sound: h.settings().notificationSound, onClick: () => h.windows.command({ kind: 'openSettings' }) })
        }
      },
      settings: {
        backfillDays: () => h.settings().slackBackfillDays ?? 7,
        triggerCatchupMin: () => h.settings().slackTriggerCatchupMin ?? 10,
        autoPaused: () => !!h.settings().slackAutoPaused,
        alertUserId: () => h.settings().slackAlertUserId ?? null
      },
      redact: (s) => h.vault.redact(s),
      newId: (k) => newId(k),
      fake: !!t?.fake
    })
    this.work = new SlackWork({
      sql: this.sql,
      redact: (s) => h.vault.redact(s),
      repos: () => h.store.listRepos(),
      repoCompany: (repoId) => {
        const c = h.safe(() => h.company.companyForRepo(repoId), null)
        return c ? { id: c.id, name: c.name } : this.companyRef(PERSONAL_COMPANY_ID)
      },
      teamCompany: (teamId) => this.teamCompany(teamId),
      enforced: () => h.store.companyGuardsEnforced(),
      multiCompany: () => h.safe(() => h.company.listPassports().length, 1) > 1,
      lastActivity: (repoId) => h.safe(() => (h.db.prepare('SELECT MAX(started_at) AS m FROM sessions WHERE repo_id = ?').get(repoId) as { m: string | null } | undefined)?.m ?? null, null),
      transcript: (channelId, threadTs) => this.transcript(channelId, threadTs),
      runImagesDir: (runId) => {
        const run = h.store.getRun(runId)
        return run?.artifactsDir ? path.join(run.artifactsDir, 'slack-images') : null
      },
      createSession: (req) => {
        const s = h.sessions.create({ adapter: req.adapter, repoId: req.repoId, cols: 120, rows: 32, title: req.title, ...(req.companyId ? { companyId: req.companyId } : {}), initialPromptFor: req.prepare })
        return { id: s.id, title: s.title }
      },
      continueSession: (sessionId, text) => {
        const live = h.sessionLive?.live(sessionId)
        if (!live) throw new HiveError('conflict', 'This session has ended')
        live.reply(text)
      },
      lastAssistantMessage: (sessionId) => {
        const s = h.store.getSession(sessionId)
        // Codex transcripts are not read here (the hook's last message on the agent row is the fallback)
        if (!s || s.adapter !== 'claude' || !s.agentSessionId) return null
        return claudeLastAssistant(historyRoots(process.env), s.agentSessionId, entriesFrom)
      },
      postReport: (w, text, agentId) => this.postWorkReport(w, text, agentId),
      log: { info: (m, meta) => log.info(m, this.safeMeta(meta)), warn: (m, meta) => log.warn(m, this.safeMeta(meta)) }
    })
    this.tools = new SlackTools({
      work: this.work,
      connector: this.connector,
      sql: this.sql,
      redact: (s) => h.vault.redact(s),
      now: () => Date.now(),
      session: (sid) => {
        const s = h.store.getSession(sid)
        if (!s || s.status !== 'running') return null
        return { label: s.title, agentId: h.live?.rootOfSession(sid)?.id ?? null }
      },
      step: (o) => {
        const run = h.store.getRun(o.runId)
        if (!run) return null
        const wf = run.workflowId ? h.store.getWorkflow(run.workflowId) : null
        return { ctx: run.slack ?? null, slackTools: !!wf?.slackTools, label: run.title, agentId: h.live?.rootOfStep(o.stepId)?.id ?? null }
      },
      trigger: (id) => this.triggerView(id)
    })
  }

  private safeMeta(meta?: object): Record<string, unknown> | undefined {
    if (!meta) return undefined
    return JSON.parse(maskTokens(this.h.vault.redact(JSON.stringify(meta)))) as Record<string, unknown>
  }

  // ---------- lifecycle ----------
  async start(): Promise<void> {
    // transcripts left by sessions of an earlier launch (their sessions are gone)
    this.pruneAskFiles(0)
    await this.connector.start()
    this.ensureDefaultResponder()
    this.upgradeDefaultResponder()
    this.maintTimer = setInterval(() => void this.maintenance(), DAY)
    this.maintTimer.unref?.()
    setTimeout(() => void this.maintenance(), 60_000).unref?.()
  }
  private async maintenance(): Promise<void> {
    this.pruneAskFiles(DAY)
    await this.connector.maintenance().catch((e) => log.warn('slack maintenance failed', { e: String(e) }))
  }
  async stop(): Promise<void> {
    if (this.maintTimer) clearInterval(this.maintTimer)
    await this.connector.stop()
  }
  pause(): void {
    this.connector.pause()
  }
  resume(reason: 'wake' | 'network'): void {
    this.connector.resume(reason)
  }
  status(): SlackStatus {
    return this.connector.status()
  }

  private queueMessages(channelId: string, msgs: SlackMessage[]): void {
    const m = this.msgBuf.get(channelId) ?? new Map<string, SlackMessage>()
    for (const x of msgs) m.set(x.ts, x)
    this.msgBuf.set(channelId, m)
    if (this.msgTimer) return
    this.msgTimer = setTimeout(() => {
      this.msgTimer = null
      const buf = this.msgBuf
      this.msgBuf = new Map()
      for (const [channelId, mm] of buf) emit('slack:messages', { channelId, messages: [...mm.values()].sort((a, b) => tsCmp(a.ts, b.ts)) })
    }, 250)
  }

  // ---------- drafts ----------
  publicDraft(r: SlackDraftRow): SlackDraft {
    const ch = this.connector.workspace() ? this.sql.getChannel(r.teamId, r.channelId) : null
    return {
      id: r.id,
      status: r.status,
      channelId: r.channelId,
      // display label (CONTRACT Slack: "Reply in #support" / "Reply to Dana Lee (DM)")
      channelName: !ch ? r.channelId : ch.kind === 'dm' ? userLabel(ch.dmUserId ? this.connector.names.users.get(ch.dmUserId) : undefined, ch.dmUserId ?? ch.name) : ch.kind === 'group_dm' ? ch.name : `#${ch.name}`,
      threadTs: r.threadTs,
      text: r.text,
      originalText: r.originalText,
      edited: r.edited,
      reason: r.reason,
      note: r.note,
      ownerLabel: r.owner.label,
      sessionId: r.owner.sessionId,
      runId: r.owner.runId,
      stepId: r.owner.stepId,
      triggerId: r.owner.triggerId,
      askId: r.askId,
      sentTs: r.sentTs,
      error: r.error,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      expiresAt: r.expiresAt
    }
  }
  private onDraft(row: SlackDraftRow): void {
    emit('slack:draft', this.publicDraft(row))
    this.h.statusChanged()
    // a draft with no live owner (no Ask) still deserves one notification
    if (row.status === 'pending' && !row.askId && !this.notifiedDrafts.has(row.id)) {
      this.notifiedDrafts.add(row.id)
      notify({ title: 'Draft reply waiting', body: row.text.slice(0, 200), sound: this.h.settings().notificationSound, onClick: () => this.h.windows.command({ kind: 'openSlackDraft', draftId: row.id }) })
    }
  }
  drafts(q: { status?: SlackDraftStatus[]; channelId?: string; threadTs?: string; runId?: Id } = {}): SlackDraft[] {
    return this.sql.draftList({ ...q, status: q.status?.length ? q.status : ['pending', 'failed', 'sending'] }).map((r) => this.publicDraft(r))
  }
  draftGet(id: Id): SlackDraftDetail {
    const r = this.sql.draftGet(id)
    if (!r) throw new HiveError('not_found', 'Draft not found')
    const thread = r.threadTs ? this.sql.getThread({ teamId: r.teamId, channelId: r.channelId, threadTs: r.threadTs, limit: 200 }) : this.sql.getMessages({ teamId: r.teamId, channelId: r.channelId, limit: 50 })
    const after = thread.filter((m) => !m.fromHive && tsCmp(m.ts, (Date.parse(r.createdAt) / 1000).toFixed(6)) > 0)
    return { draft: this.publicDraft(r), context: thread.slice(-3), newSinceDraft: after.length }
  }
  async draftDecide(id: Id, decision: 'send' | 'discard', text?: string): Promise<SlackDraft> {
    const r = await this.connector.drafts.decide(id, decision, text)
    return this.publicDraft(r)
  }

  // ---------- reads (IPC) ----------
  private team(): string {
    const ws = this.connector.workspace()
    if (!ws) throw new HiveError('conflict', 'Slack is not connected')
    return ws.teamId
  }
  channels(query?: string): SlackChannel[] {
    const ws = this.connector.workspace()
    if (!ws) return []
    const q = query?.trim().toLowerCase()
    return this.sql.listChannels(ws.teamId).filter((c) => !q || c.name.toLowerCase().includes(q))
  }
  users(q: { query?: string; includeBots?: boolean } = {}): SlackUser[] {
    const ws = this.connector.workspace()
    if (!ws) return []
    const s = q.query?.trim().toLowerCase()
    return this.sql
      .listUsers(ws.teamId)
      .filter((u) => !u.deleted && (q.includeBots || !u.isBot))
      .filter((u) => !s || [u.name, u.realName, u.displayName].some((x) => (x ?? '').toLowerCase().includes(s)))
  }
  messages(q: { channelId: string; beforeTs?: string; limit?: number }): SlackMessagePage {
    const teamId = this.team()
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200)
    const msgs = this.sql.getMessages({ teamId, channelId: q.channelId, beforeTs: q.beforeTs, limit: limit + 1 })
    const hasMoreLocal = msgs.length > limit
    const page = hasMoreLocal ? msgs.slice(1) : msgs
    // newest page: one interactive freshness fetch (SLACK.md §6.3 "On open")
    if (!q.beforeTs && this.connector.isConnected()) void this.connector.sync.fetchLatest(q.channelId).catch(() => undefined)
    const st = this.sql.getSyncState(teamId, q.channelId)
    return { messages: page, hasMoreLocal, oldestLocalTs: page[0]?.ts ?? null, backfillOldestTs: st?.backfillOldestTs ?? null }
  }
  async thread(channelId: string, threadTs: string): Promise<SlackThread> {
    const teamId = this.team()
    const ch = this.sql.getChannel(teamId, channelId)
    if (!ch) throw new HiveError('not_found', 'Channel not found')
    const ts = this.sql.getThreadSync(teamId, channelId, threadTs)
    if (this.connector.isConnected() && (!ts?.fetchedAt || Date.now() - Date.parse(ts.fetchedAt) > 60_000)) {
      await Promise.race([this.connector.sync.fetchThread(channelId, threadTs).catch(() => undefined), new Promise((r) => setTimeout(r, 3000).unref?.())])
    }
    const all = this.sql.getThread({ teamId, channelId, threadTs, limit: 1000 })
    const parent = all.find((m) => m.ts === threadTs) ?? null
    return {
      channel: ch,
      parent,
      replies: all.filter((m) => m.ts !== threadTs),
      fetchedAt: this.sql.getThreadSync(teamId, channelId, threadTs)?.fetchedAt ?? null,
      drafts: this.drafts({ channelId, threadTs })
    }
  }
  markRead(channelId: string, ts: string): void {
    this.sql.markRead(this.team(), channelId, ts)
    emit('slack:channels', this.channels())
  }
  manifest(name?: string): { json: string; yaml: string; createUrl: string } {
    const m = buildManifest({ name })
    return { json: m.jsonText, yaml: m.yaml, createUrl: m.createUrl }
  }
  async backfill(channelId: string | undefined, days: number): Promise<SlackStatus> {
    if (!this.connector.isConfigured()) throw new HiveError('conflict', 'Connect Slack first')
    void this.connector.sync.backfill({ channelId, days }).catch(() => undefined)
    return this.status()
  }

  /** slack:connect: validate, confirm a team switch, store, start (PO-S1 one button). */
  async connect(t: { botToken: string; appToken: string }, confirmSwitch: (from: string, to: string) => Promise<boolean>): Promise<SlackStatus> {
    const v = await this.connector.validateTokens(t)
    const cur = this.connector.currentTeam()
    if (cur && cur.teamId !== v.auth.teamId && !(await confirmSwitch(cur.name, v.auth.team))) throw new HiveError('canceled', 'Kept the current workspace')
    const s = await this.connector.commitTokens(v)
    this.ensureDefaultResponder()
    // triggers saved while disconnected become usable again (the user re-enables them)
    return s
  }
  async disconnect(purge: boolean): Promise<SlackStatus> {
    const s = await this.connector.disconnect(purge)
    if (purge) this.pruneAskFiles(null)
    this.triggers.disableAll('Slack disconnected')
    this.h.safe(() => this.h.engine.slackTriggers?.reload(), undefined)
    for (const t of this.triggers.list()) emit('slackTrigger:updated', t)
    return s
  }

  /**
   * Who can trigger (default: workspace members only). A message from a guest, a Slack Connect external, a deactivated
   * or an unidentified user reaches trigger matching only for the triggers that allow it (match.allowGuests, or the
   * author named in fromUsers): with none it is dropped here, and otherwise the engine sees only those triggers while
   * it matches this message (its matching is synchronous inside the listener call). Main-side, fail closed: the engine
   * needs no change to honor it, and `m.author` lets it apply slackAuthorProblem itself.
   */
  private dispatchInbound(m: SlackInboundMessage): void {
    let scope: Set<string> | null = null
    if ((m.author ?? 'unknown') !== 'member' && !m.isOwn && !m.fromBot && m.userId) {
      scope = new Set(this.triggers.list().filter((t) => t.enabled && !slackAuthorProblem(t.match, m)).map((t) => t.id))
      if (!scope.size) {
        log.info('slack: message from a non-member; no trigger allows it', { author: m.author ?? 'unknown', channel: m.channelId })
        return
      }
    }
    // COMPANY.md §6: a team's message never starts another company's workflow (dropped with a note while enforced)
    const blocked = this.companyBlocked(m)
    if (blocked.size) {
      const base = scope ?? new Set(this.triggers.list().filter((t) => t.enabled).map((t) => t.id))
      scope = new Set([...base].filter((id) => !blocked.has(id)))
      if (!scope.size) {
        log.info('slack: message dropped; every matching trigger starts a workflow of another company', { channel: m.channelId })
        return
      }
    }
    this.triggers.scoped(scope, () => {
      for (const cb of this.listeners) {
        try {
          cb(m)
        } catch (e) {
          log.warn('slack inbound listener failed', { e: String(e) })
        }
      }
    })
  }

  // ---------- companies (COMPANY.md §3, §6) ----------
  private companyRef(id: Id): SlackCompanyRef {
    const c = this.h.safe(() => this.h.company.passport(id), null) ?? this.h.safe(() => this.h.company.passport(PERSONAL_COMPANY_ID), null)
    return { id: c?.id ?? PERSONAL_COMPANY_ID, name: c?.name ?? 'Personal' }
  }
  /** The workspace's company (slack_workspaces.company_id; Personal when unknown). */
  teamCompany(teamId: string): SlackCompanyRef {
    const c = this.h.safe(() => this.h.company.companyOf({ teamId }), null)
    return c ? { id: c.id, name: c.name } : this.companyRef(PERSONAL_COMPANY_ID)
  }
  /** A trigger belongs to its workflow's company. */
  workflowCompany(workflowId: Id): SlackCompanyRef {
    return this.companyRef(this.h.store.getWorkflow(workflowId)?.companyId ?? PERSONAL_COMPANY_ID)
  }
  /**
   * Enabled triggers whose workflow belongs to another company than the message's team. Enforced
   * (experimental.companies): returned, so the engine never sees them for this message, and a trigger that would have
   * fired gets a slack_trigger_events note (at most hourly). Off: logged, nothing is dropped.
   */
  private companyBlocked(m: SlackInboundMessage): Set<Id> {
    const out = new Set<Id>()
    const enforced = this.h.store.companyGuardsEnforced()
    let team: SlackCompanyRef | null = null
    for (const t of this.triggers.list()) {
      if (!t.enabled) continue
      team ??= this.teamCompany(m.teamId)
      const problem = slackCompanyMismatch(team, this.workflowCompany(t.workflowId))
      if (!problem) continue
      if (enforced) out.add(t.id)
      if (m.isOwn || m.fromBot || !matchSlackTrigger(t, m).ok) continue
      const last = this.companyNotes.get(t.id) ?? 0
      if (Date.now() - last < HOUR) continue
      this.companyNotes.set(t.id, Date.now())
      if (!enforced) {
        log.warn('slack: company guard (not enforced)', { triggerId: t.id, problem })
        continue
      }
      this.triggers.insertEvent({ triggerId: t.id, kind: 'error', channelId: m.channelId, threadTs: m.threadTs, ts: m.ts, runId: null, message: `Dropped: ${problem}` })
      emit('slackTrigger:updated', this.triggers.get(t.id) ?? t)
    }
    return out
  }
  /** "<title> · <company>" once there is more than one company (alerts name the company). */
  private alertTitle(title: string, triggerId: Id): string {
    const t = this.triggers.get(triggerId)
    if (!t || this.h.safe(() => this.h.company.listPassports().length, 1) < 2) return title
    return `${title} · ${this.workflowCompany(t.workflowId).name}`
  }

  // ---------- engine bridge (SLACK.md §9, CONTRACT Slack.3) ----------
  triggerView(id: string): ReplyTriggerView | null {
    const t = this.triggers.get(id)
    return t ? { id: t.id, enabled: t.enabled, reply: t.reply, limits: t.limits } : null
  }

  transcript(channelId: string, threadTs: string, maxChars = 20_000): string {
    const ws = this.connector.workspace()
    if (!ws) return ''
    const ch = this.sql.getChannel(ws.teamId, channelId)
    const isDm = ch?.kind === 'dm' || ch?.kind === 'group_dm' || threadTs.startsWith('dm:')
    const msgs = isDm && !this.sql.getThread({ teamId: ws.teamId, channelId, threadTs, limit: 2 }).some((m) => m.replyCount > 0)
      ? this.sql.getMessages({ teamId: ws.teamId, channelId, limit: 50 })
      : this.sql.getThread({ teamId: ws.teamId, channelId, threadTs, limit: 200 })
    const name = (id: string | null) => (id ? userLabel(this.connector.names.users.get(id), id) : 'bot')
    const lines = msgs.filter((m) => !m.deleted).map((m) => transcriptLine(m.ts, m.fromHive ? 'Hive' : name(m.userId), this.h.vault.redact(m.plain)))
    return buildTranscript(lines, 50, maxChars)
  }

  bridge(): SlackBridge {
    return {
      connected: () => this.connector.isConnected(),
      onMessage: (cb) => {
        this.listeners.add(cb)
        return () => this.listeners.delete(cb)
      },
      threadTranscript: (q) => this.transcript(q.channelId, q.threadTs),
      downloadThreadImages: (q) => this.connector.threadImages(q.channelId, q.threadTs, diskImageSink(q.destDir)),
      permalink: (channelId, ts) => this.connector.permalink(channelId, ts),
      resolveUserName: (userId) => userLabel(this.connector.names.users.get(userId), userId),
      message: (q) => {
        const ws = this.connector.workspace()
        const m = ws ? this.sql.getMessage(ws.teamId, q.channelId, q.ts) : null
        return m ? { userId: m.userId, userName: m.userId ? userLabel(this.connector.names.users.get(m.userId), m.userId) : null, plain: m.plain } : null
      },
      alert: (a) => notify({ title: this.alertTitle(a.title, a.triggerId), body: a.message.slice(0, 250), sound: this.h.settings().notificationSound, onClick: () => this.h.windows.command({ kind: 'navigate', view: 'schedules' }) }),
      reply: async (req) => {
        const run = this.h.store.getRun(req.runId)
        const ctx: SlackRunContext | null = run?.slack ?? null
        const ws = this.connector.workspace()
        if (!run || !ws) return { status: 'refused', reason: 'Slack is not connected' }
        const ch = this.sql.getChannel(ws.teamId, req.channelId)
        if (!ch) return { status: 'refused', reason: 'Unknown channel' }
        try {
          const r = await this.connector.reply({
            caller: { kind: 'step', runId: req.runId, stepId: req.stepId, ctx, trigger: ctx ? this.triggerView(ctx.triggerId) : null },
            channel: ch,
            threadTs: req.threadTs,
            text: req.text,
            ownerLabel: run.title,
            agentId: req.stepId ? (this.h.live?.rootOfStep(req.stepId)?.id ?? null) : null
          })
          if (r.status === 'posted') return { status: 'posted', ts: r.ts }
          if (r.status === 'drafted') return { status: 'drafted', draftId: r.draftId, reason: r.reason }
          return { status: 'refused', reason: r.reason }
        } catch (e) {
          log.warn('slack reply failed', { runId: req.runId, e: this.h.vault.redact(String(e)) })
          return { status: 'refused', reason: e instanceof Error ? e.message : String(e) }
        }
      },
      repliesForRun: (runId) => this.sql.countForRun(runId),
      toolServer: (owner) => this.toolServer(owner)
    }
  }

  /** The `hive` server with only the slack toolset, for a headless claude step (SA2). */
  toolServer(owner: { stepId: Id; runId: Id }): McpServerSpec | null {
    if (!this.connector.isConfigured()) return null
    const run = this.h.store.getRun(owner.runId)
    if (!run) return null
    const wf = run.workflowId ? this.h.store.getWorkflow(run.workflowId) : null
    if (!run.slack && !wf?.slackTools) return null
    const script = path.join(this.opts.mainDir, 'mcp-hive.js')
    if (!fs.existsSync(script)) return null
    return {
      name: 'hive',
      command: process.execPath,
      args: [script],
      // SLACK.md §11.4: Slack-triggered runs also list the `work` toolset (principia_repos / principia_start_session)
      env: { ELECTRON_RUN_AS_NODE: '1', HIVE_TOOLSETS: run.slack ? 'slack,work' : 'slack', HIVE_LIVE_DIR: path.join(liveRoot(this.h.paths.userData), owner.stepId) }
    }
  }

  /** HIVE_TOOLSETS for an interactive claude session's `hive` server. */
  sessionToolsets(): string {
    return this.connector.isConfigured() ? 'author,slack' : 'author'
  }

  toolCall(owner: LiveOwner, tool: Parameters<SlackTools['call']>[1], args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.tools.call(owner, tool, args)
  }

  // ---------- Slack-started work: report back (SLACK.md §11.4) ----------
  /** hive.onLiveEvent: a root agent row changed. */
  onAgentUpdated(a: AgentNode): void {
    void this.work.onAgent(a)
  }

  /** The report goes through the original run's trigger policy (post or draft). */
  async postWorkReport(w: SlackWorkSession, text: string, agentId: string | null): Promise<void> {
    const run = w.runId ? this.h.store.getRun(w.runId) : null
    const ctx: SlackRunContext | null = run?.slack ?? null
    const r = await sendWorkReport(this.connector, { ctx, trigger: ctx ? this.triggerView(ctx.triggerId) : null }, w, text, agentId)
    if (r !== 'posted' && r !== 'drafted') log.info('slack work: report not sent', { sessionId: w.sessionId, result: r })
  }

  // ---------- notify node + mirror (SLACK.md §10) ----------
  alertPort(): SlackAlertPort {
    return {
      connected: () => this.connector.isConfigured() && !!this.connector.workspace(),
      alertUserId: () => this.h.settings().slackAlertUserId ?? null,
      post: async (to, text, runId, stepId) => {
        // a channel post from a Slack-triggered run goes through the auto anti-spam floor (PO-S3), like auto replies
        const floor = 'channelId' in to && !!runId && !!this.h.store.getRun(runId)?.slack
        await this.connector.postAlert(to, text, 'notify', runId, stepId, { floor })
      },
      recentPosts: (q) => this.connector.notifyPostsSince(q)
    }
  }
  async testAlert(notifyNode: NotifyNode | null): Promise<NotifyResult> {
    if (!notifyNode) throw new HiveError('internal', 'Notifications are not available')
    const r = await notifyNode.slack({ kind: 'me' }, 'Hive test alert', 'Slack alerts from Hive work.', null, null)
    return { notified: false, ...r }
  }

  /** slackMirrorNeedsYou: title + owner only, ≤ 1 per 2 min, coalesced. */
  mirrorAsk(a: Ask, ownerLabel: string): void {
    const s = this.h.settings()
    if (!s.slackMirrorNeedsYou || !s.slackAlertUserId || !this.connector.isConnected() || a.status !== 'open') return
    const line = a.kind === 'slack_reply' ? `Draft reply waiting for ${a.title.replace(/^Reply (in|to) /, '')}` : `Hive needs you: ${a.title} · ${ownerLabel}`
    this.mirrorPending.push(line.slice(0, 300))
    const wait = Math.max(0, this.mirrorAt + MIRROR_EVERY_MS - Date.now())
    if (this.mirrorTimer) return
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null
      const items = this.mirrorPending
      this.mirrorPending = []
      if (!items.length) return
      this.mirrorAt = Date.now()
      const text = items.length === 1 ? items[0] : `Hive needs you: ${items.length} things waiting`
      void this.connector.postAlert({ userId: s.slackAlertUserId! }, text, 'mirror').catch((e) => log.warn('slack mirror failed', { e: String(e) }))
    }, wait)
    this.mirrorTimer.unref?.()
  }

  // ---------- triggers (SLACK.md §9, main owns config) ----------
  listTriggers(workflowId?: Id): SlackTrigger[] {
    return this.triggers.list({ workflowId })
  }
  private normalize(input: SlackTriggerInput): ReturnType<typeof normalizeTrigger>['trigger'] {
    const wf = this.h.store.getWorkflow(input.workflowId)
    if (!wf) throw new HiveError('not_found', 'Workflow not found')
    const { trigger, errors } = normalizeTrigger(input, wf)
    errors.push(...this.readChannelErrors(trigger.access.readChannels ?? [], 'access.readChannels'))
    // the engine's validator adds the template rules ({{trigger.*}} never reaches a command field)
    try {
      for (const e of validateSlackTrigger({ ...input, match: trigger.match, reply: trigger.reply, limits: trigger.limits }, { workflow: wf })) {
        if (!errors.some((x) => x.message === e.message)) errors.push(e)
      }
    } catch {
      /* engine validator unavailable */
    }
    // COMPANY.md §6: the connected workspace and the workflow must be in the same company
    const ws = this.connector.workspace()
    const companyErrors = triggerCompanyErrors(ws ? this.teamCompany(ws.teamId) : null, this.companyRef(wf.companyId ?? PERSONAL_COMPANY_ID))
    if (companyErrors.length) {
      if (this.h.store.companyGuardsEnforced()) errors.push(...companyErrors)
      else log.warn('slack: company guard (not enforced)', { workflowId: wf.id, problem: companyErrors[0].message })
    }
    // DEPARTMENTS.md §8: task mode and a department exist only with Departments on; the department is this company's
    if (trigger.action === 'task' || trigger.departmentId) {
      if (!departmentsEnabled(this.h.settings().experimental)) errors.push({ path: 'action', message: 'Departments are experimental. Turn on Companies and Departments under Settings → Experimental to add Slack messages to the board.' })
      else errors.push(...triggerDepartmentErrors(trigger.departmentId, trigger.departmentId ? this.h.company.departments.get(trigger.departmentId) : null, wf.companyId ?? PERSONAL_COMPANY_ID))
    }
    if (errors.length) throw new HiveError('validation', errors[0].message, errors)
    return trigger
  }
  /** access.readChannels lists channels only: a DM or group DM (by id or by its mirrored kind) is refused. */
  private readChannelErrors(ids: string[], path: string): ValidationError[] {
    const ws = this.connector.workspace()
    const out: ValidationError[] = []
    for (const id of ids) {
      const c = ws ? this.sql.getChannel(ws.teamId, id) : null
      if (/^D/.test(id) || c?.kind === 'dm' || c?.kind === 'group_dm') out.push({ path, message: `${c ? (c.kind === 'dm' ? `The DM with ${c.name}` : c.name) : id} is a direct message; Slack-triggered runs never read other DMs` })
    }
    return out
  }
  private changedTrigger(t: SlackTrigger): SlackTrigger {
    this.h.safe(() => this.h.engine.slackTriggers?.reload(), undefined)
    emit('slackTrigger:updated', t)
    return t
  }
  createTrigger(input: SlackTriggerInput, origin: SlackTrigger['origin'] = null): SlackTrigger {
    const t = this.normalize(input)
    const disabled = !this.connector.isConfigured()
    return this.changedTrigger(this.triggers.insert(disabled ? { ...t, enabled: false } : t, origin, disabled ? 'Connect Slack to enable' : null))
  }
  updateTrigger(id: Id, input: SlackTriggerInput): SlackTrigger {
    if (!this.triggers.get(id)) throw new HiveError('not_found', 'Slack trigger not found')
    return this.changedTrigger(this.triggers.update(id, this.normalize(input)))
  }
  removeTrigger(id: Id): void {
    this.triggers.remove(id)
    this.h.safe(() => this.h.engine.slackTriggers?.reload(), undefined)
  }
  setTriggerEnabled(id: Id, enabled: boolean): SlackTrigger {
    if (enabled && !this.connector.isConfigured()) throw new HiveError('conflict', 'Connect Slack to enable this trigger')
    return this.changedTrigger(this.triggers.setEnabled(id, enabled))
  }
  testTrigger(input: SlackTriggerInput, sample: { permalink: string } | { channelId: string; ts: string }): SlackTriggerTestResult {
    const t = this.normalize(input)
    const ws = this.connector.workspace()
    if (!ws) throw new HiveError('conflict', 'Connect Slack first')
    const ref = 'permalink' in sample ? parsePermalink(sample.permalink) : { channelId: sample.channelId, ts: sample.ts, threadTs: null }
    if (!ref) throw new HiveError('validation', 'That is not a Slack message link', [{ path: 'sample', message: 'Paste a Slack message link' }])
    const m = this.sql.getMessage(ws.teamId, ref.channelId, ref.ts)
    if (!m) throw new HiveError('not_found', 'Hive has no copy of that message yet (is @hive in the channel?)')
    const ch = this.sql.getChannel(ws.teamId, ref.channelId)
    const u = m.userId ? this.connector.names.users.get(m.userId) : null
    const msg: SlackInboundMessage = {
      teamId: ws.teamId,
      channelId: m.channelId,
      channelKind: ch?.kind ?? 'channel',
      channelName: ch?.name ?? m.channelId,
      ts: m.ts,
      threadTs: m.threadTs,
      userId: m.userId,
      userName: m.userId ? userLabel(u, m.userId) : null,
      botId: m.botId,
      subtype: m.subtype,
      plain: m.plain,
      isMention: m.isMention,
      isDmToBot: ch?.kind === 'dm',
      isOwn: m.fromHive,
      fromBot: !m.fromHive && (!!m.botId || !!u?.isBot),
      eventTime: Number(m.ts),
      receivedAt: Date.now(),
      source: 'event',
      catchup: false,
      author: slackAuthorKind(m.userId ? (this.sql.getUser(ws.teamId, m.userId) ?? u) : null, ws)
    }
    const engine = this.h.engine.slackTriggers
    if (!engine) throw new HiveError('internal', 'Slack triggers are not available in this build yet')
    const r = engine.test({ ...input, match: t.match, reply: t.reply, limits: t.limits, inputs: t.inputs }, msg)
    const who = msg.isOwn || msg.fromBot || !msg.userId ? null : slackAuthorProblem(t.match, msg)
    return who ? { ...r, fires: false, reasons: [...r.reasons, who] } : r
  }
  sentence(input: SlackTriggerInput): string {
    return triggerSentence(this.normalize(input), (id) => this.connector.names.channel(id) ?? id)
  }

  // ---------- authoring: `slack_trigger` on hive_workflow_create/update (SLACK.md §9.5) ----------
  /** Agent args (snake_case, #name / @handle allowed) -> SlackTriggerInput, validated like the editor's. */
  prepareAuthored(raw: unknown, wf: WorkflowDraft): { input: SlackTriggerInput; flag: { sentence: string; replyMode: SlackReplyMode; autoChannels: string[]; fullPermissions: boolean; secretNames: string[]; readChannels: string[]; whoCanTrigger: string } } | { errors: ValidationError[] } {
    const errors: ValidationError[] = []
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [{ path: 'slack_trigger', message: 'slack_trigger must be an object' }] }
    const a = raw as Record<string, unknown>
    const known = new Set(['name', 'on', 'channels', 'keywords', 'regex', 'from_users', 'reply_mode', 'auto_channels', 'reply_node', 'inputs', 'debounce_sec', 'max_runs_per_thread_per_hour', 'enabled', 'unsafe_full_permissions', 'secrets', 'allow_guests', 'read_channels'])
    for (const k of Object.keys(a)) if (!known.has(k)) errors.push({ path: `slack_trigger.${k}`, message: `slack_trigger: unknown field ${k}` })
    const ws = this.connector.workspace()
    const chans = ws ? this.sql.listChannels(ws.teamId) : []
    const users = ws ? this.sql.listUsers(ws.teamId) : []
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [])
    const channel = (ref: string, path: string): string | null => {
      if (ref === 'dm' && path.endsWith('auto_channels')) return 'dm'
      if (path.endsWith('read_channels') && /^D[A-Z0-9]+$/.test(ref)) {
        errors.push({ path, message: `${ref} is a direct message; read_channels lists channels only (Slack-triggered runs never read other DMs)` })
        return null
      }
      if (/^[CGD][A-Z0-9]+$/.test(ref)) return ref
      const name = ref.replace(/^#/, '').toLowerCase()
      const c = chans.find((x) => x.kind !== 'dm' && x.name.toLowerCase() === name)
      if (!c) {
        errors.push({ path, message: `No channel #${name}. Invite @hive first or use the id (slack_list_channels)` })
        return null
      }
      return c.id
    }
    const user = (ref: string): string | null => {
      if (/^[UW][A-Z0-9]+$/.test(ref)) return ref
      const h = ref.replace(/^@/, '').toLowerCase()
      const u = users.find((x) => x.name.toLowerCase() === h || (x.displayName ?? '').toLowerCase() === h)
      if (!u) {
        errors.push({ path: 'slack_trigger.from_users', message: `No Slack user @${h}` })
        return null
      }
      return u.id
    }
    const on = list(a.on) as SlackTriggerInput['match']['on']
    const input: SlackTriggerInput = {
      name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : `${wf.name || 'Workflow'} · Slack`,
      workflowId: 'wf_pending0000',
      enabled: a.enabled !== false,
      match: {
        on,
        channels: list(a.channels).map((c) => channel(c, 'slack_trigger.channels')).filter((x): x is string => !!x),
        keywords: list(a.keywords),
        regex: typeof a.regex === 'string' && a.regex.trim() ? a.regex : null,
        fromUsers: list(a.from_users).map(user).filter((x): x is string => !!x),
        ...(a.allow_guests === true ? { allowGuests: true } : {})
      },
      reply: {
        mode: a.reply_mode === 'auto' || a.reply_mode === 'none' ? a.reply_mode : 'draft',
        autoChannels: list(a.auto_channels).map((c) => channel(c, 'slack_trigger.auto_channels')).filter((x): x is string => !!x),
        ...(a.reply_node !== undefined ? { replyNode: typeof a.reply_node === 'string' ? a.reply_node : null } : {})
      },
      limits: {
        ...(typeof a.debounce_sec === 'number' ? { debounceSec: a.debounce_sec } : {}),
        ...(typeof a.max_runs_per_thread_per_hour === 'number' ? { maxRunsPerThreadPerHour: a.max_runs_per_thread_per_hour } : {})
      },
      inputs: a.inputs && typeof a.inputs === 'object' && !Array.isArray(a.inputs) ? Object.fromEntries(Object.entries(a.inputs as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {},
      // SA2: restricted, no keys unless the agent asks (the card shows it in red and the user must tick it)
      access: {
        fullPermissions: a.unsafe_full_permissions === true,
        secretNames: list(a.secrets),
        readChannels: list(a.read_channels).map((c) => channel(c, 'slack_trigger.read_channels')).filter((x): x is string => !!x)
      }
    }
    if (a.read_channels !== undefined && !Array.isArray(a.read_channels)) errors.push({ path: 'slack_trigger.read_channels', message: 'read_channels must be a list of channels' })
    errors.push(...this.readChannelErrors(input.access?.readChannels ?? [], 'slack_trigger.read_channels'))
    if (a.allow_guests !== undefined && typeof a.allow_guests !== 'boolean') errors.push({ path: 'slack_trigger.allow_guests', message: 'allow_guests must be true or false' })
    if (a.unsafe_full_permissions !== undefined && typeof a.unsafe_full_permissions !== 'boolean') errors.push({ path: 'slack_trigger.unsafe_full_permissions', message: 'unsafe_full_permissions must be true or false' })
    for (const k of list(a.secrets)) if (k === '*' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) errors.push({ path: 'slack_trigger.secrets', message: `"${k}" is not a key name (name each key; "*" is not allowed)` })
    const n = normalizeTrigger(input, wf)
    errors.push(...n.errors.map((e) => ({ path: `slack_trigger.${e.path}`, message: e.message })))
    try {
      for (const e of validateSlackTrigger({ ...input, match: n.trigger.match, reply: n.trigger.reply, limits: n.trigger.limits }, { workflow: wf })) {
        if (!errors.some((x) => x.message === e.message)) errors.push({ path: `slack_trigger.${e.path}`, message: e.message })
      }
    } catch {
      /* engine validator unavailable: main's checks stand */
    }
    if (errors.length) return { errors }
    const name = (id: string) => (id === 'dm' ? 'DMs' : `#${this.connector.names.channel(id) ?? id}`)
    return {
      input: { ...input, match: n.trigger.match, reply: n.trigger.reply, limits: n.trigger.limits, inputs: n.trigger.inputs, access: n.trigger.access },
      flag: {
        sentence: triggerSentence(n.trigger, (id) => this.connector.names.channel(id) ?? id),
        replyMode: n.trigger.reply.mode,
        autoChannels: n.trigger.reply.autoChannels.map(name),
        fullPermissions: n.trigger.access.fullPermissions,
        secretNames: n.trigger.access.secretNames,
        readChannels: (n.trigger.access.readChannels ?? []).map(name),
        whoCanTrigger: slackWhoCanTrigger(n.trigger.match)
      }
    }
  }
  /** On approval: create, or update this workflow's trigger with the same name. */
  saveAuthored(input: SlackTriggerInput, workflowId: Id, origin: SlackTrigger['origin']): void {
    const existing = this.triggers.list({ workflowId }).find((t) => t.name === input.name)
    if (existing) this.updateTrigger(existing.id, { ...input, workflowId })
    else this.createTrigger({ ...input, workflowId }, origin)
  }

  // ---------- built-in responder ----------
  /**
   * Tagging or DMing @hive gets a reply by default: once per install (after Slack is first connected) Hive adds a
   * "Reply in Slack" workflow and a fallback trigger (mention + DM, auto-replies wherever it is tagged). Specific
   * triggers win (fallback). It is an ordinary trigger: the user can switch it to Draft, disable or delete it, and a
   * deleted one is never re-created.
   */
  ensureDefaultResponder(): void {
    try {
      if (!this.connector.isConfigured() || this.h.store.getMeta(DEFAULT_RESPONDER_META)) return
      const profile = this.h.store.defaultProfileFor('claude')
      if (!profile) return
      // COMPANY.md §6: the responder belongs to the workspace's company, or its trigger could never fire there
      const ws = this.connector.workspace()
      const companyId = ws ? this.teamCompany(ws.teamId).id : PERSONAL_COMPANY_ID
      const named = this.h.store.listWorkflows().filter((w) => w.name === DEFAULT_RESPONDER_NAME)
      const wf = this.h.store.seedKeyUsed(DEFAULT_RESPONDER_SEED)
        ? named.find((w) => (w.companyId ?? PERSONAL_COMPANY_ID) === companyId) ?? named[0]
        : this.h.store.createWorkflow(defaultResponderDraft(profile.id), DEFAULT_RESPONDER_SEED, null, companyId)
      if (!wf) return
      this.createTrigger({
        name: 'Reply when tagged',
        workflowId: wf.id,
        enabled: true,
        match: { on: ['mention', 'dm'], channels: [], keywords: [], regex: null, fromUsers: [], fallback: true },
        reply: { mode: 'auto', autoChannels: ['*'], replyNode: 'reply' }
      })
      this.h.store.setMeta(DEFAULT_RESPONDER_META, new Date().toISOString())
      emit('data:changed', { domain: 'workflows' })
      log.info('slack: added the default "Reply when tagged" trigger')
    } catch (e) {
      log.warn('slack: default responder not added', { e: String(e) })
    }
  }

  /** SLACK.md §11.4: an unedited built-in responder gets the prompt that starts Principia sessions for real work. */
  upgradeDefaultResponder(): void {
    try {
      const row = this.h.db.prepare('SELECT id, nodes_json FROM workflows WHERE seed_key = ?').get(DEFAULT_RESPONDER_SEED) as { id: string; nodes_json: string } | undefined
      if (!row) return
      const nodes = JSON.parse(row.nodes_json) as { id?: string; prompt?: string }[]
      const reply = nodes.find((n) => n.id === 'reply')
      if (!reply || reply.prompt !== LEGACY_RESPONDER_PROMPT) return
      const next = (defaultResponderDraft('x').nodes[0] as { prompt?: string }).prompt
      if (!next) return
      reply.prompt = next
      this.h.db.prepare('UPDATE workflows SET nodes_json = ? WHERE id = ?').run(JSON.stringify(nodes), row.id)
      emit('data:changed', { domain: 'workflows' })
      log.info('slack: upgraded the "Reply in Slack" prompt (starts Principia sessions for real work)')
    } catch (e) {
      log.warn('slack: responder prompt not upgraded', { e: String(e) })
    }
  }

  // ---------- Ask an agent about this thread (SLACK.md §12.3) ----------
  askAgent(req: { channelId: string; threadTs: string; profileId?: Id; repoId?: Id | null; cols: number; rows: number }): Session {
    const ws = this.connector.workspace()
    if (!ws) throw new HiveError('conflict', 'Connect Slack first')
    const profile = req.profileId ? this.h.store.getProfile(req.profileId) : this.h.store.defaultProfileFor('claude')
    if (!profile || profile.adapter !== 'claude') throw new HiveError('adapter_unavailable', 'Ask an agent needs a Claude Code profile')
    const ch = this.sql.getChannel(ws.teamId, req.channelId)
    const label = ch ? (ch.kind === 'dm' ? `DM with ${ch.name}` : `#${ch.name}`) : req.channelId
    const dir = this.askDir()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `slack-thread-${req.channelId}-${req.threadTs}-${newId('slackDraft').slice(-8)}.md`)
    fs.writeFileSync(file, `# Slack thread from ${label}\n\n${this.transcript(req.channelId, req.threadTs)}\n`, { mode: 0o600 })
    const prompt = `Here is a Slack thread from ${label} (saved at ${file}). Read it and help me with it. You can read more with mcp__hive__slack_read_thread and draft a reply with mcp__hive__slack_draft_reply.`
    let session: Session
    try {
      // COMPANY.md §6: a chat about a thread runs in the workspace's company. A repo decides its own while guards are
      // off; enforced, the team's company is explicit, so another company's repo is refused (the thread never leaves it)
      const companyId = !req.repoId || this.h.store.companyGuardsEnforced() ? this.teamCompany(ws.teamId).id : undefined
      session = this.h.sessions.create({ profileId: profile.id, repoId: req.repoId ?? null, cols: req.cols, rows: req.rows, initialPrompt: prompt, title: `Slack · ${label}`, ...(companyId ? { companyId } : {}) })
    } catch (e) {
      this.removeFile(file)
      throw e
    }
    this.askFiles.set(session.id, file)
    return session
  }

  // Thread transcripts written for Ask an agent are private Slack content outside the slack_* tables: deleted when the
  // session ends, on disconnect with purge, and by maintenance (older than a day, unless their session still runs).
  private askDir(): string {
    return path.join(this.h.paths.scratchDir, 'slack')
  }
  private removeFile(file: string): void {
    try {
      fs.rmSync(file, { force: true })
    } catch (e) {
      log.warn('slack: could not delete a thread transcript', { e: String(e) })
    }
  }
  /** Session ended (index.ts onExited): drop its thread transcript. */
  sessionExited(sessionId: Id): void {
    const file = this.askFiles.get(sessionId)
    if (!file) return
    this.askFiles.delete(sessionId)
    this.removeFile(file)
  }
  /** Deletes transcript files: all of them, or those older than maxAgeMs that no running session uses. */
  pruneAskFiles(maxAgeMs: number | null): number {
    const dir = this.askDir()
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return 0
    }
    const live = new Set(this.askFiles.values())
    let n = 0
    for (const name of names) {
      if (!/^slack-thread-.*\.md$/.test(name)) continue
      const file = path.join(dir, name)
      if (maxAgeMs !== null) {
        if (live.has(file)) continue
        try {
          if (Date.now() - fs.statSync(file).mtimeMs < maxAgeMs) continue
        } catch {
          continue
        }
      }
      this.removeFile(file)
      n++
    }
    if (maxAgeMs === null) this.askFiles.clear()
    return n
  }
}
