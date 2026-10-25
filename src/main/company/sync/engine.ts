/**
 * LINEAR.md §3–§5: one sync pass for one company, provider-neutral. Pull what changed in the tracker, decide each
 * linked field by its fingerprints (one side changed: it goes to the other; both changed: the newer timestamp wins and
 * the activity says so; neither: nothing is sent), bring new issues over as tasks, and send the company's new tasks
 * out, parents first. No timers and no Electron here: service.ts schedules passes and handles keys.
 */
import type { BoardTask, CompanyTaskInput, TaskBoardFields, TaskStatus } from '../../../shared/company'
import { FIELD_LABEL, SYNC_FIELDS, cleanIssue, fingerprint, fingerprints, localValues, outgoingBody, remoteValues, type SyncField } from './fields'
import { SyncError, type IssueFields, type RemoteIssue, type TaskSyncProvider, type TeamInfo } from './provider'
import type { Fingerprints, SyncConnection, SyncLink, SyncStore } from './store'

/** What a pass may write on a task, as the tracker has it. */
export interface RemotePatch {
  title?: string; description?: string; status?: TaskStatus; priority?: 0 | 1 | 2 | 3 | 4; labels?: string[]; estimate?: number | null; dueDate?: string | null; parentId?: string | null; doneNote?: string | null
}
/** The slice of the Board a pass uses (CompanyStore in the app, a fake in tests). */
export interface SyncTaskHost {
  tasks(companyId: string): BoardTask[]
  /** a task made from an issue; a source link seen before returns that task with existed = true */
  createFromRemote(input: CompanyTaskInput & Partial<TaskBoardFields>): { task: BoardTask; existed: boolean }
  /** writes the tracker's values (no Board transition rules apply: the tracker is not a human or an agent) */
  applyRemote(taskId: string, patch: RemotePatch, message: string): BoardTask
  /** one activity line on the task, by system */
  note(taskId: string, message: string): void
  /** a run or session holds the task: its status is not changed from outside */
  inFlight(task: BoardTask): boolean
  depsDone(task: BoardTask): boolean
}
/** `skipped`: issues or tasks left for a later pass (an issue the Board cannot hold, a request Linear turned down); `gone`: tasks unlinked because their issue is gone. */
export interface SyncResult { pulled: number; created: number; sent: number; pushed: number; applied: number; skipped: number; gone: number; truncated: boolean; problems: string[] }

const OPEN = (s: TaskStatus) => s !== 'done' && s !== 'canceled'
const SIDE = { linear: 'Linear' } as const
const time = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0 }
/**
 * A tracker's review is a teammate's, not an agent's: without a review report from a run here it reads as in
 * progress there (LINEAR.md §3), so it never lands in Needs you as agent work waiting for approval.
 */
export function boardStatus(remote: TaskStatus, task: Pick<BoardTask, 'report'> | null): TaskStatus {
  return remote === 'in_review' && task?.report?.outcome !== 'review' ? 'in_progress' : remote
}
/** Failures that stay with one issue or task; any other error (key, network, rate limit) ends the pass. */
const perIssue = (e: unknown): boolean => !(e instanceof PassAborted) && (!(e instanceof SyncError) || e.code === 'refused' || e.code === 'gone')
const why = (e: unknown): string => (e instanceof SyncError ? e.message : String((e as Error)?.message ?? e)).slice(0, 200)
type Tally = { pushed: number; applied: number; gone: number }
/** The company disconnected (or changed team) while the pass waited on the tracker: the rest of the pass is dropped. */
export class PassAborted extends Error { constructor() { super('Linear sync pass dropped: the connection changed'); this.name = 'PassAborted' } }

export class TaskSyncEngine {
  constructor(private readonly store: SyncStore, private readonly host: SyncTaskHost, private readonly now: () => Date = () => new Date()) {}

