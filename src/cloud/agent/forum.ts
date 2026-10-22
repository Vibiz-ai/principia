/**
 * The Forum in the cloud (CLOUD.md §7.6; FORUM.md). The desktop's ForumService over `<runtime>/forum.db`: each cloud
 * company gets #general, #proposals and its owner. Cloud runs talk to it exactly like desktop runs (MCP server, the
 * `forum` CLI, HTTP on 127.0.0.1 with a per-step token, fenced blocks), as one agent seat per workflow (or per adapter
 * for prompt runs). A `forum_ask` opens a CloudAsk (ports.openAsk), which shows in Needs you; the answer is posted in
 * the thread and wakes a waiting agent, or, when the run already ended, asks the control plane for a resume run.
 * v1 has no Forum client in the cloud: a run's posts are part of its run detail (`forumPosts`).
 */
import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { chownTree } from './sandbox'
import { dirname } from 'node:path'
import type { CloudAdapter, CloudForumMessage } from '../../shared/cloud'
import type { ForumBridge, ForumSpawn } from '../../shared/engine'
import type { ForumEvent, ForumMessage } from '../../shared/forum'
import { ForumService } from '../../main/forum/service'
import type { ForumDirectory } from '../../main/forum/store'
import type { ControlPorts } from '../contract'
import { CloudRuntimeError } from './errors'