  async run(conn: SyncConnection, provider: TaskSyncProvider): Promise<SyncResult> {
    const name = SIDE[provider.kind]
    const info = await provider.states(conn.teamId)
    const page = await provider.changedSince(conn.teamId, conn.cursor)
    this.live(conn)
    page.issues = page.issues.map(cleanIssue)
    const result: SyncResult = { pulled: page.issues.length, created: 0, sent: 0, pushed: 0, applied: 0, skipped: 0, gone: 0, truncated: page.truncated, problems: [] }
    const add = (n: Tally) => { result.pushed += n.pushed; result.applied += n.applied; result.gone += n.gone }
    const skip = (what: string, e: unknown) => { if (!perIssue(e)) throw e; result.skipped++; result.problems.push(`${what}: ${why(e)}`) }
    const byRemote = new Map(this.store.links(conn.companyId).map((l) => [l.remoteId, l]))
    const touched = new Set<string>()
    const fresh: { link: SyncLink; issue: RemoteIssue }[] = []

    // 1. issues: new ones become tasks, linked ones are reconciled field by field
    // one issue that fails (the Board cannot hold it, Linear turns its update down) never stops the others
    for (const issue of page.issues) {
      try {
        const link = byRemote.get(issue.id)
        if (link) {
          touched.add(link.remoteId)
          add(await this.reconcile(conn, provider, info, link, issue, name))
          continue
        }
        if (issue.closed && conn.cursor) continue // closed after we stopped looking: not worth a new task
        const made = this.importIssue(conn, issue, info)
        if (!made) continue
        byRemote.set(issue.id, made.link)
        touched.add(issue.id)
        if (made.existed) add(await this.reconcile(conn, provider, info, made.link, issue, name)); else { result.created++; fresh.push({ link: made.link, issue }) }
      } catch (e) { skip(issue.key, e) }
    }
    // 2. new tasks' parents, once every issue of the page has its task
    for (const { link, issue } of fresh) {
      if (!issue.parentId) continue
      const parent = byRemote.get(issue.parentId)
      if (!parent) continue
      try {
        this.host.applyRemote(link.taskId, { parentId: parent.taskId }, `${name} set the parent`)
        this.agree(link, ['parent'], issue)
      } catch (e) { skip(issue.key, e) }
    }
    // 3. local changes on linked tasks Linear did not report
    for (const link of [...byRemote.values()]) {
      if (touched.has(link.remoteId)) continue
      try { add(await this.reconcile(conn, provider, info, link, null, name)) } catch (e) { skip(link.key, e) }
    }
    // 4. new local tasks go out, parents before children
    result.sent = await this.sendNew(conn, provider, info, byRemote, name, skip)
    const cursor = page.cursor && (!conn.cursor || page.cursor > conn.cursor) ? page.cursor : conn.cursor
    this.store.patchConnection(conn.companyId, { cursor, lastSyncedAt: this.now().toISOString(), state: 'ok', message: null })
    return result
  }

  /** Throws PassAborted when the connection this pass started with is gone or now points at another team. */
  private live(conn: SyncConnection): void {
    const now = this.store.connection(conn.companyId)
    if (!now || now.teamId !== conn.teamId || now.connectedAt !== conn.connectedAt) throw new PassAborted()
  }

  private tasksById(companyId: string): Map<string, BoardTask> { return new Map(this.host.tasks(companyId).map((t) => [t.id, t])) }

  /** The parent as the tracker names it: its linked issue id, null for no parent, undefined while it is not linked. */
  private parentRemote(task: BoardTask, links: Map<string, SyncLink>): string | null | undefined {
    if (!task.parentId) return null
    return links.get(task.parentId)?.remoteId
  }
  private linksByTask(companyId: string): Map<string, SyncLink> { return new Map(this.store.links(companyId).map((l) => [l.taskId, l])) }