const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS cloud_companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_seats (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (company_id, key));
-- ForumService.harvest reads runs(agent_id, task_id, company_id) of the run that wrote a fenced block
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, agent_id TEXT, task_id TEXT, company_id TEXT, adapter TEXT);
CREATE TABLE IF NOT EXISTS cloud_asks (ask_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, company_id TEXT NOT NULL, cloud_run_id TEXT, engine_run_id TEXT, adapter TEXT, created_at TEXT NOT NULL, answered_at TEXT);
`

const ADAPTER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', cursor: 'Cursor', shell: 'Shell' }

export interface CloudRunRef {
  cloudRunId: string
  companyId: string
  /** still queued or running (an answer reaches it live) */
  active: boolean
}

export interface CloudForumDeps {
  dbPath: string
  /** `<runtime>/forum-shims` */
  spawnRoot: string
  /** CLOUD.md §7.8: each step's `forum` shim belongs to the agent user that runs it */
  agentUser?: { uid: number; gid: number } | null
  /** forum-cli.mjs in the bundle; null = no CLI or MCP (fenced blocks only) */
  cliScript: string | null
  execPath?: string
  redact(s: string): string
  now(): Date
  ports: Pick<ControlPorts, 'openAsk' | 'forumEvent' | 'requestRun' | 'log'>
  /** engine run id -> the cloud run */
  cloudRun(engineRunId: string): CloudRunRef | null
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export class CloudForum implements ForumBridge {
  readonly db: Database.Database
  readonly service: ForumService

  constructor(private readonly d: CloudForumDeps) {
    mkdirSync(dirname(d.dbPath), { recursive: true, mode: 0o700 })
    this.db = new Database(d.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(DDL)
    const directory: ForumDirectory = {
      departments: () => [],
      agents: (companyId) =>
        (this.db.prepare('SELECT id, name FROM cloud_seats WHERE company_id=? ORDER BY created_at').all(companyId) as { id: string; name: string }[]).map((s) => ({
          id: s.id,
          departmentId: null,
          name: s.name,
          archivedAt: null,
          personaName: s.name
        })),
      ownerName: () => 'Owner',
      hasCompany: (id) => !!this.db.prepare('SELECT 1 FROM cloud_companies WHERE id=?').get(id)
    }
    mkdirSync(d.spawnRoot, { recursive: true, mode: 0o700 })
    if (d.agentUser) chmodSync(d.spawnRoot, 0o711)
    this.service = new ForumService({
      db: this.db,
      directory,
      enabled: () => true,
      emit: (e) => this.onEvent(e),
      redact: d.redact,
      cliScript: d.cliScript,
      execPath: d.execPath ?? process.execPath,
      spawnRoot: d.spawnRoot,
      now: d.now,
      log: d.ports.log
    })
  }

  async start(): Promise<string | null> {
    return this.service.start()
  }

  // ---------- companies and seats ----------

  ensureCompany(c: { companyId: string; name: string; slug: string }): void {
    this.db
      .prepare('INSERT INTO cloud_companies(id,name,slug,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, slug=excluded.slug')
      .run(c.companyId, c.name, c.slug, this.d.now().toISOString())
    this.service.store.sync(c.companyId)
  }

  hasCompany(companyId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM cloud_companies WHERE id=?').get(companyId)
  }

  removeCompany(companyId: string): void {
    this.db.transaction(() => {
      const members = this.db.prepare('SELECT id FROM forum_members WHERE company_id=?').all(companyId) as { id: string }[]
      for (const m of members) this.db.prepare('DELETE FROM forum_channel_members WHERE member_id=?').run(m.id)
      for (const t of ['forum_mentions', 'forum_messages', 'forum_channels', 'forum_members', 'forum_invites']) this.db.prepare(`DELETE FROM ${t} WHERE company_id=?`).run(companyId)
      for (const t of ['cloud_seats', 'cloud_asks', 'runs']) this.db.prepare(`DELETE FROM ${t} WHERE company_id=?`).run(companyId)
      this.db.prepare('DELETE FROM cloud_companies WHERE id=?').run(companyId)
    })()
  }

  /** The agent seat a run posts as (one per workflow, or per adapter for prompt runs). Idempotent. */
  seat(companyId: string, key: string, name: string): string {
    const row = this.db.prepare('SELECT id, name FROM cloud_seats WHERE company_id=? AND key=?').get(companyId, key) as { id: string; name: string } | undefined
    if (row) {
      if (row.name !== name) this.db.prepare('UPDATE cloud_seats SET name=? WHERE id=?').run(name, row.id)
      this.service.store.sync(companyId)
      return row.id
    }
    const id = `cseat_${companyId.slice(0, 24)}_${Buffer.from(key).toString('base64url').slice(0, 40)}`
    this.db.prepare('INSERT INTO cloud_seats(id,company_id,key,name,created_at) VALUES (?,?,?,?,?)').run(id, companyId, key, clip(name, 60), this.d.now().toISOString())
    this.service.store.sync(companyId)
    return id
  }

  /** The engine run this seat runs as (read by the fenced-block harvest). */
  registerRun(engineRunId: string, r: { agentId: string; cloudRunId: string; companyId: string }): void {
    this.db.prepare('INSERT OR REPLACE INTO runs(id, agent_id, task_id, company_id) VALUES (?,?,?,?)').run(engineRunId, r.agentId, r.cloudRunId, r.companyId)
  }

  // ---------- engine bridge ----------

  open(req: Parameters<ForumBridge['open']>[0]): ForumSpawn | null {
    const spawn = this.service.open(req)
    if (spawn?.binDir && this.d.agentUser) chownTree(spawn.binDir, this.d.agentUser, true)
    if (spawn) this.db.prepare('UPDATE runs SET adapter=? WHERE id=?').run(req.adapter, req.runId)
    return spawn
  }
  close(stepId: string): void {
    this.service.close(stepId)
  }

  /** EngineContext.onStepOutput: apply ```forum blocks of the step. */
  harvest(e: { runId: string; stepId: string; adapter: string; status: string; output: string; companyId: string | null }): Promise<number> {
    return this.service.harvest(e)
  }

  // ---------- events and asks ----------

  private onEvent(e: ForumEvent): void {
    if (e.kind !== 'message') return
    const m = e.message
    try {
      this.d.ports.forumEvent(e.companyId, m.channelId, m.id)
    } catch (err) {
      this.d.ports.log.warn('forum: event port failed', { error: String(err) })
    }
    if (m.kind === 'ask' && m.ask?.status === 'open') this.openAsk(m)
  }

  private openAsk(m: ForumMessage): void {
    const author = this.service.store.member(m.authorId)
    if (!author || author.kind !== 'agent') return
    if (this.db.prepare('SELECT 1 FROM cloud_asks WHERE message_id=?').get(m.id)) return
    const engineRunId = m.ask?.runId ?? null
    const ref = engineRunId ? this.d.cloudRun(engineRunId) : null
    const adapter = engineRunId ? ((this.db.prepare('SELECT adapter FROM runs WHERE id=?').get(engineRunId) as { adapter: string | null } | undefined)?.adapter ?? null) : null
    const question = m.text.replace(/^(?:@[a-z0-9._-]+\s+)+/i, '').trim()
    try {
      const askId = this.d.ports.openAsk({
        companyId: m.companyId,
        runId: ref?.cloudRunId ?? null,
        agentName: adapter && (ADAPTER_LABEL[adapter] ?? adapter) !== author.name ? `${author.name} · ${ADAPTER_LABEL[adapter] ?? adapter}` : author.name,
        question: this.d.redact(clip(question, 2000)),
        options: m.ask?.options ?? []
      })
      this.db
        .prepare('INSERT OR IGNORE INTO cloud_asks(ask_id, message_id, company_id, cloud_run_id, engine_run_id, adapter, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(askId, m.id, m.companyId, ref?.cloudRunId ?? null, engineRunId, adapter, this.d.now().toISOString())
    } catch (err) {
      this.d.ports.log.warn('forum: openAsk failed', { error: String(err) })
    }
  }

  /** Open asks a run left behind (its status becomes needs_input). */
  openAsksOf(engineRunId: string): { askId: string; question: string }[] {
    const rows = this.db.prepare('SELECT ask_id, message_id FROM cloud_asks WHERE engine_run_id=? AND answered_at IS NULL').all(engineRunId) as { ask_id: string; message_id: string }[]
    const out: { askId: string; question: string }[] = []
    for (const r of rows) {
      try {
        const m = this.service.store.message(r.message_id)
        if (m.ask?.status === 'open') out.push({ askId: r.ask_id, question: m.text.replace(/^(?:@[a-z0-9._-]+\s+)+/i, '').trim() })
      } catch {
        /* deleted */
      }
    }
    return out
  }

  /**
   * The human answered (runtime.answerAsk). Posts the answer in the thread and wakes a waiting agent; when the run
   * already ended, asks the control plane for a resume run (trigger 'answer') carrying the thread.
   */
  answer(askId: string, answer: string): { resumed: string | null; refused: string | null } {
    const row = this.db.prepare('SELECT * FROM cloud_asks WHERE ask_id=?').get(askId) as
      | { ask_id: string; message_id: string; company_id: string; cloud_run_id: string | null; engine_run_id: string | null; adapter: string | null; answered_at: string | null }
      | undefined
    if (!row) throw new CloudRuntimeError('not_found', 'That question is not in the cloud Forum')
    const text = answer.trim()
    if (!text) throw new CloudRuntimeError('bad_request', 'The answer is empty')
    // idempotent: a retried or double-clicked answer never posts twice or requests a second resume run
    if (row.answered_at) return { resumed: null, refused: 'already answered' }
    const owner = this.service.store.owner(row.company_id)
    const msg = this.service.store.message(row.message_id)
    if (msg.ask?.status === 'open') this.service.answer(row.message_id, owner.id, text)
    this.db.prepare('UPDATE cloud_asks SET answered_at=? WHERE ask_id=?').run(this.d.now().toISOString(), askId)
    const ref = row.engine_run_id ? this.d.cloudRun(row.engine_run_id) : null
    if (ref?.active) return { resumed: null, refused: null }
    const adapter = (['claude', 'codex', 'gemini'].includes(row.adapter ?? '') ? row.adapter : 'claude') as CloudAdapter
    const r = this.d.ports.requestRun({ companyId: row.company_id, trigger: 'answer', target: { kind: 'prompt', adapter, prompt: this.resumePrompt(row.message_id, text) } })
    return { resumed: r.runId, refused: r.refused }
  }

  /** The prompt of a resume run: the thread so far and the answer. */
  resumePrompt(messageId: string, answer: string): string {
    const t = this.service.store.thread(messageId, 30)
    const name = (id: string) => this.service.store.member(id)?.name ?? 'someone'
    const lines = [t.root, ...t.replies].map((m) => `${name(m.authorId)}: ${clip(m.text, 1500)}`)
    return this.d.redact(
      [
        'You asked a question in the Forum during an earlier run that has ended. The owner answered.',
        '',
        `Thread (${t.root.ref}):`,
        ...lines,
        '',
        `Answer: ${clip(answer, 4000)}`,
        '',
        'Continue the work from where it stopped, using this answer.'
      ].join('\n')
    )
  }

  /** CloudRunDetail.forumPosts: what this seat posted from the run's steps, oldest first, redacted. */
  postsOf(companyId: string, agentId: string, stepIds: string[], engineRunId: string): CloudForumMessage[] {
    const member = this.service.store.memberForAgent(agentId)
    if (!member || member.companyId !== companyId) return []
    // newest first: a seat lives as long as its workflow, so a long-running schedule's recent posts must not fall
    // outside the window
    const rows = (this.db.prepare('SELECT seq, origin, data FROM forum_messages WHERE company_id=? AND author_id=? AND deleted_at IS NULL ORDER BY seq DESC LIMIT 2000').all(companyId, member.id) as { seq: number; origin: string; data: string }[]).reverse()
    const steps = new Set(stepIds)
    const out: CloudForumMessage[] = []
    for (const r of rows) {
      const stepId = r.origin.startsWith('agent:') ? r.origin.slice(6) : null
      let askRun: string | null = null
      try {
        askRun = (JSON.parse(r.data) as { ask?: { runId?: string } }).ask?.runId ?? null
      } catch {
        /* no payload */
      }
      if (!(stepId && steps.has(stepId)) && askRun !== engineRunId) continue
      out.push(this.toCloud(this.service.store.message(r.seq)))
    }
    return out.slice(-200)
  }

  toCloud(m: ForumMessage): CloudForumMessage {
    const author = this.service.store.member(m.authorId)
    return {
      id: m.id,
      channelId: m.channelId,
      threadId: m.threadId,
      author: { kind: author?.kind ?? 'agent', name: author?.name ?? 'Unknown', role: author?.role ?? null },
      kind: m.kind,
      text: this.d.redact(m.text),
      createdAt: m.createdAt,
      replies: m.replyCount
    }
  }

  async shutdown(): Promise<void> {
    await this.service.stop()
    this.db.close()
  }
}