  private importIssue(conn: SyncConnection, issue: RemoteIssue, info: TeamInfo): { link: SyncLink; existed: boolean } | null {
    // an issue linked before a disconnect (sent from here, or brought over) finds its task again
    const before = this.store.seen(conn.companyId, conn.provider, issue.id)
    const seen = before ? this.tasksById(conn.companyId).get(before.taskId) : undefined
    const { task, existed } = seen ? { task: seen, existed: true } : this.host.createFromRemote({
      title: issue.title.slice(0, 240) || issue.key, description: issue.description.slice(0, 50_000), companyId: conn.companyId, repoId: null, status: boardStatus(issue.status, null), priority: issue.priority,
      source: 'linear', sourceUrl: issue.url, externalId: issue.key, assigneeProfileId: null, parentId: null, dependencyIds: [],
      labels: issue.labels.slice(0, 50), estimate: info.estimates ? issue.estimate : null, dueDate: issue.dueDate, doneNote: issue.status === 'done' ? `Done in ${SIDE[conn.provider]}` : null
    })
    if (existed && this.store.link(task.id)) return null
    const r = fingerprints(remoteValues(issue))
    // a task linked before a disconnect takes back the fingerprints it had then, so only what changed since moves
    // (a field the disconnect itself changed, like a status released to Todo, was marked to take Linear's value);
    // without them nothing is agreed yet, and each field that differs goes to the newer side
    const prior = existed && before?.taskId === task.id ? before.link : null
    const link: SyncLink = { taskId: task.id, companyId: conn.companyId, provider: conn.provider, remoteId: issue.id, key: issue.key, url: issue.url, stateId: issue.stateId,
      local: existed ? { ...(prior?.local ?? {}) } : this.localPrints(task, this.linksByTask(conn.companyId)), remote: existed ? { ...(prior?.remote ?? {}) } : r, remoteUpdatedAt: issue.updatedAt, remoteStatus: issue.status }
    if (!existed) { link.local.parent = fingerprint(null); link.remote.parent = fingerprint(null) }
    this.store.saveLink(link)
    if (!existed) this.host.note(task.id, `${SIDE[conn.provider]} brought this over as ${issue.key}`)
    return { link, existed }
  }
  private localPrints(task: BoardTask, links: Map<string, SyncLink>): Fingerprints { return fingerprints(localValues(task, this.parentRemote(task, links))) }
  /** Marks fields agreed as they are now on both sides (after a write on one of them). */
  private agree(link: SyncLink, fields: SyncField[], issue: RemoteIssue): void {
    const task = this.tasksById(link.companyId).get(link.taskId)
    if (!task) return
    const l = localValues(task, this.parentRemote(task, this.linksByTask(link.companyId)))
    const r = remoteValues(issue)
    for (const f of fields) { link.local[f] = fingerprint(l[f]); link.remote[f] = fingerprint(r[f]) }
    this.store.saveLink(link)
  }

  /** One linked task against its issue (null: the tracker reported no change). */
  private async reconcile(conn: SyncConnection, provider: TaskSyncProvider, info: TeamInfo, link: SyncLink, issue: RemoteIssue | null, name: string): Promise<Tally> {
    let task = this.tasksById(conn.companyId).get(link.taskId)
    if (!task) return { pushed: 0, applied: 0, gone: 0 }
    // brought over as in review by an earlier build: a review in Linear with no report here reads as in progress
    const remoteNow = issue?.status ?? link.remoteStatus ?? null
    if (task.status === 'in_review' && remoteNow === 'in_review' && boardStatus('in_review', task) === 'in_progress' && link.local.status === fingerprint('in_review')) {
      try {
        task = this.host.applyRemote(task.id, { status: 'in_progress' }, `In review in ${name}: shown as in progress there`)
        link.local.status = fingerprint('in_progress')
      } catch { /* left as it is */ }
    }
    const links = this.linksByTask(conn.companyId)
    const L = localValues(task, this.parentRemote(task, links))
    const Lh = fingerprints(L)
    const R = issue ? remoteValues(issue) : null
    const Rh = R ? fingerprints(R) : null
    const out: IssueFields = {}
    const incoming: RemotePatch = {}
    const incomingFields: SyncField[] = []
    const outFields: SyncField[] = []
    const agreed: SyncField[] = []
    const lines: string[] = []
    for (const f of SYNC_FIELDS) {
      if (f === 'estimate' && !info.estimates) continue
      if (L[f] === undefined) continue // parent not linked yet
      const lc = Lh[f] !== link.local[f]
      const rc = !!Rh && Rh[f] !== link.remote[f]
      if (!lc && !rc) continue
      let side: 'local' | 'remote'
      if (lc && rc) {
        if (this.same(f, task, issue!, L)) { agreed.push(f); continue }
        // per field: when this field last changed here (task.updatedAt moves on any write)
        side = time(this.store.fieldTime(task.id, f, Lh[f]) ?? task.updatedAt) >= time(issue!.updatedAt) ? 'local' : 'remote'
        lines.push(side === 'remote' ? `${name}’s ${FIELD_LABEL[f]} replaced yours` : `Your ${FIELD_LABEL[f]} replaced ${name}’s`)
      } else side = lc ? 'local' : 'remote'
      if (side === 'local') { this.outField(f, task, links, out); outFields.push(f); continue }
      // remote wins this field
      const r = issue!
      if (f === 'status') {
        // `blocked` is ours only: it went out as started, and an incoming started never undoes it
        if (task.status === 'blocked' && r.status === 'in_progress') { agreed.push(f); continue }
        if (this.host.inFlight(task)) continue // a run holds the task; decided again after it ends
        const want = boardStatus(r.status, task)
        if (want === 'done' && !this.host.depsDone(task)) continue
        if (want === task.status) { agreed.push(f); continue }
        incoming.status = want
        if (want === 'done') incoming.doneNote = task.doneNote?.trim() ? task.doneNote : `Done in ${name}`
      } else if (f === 'parent') {
        const parent = r.parentId ? [...links.values()].find((l) => l.remoteId === r.parentId) : null
        if (r.parentId && !parent) continue // the parent issue is not here yet
        incoming.parentId = parent?.taskId ?? null
      } else if (f === 'title') incoming.title = r.title.slice(0, 240) || r.key
      else if (f === 'description') incoming.description = r.description.slice(0, 50_000)
      else if (f === 'priority') incoming.priority = r.priority
      else if (f === 'labels') incoming.labels = r.labels.slice(0, 50)
      else if (f === 'estimate') incoming.estimate = r.estimate
      else if (f === 'dueDate') incoming.dueDate = r.dueDate
      incomingFields.push(f)
    }

    let applied = 0
    if (incomingFields.length) {
      try {
        this.host.applyRemote(task.id, incoming, `${name} changed the ${incomingFields.map((f) => FIELD_LABEL[f]).join(', ')}`)
        applied = 1
      } catch {
        // a value the Board refuses (a parent cycle, say): leave those fields for the next pass
        incomingFields.length = 0
      }
    }
    for (const line of lines) this.host.note(task.id, line)
    let latest = issue
    let pushed = 0
    if (outFields.length) {
      try {
        latest = cleanIssue(await provider.update(conn.teamId, link.remoteId, out, issue?.stateId ?? link.stateId))
        pushed = 1
      } catch (e) {
        this.live(conn)
        if (e instanceof SyncError && e.code === 'gone') {
          // deleted in Linear (or purged from its trash, or out of the key's reach): this task alone is unlinked
          this.store.dropLink(task.id)
          this.host.note(task.id, `${link.key} is gone from ${name} (deleted there, or out of this key’s reach). Unlinked; the task stays here.`)
          return { pushed: 0, applied, gone: 1 }
        }
        if (!(e instanceof SyncError && e.code === 'refused')) throw e
        // turned down: what we meant to send stays undecided and is tried again next pass; what came in is kept
        outFields.length = 0
        this.saveDecided(conn, link, task, issue, Rh, null, [...incomingFields, ...agreed], [])
        throw e
      }
    }
    if (pushed) this.live(conn)
    this.saveDecided(conn, link, task, issue, Rh, latest, [...incomingFields, ...outFields, ...agreed], outFields)
    return { pushed, applied, gone: 0 }
  }

  /** Fingerprints: every field decided this pass is agreed as both sides now have it. */
  private saveDecided(conn: SyncConnection, link: SyncLink, task: BoardTask, issue: RemoteIssue | null, Rh: Record<SyncField, string> | null, latest: RemoteIssue | null, decided: SyncField[], outFields: SyncField[]): void {
    if (decided.length) {
      const now = this.tasksById(conn.companyId).get(task.id) ?? task
      const l = fingerprints(localValues(now, this.parentRemote(now, this.linksByTask(conn.companyId))))
      const r = latest ? fingerprints(remoteValues(latest)) : null
      for (const f of decided) {
        link.local[f] = l[f]
        // a field we sent takes the tracker's answer; one we took or agreed takes what was pulled
        if (outFields.includes(f)) { if (r) link.remote[f] = r[f] } else if (issue && Rh) link.remote[f] = Rh[f]
      }
    }
    if (latest) { link.stateId = latest.stateId; link.remoteUpdatedAt = latest.updatedAt; link.key = latest.key; link.url = latest.url; link.remoteStatus = latest.status }
    this.store.saveLink(link)
  }

  /** Both sides changed a field to values that mean the same thing. */
  private same(f: SyncField, task: BoardTask, issue: RemoteIssue, L: Record<SyncField, unknown>): boolean {
    if (f === 'status') return boardStatus(issue.status, task) === task.status || (task.status === 'blocked' && issue.status === 'in_progress')
    return fingerprint(L[f]) === fingerprint(remoteValues(issue)[f])
  }

  private outField(f: SyncField, task: BoardTask, links: Map<string, SyncLink>, out: IssueFields): void {
    switch (f) {
      case 'title': out.title = task.title; break
      case 'description': out.description = outgoingBody(task); break
      case 'status': out.status = task.status; break
      case 'priority': out.priority = task.priority; break
      case 'labels': out.labels = task.labels ?? []; break
      case 'estimate': out.estimate = task.estimate ?? null; break
      case 'dueDate': out.dueDate = task.dueDate ?? null; break
      case 'parent': out.parentId = this.parentRemote(task, links) ?? null; break
    }
  }

  private eligible(conn: SyncConnection, t: BoardTask): boolean {
    if (!OPEN(t.status) || t.source === 'schedule' || t.source === 'linear') return false
    return conn.sendFrom === null || t.createdAt >= conn.sendFrom
  }

  /** Tasks of the company that should exist in the tracker and do not yet: created there, parents first. */
  private async sendNew(conn: SyncConnection, provider: TaskSyncProvider, info: TeamInfo, byRemote: Map<string, SyncLink>, name: string, skip: (what: string, e: unknown) => void): Promise<number> {
    const all = this.tasksById(conn.companyId)
    const linked = this.linksByTask(conn.companyId)
    const todo = [...all.values()].filter((t) => !linked.has(t.id) && this.eligible(conn, t))
    if (!todo.length) return 0
    const depth = (t: BoardTask): number => { let d = 0; let p = t.parentId; const seen = new Set<string>(); while (p && !seen.has(p) && d < 50) { seen.add(p); d++; p = all.get(p)?.parentId ?? null } return d }
    todo.sort((a, b) => depth(a) - depth(b) || a.createdAt.localeCompare(b.createdAt))
    let sent = 0
    for (const t of todo) {
      const links = this.linksByTask(conn.companyId)
      const parent = this.parentRemote(t, links)
      const fields: IssueFields & { title: string } = { title: t.title, description: outgoingBody(t), status: t.status, priority: t.priority, labels: t.labels ?? [], dueDate: t.dueDate ?? null, ...(info.estimates && t.estimate != null ? { estimate: t.estimate } : {}), ...(parent ? { parentId: parent } : {}) }
      let issue: RemoteIssue
      try { issue = cleanIssue(await provider.create(conn.teamId, fields)) } catch (e) { this.live(conn); skip(t.identifier, e); continue }
      this.live(conn) // an issue made just as the company disconnected stays in Linear, unlinked
      const link: SyncLink = { taskId: t.id, companyId: conn.companyId, provider: conn.provider, remoteId: issue.id, key: issue.key, url: issue.url, stateId: issue.stateId, local: {}, remote: {}, remoteUpdatedAt: issue.updatedAt, remoteStatus: issue.status }
      const l = fingerprints(localValues(t, parent))
      const r = fingerprints(remoteValues(issue))
      for (const f of SYNC_FIELDS) { link.local[f] = l[f]; link.remote[f] = r[f] }
      this.store.saveLink(link)
      byRemote.set(issue.id, link)
      this.host.note(t.id, `Sent to ${name} as ${issue.key}`)
      sent++
    }
    return sent
  }
}
