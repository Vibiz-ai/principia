/**
 * LINEAR.md §2: Linear over its GraphQL API with a personal API key. The key travels in the Authorization header of a
 * request made in main and nowhere else; errors carry our own words (provider.ts), never Linear's body.
 * PRINCIPIA_LINEAR_API points the client at a fake Linear on this Mac (loopback only), for tests and QA.
 */
import type { TaskStatus } from '../../../shared/company'
import { FIRST_PULL_CAP, FIRST_PULL_CLOSED_DAYS, SyncError, type ChangedPage, type IssueFields, type RemoteIssue, type RemoteState, type RemoteTeam, type TaskSyncProvider, type TeamInfo } from './provider'

export const LINEAR_API = 'https://api.linear.app/graphql'
/** The company key name (company_secrets, listed on the Keys page like any BYOK key). */
export { LINEAR_KEY_NAME } from '../../../shared/linear'

/** The endpoint: PRINCIPIA_LINEAR_API when it is a loopback http(s) URL, else the real API. */
export function linearEndpoint(env: Record<string, string | undefined> = process.env): string {
  const v = env.PRINCIPIA_LINEAR_API?.trim()
  if (!v) return LINEAR_API
  try {
    const u = new URL(v)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u.toString()
  } catch { /* fall through */ }
  return LINEAR_API
}

/** A pasted key that cannot be a Linear personal key (checked before any request). */
export function linearKeyProblem(key: string): string | null {
  const k = key.trim()
  if (!k) return 'Paste a Linear personal API key.'
  if (/\s/.test(k)) return 'The key has spaces in it. Copy it again from Linear › Settings › Security & access.'
  if (k.length < 20 || k.length > 200) return 'That does not look like a Linear API key. It starts with lin_api_.'
  return null
}

// ---------- status and priority (pinned by linear.test.ts) ----------

const isReview = (name: string): boolean => /review/i.test(name)
/** A Linear workflow state as a Board status. */
export function statusFromState(s: { type: string; name: string }): TaskStatus {
  switch (s.type) {
    case 'triage': return 'triage'
    case 'backlog': return 'backlog'
    case 'unstarted': return 'todo'
    case 'started': return isReview(s.name) ? 'in_review' : 'in_progress'
    case 'completed': return 'done'
    case 'canceled': return 'canceled'
    default: return 'backlog'
  }
}
/**
 * The team's state for a Board status: the first by position of the matching type. `blocked` is ours only and goes
 * out as the first non-review started state. When `current` already means `status`, it is kept (no needless move).
 */
export function stateForStatus(states: readonly RemoteState[], status: TaskStatus, current?: string | null): RemoteState | null {
  const cur = current ? states.find((s) => s.id === current) : undefined
  const want: TaskStatus = status === 'blocked' ? 'in_progress' : status
  if (cur && statusFromState(cur) === want) return cur
  const sorted = [...states].sort((a, b) => a.position - b.position)
  const of = (type: string) => sorted.filter((s) => s.type === type)
  const started = of('started')
  switch (want) {
    case 'triage': return of('triage')[0] ?? of('backlog')[0] ?? null
    case 'backlog': return of('backlog')[0] ?? of('unstarted')[0] ?? null
    case 'todo': return of('unstarted')[0] ?? of('backlog')[0] ?? null
    case 'in_progress': return started.find((s) => !isReview(s.name)) ?? started[0] ?? null
    case 'in_review': return started.find((s) => isReview(s.name)) ?? started[0] ?? null
    case 'done': return of('completed')[0] ?? null
    case 'canceled': return of('canceled')[0] ?? null
    default: return null
  }
}
/**
 * Priority. Linear's scale is 0 none, 1 urgent, 2 high, 3 medium, 4 low; the Board's PRIORITIES are 'No priority',
 * 'Urgent', 'High', 'Normal', 'Low', so the numbers carry over unchanged.
 */
export const PRIORITY_TO_LINEAR: Readonly<Record<0 | 1 | 2 | 3 | 4, number>> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 }
export function priorityFromLinear(n: unknown): 0 | 1 | 2 | 3 | 4 {
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : 0
}

// ---------- the client ----------

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>

export interface LinearOptions {
  fetch?: FetchLike
  endpoint?: string
  timeoutMs?: number
  now?: () => number
  /** pages of 50 per poll; the first pull stops at FIRST_PULL_CAP */
  maxPages?: number
}

const ISSUE = 'id identifier url title description priority estimate dueDate updatedAt state { id name type } labels(first: 50) { nodes { id name } } parent { id }'
interface RawIssue {
  id: string; identifier: string; url: string; title: string; description?: string | null; priority?: number | null; estimate?: number | null; dueDate?: string | null; updatedAt: string
  state: { id: string; name: string; type: string }
  labels?: { nodes: { id: string; name: string }[] }
  parent?: { id: string } | null
}
function toRemote(r: RawIssue): RemoteIssue {
  return {
    id: r.id, key: r.identifier, url: r.url, title: r.title, description: r.description ?? '', stateId: r.state.id, status: statusFromState(r.state),
    priority: priorityFromLinear(r.priority), labels: [...new Set((r.labels?.nodes ?? []).map((l) => l.name))], estimate: typeof r.estimate === 'number' ? r.estimate : null,
    dueDate: r.dueDate ?? null, parentId: r.parent?.id ?? null, updatedAt: r.updatedAt, closed: r.state.type === 'completed' || r.state.type === 'canceled'
  }
}
interface TeamMeta extends TeamInfo { labels: Map<string, string>; at: number }

export class LinearProvider implements TaskSyncProvider {
  readonly kind = 'linear' as const
  private readonly meta = new Map<string, TeamMeta>()
  private readonly key: string
  private readonly opts: LinearOptions
  constructor(key: string, opts: LinearOptions = {}) {
    this.key = key.trim()
    this.opts = opts
  }
  private now(): number { return this.opts.now?.() ?? Date.now() }

  async teams(): Promise<{ workspace: string | null; teams: RemoteTeam[] }> {
    const d = await this.call<{ organization?: { name?: string }; teams: { nodes: RemoteTeam[] } }>('Teams', 'query Teams { organization { name } teams(first: 100) { nodes { id key name } } }')
    return { workspace: d.organization?.name ?? null, teams: d.teams.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name })) }
  }

  async states(teamId: string): Promise<TeamInfo> {
    const m = await this.teamMeta(teamId)
    return { states: m.states, estimates: m.estimates }
  }

  async changedSince(teamId: string, cursor: string | null): Promise<ChangedPage> {
    const team = { team: { id: { eq: teamId } } }
    const closedSince = new Date(this.now() - FIRST_PULL_CLOSED_DAYS * 86_400_000).toISOString()
    const filter = cursor
      ? { and: [team, { updatedAt: { gt: cursor } }] }
      : { and: [team, { or: [{ state: { type: { nin: ['completed', 'canceled'] } } }, { updatedAt: { gt: closedSince } }] }] }
    const cap = cursor ? (this.opts.maxPages ?? 20) * 50 : FIRST_PULL_CAP
    const out: RemoteIssue[] = []
    let after: string | null = null
    let truncated = false
    for (;;) {
      const d: { issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.call('Changed',
        `query Changed($filter: IssueFilter, $after: String) { issues(first: 50, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`,
        { filter, after })
      out.push(...d.issues.nodes.map(toRemote))
      if (!d.issues.pageInfo.hasNextPage || !d.issues.pageInfo.endCursor) break
      if (out.length >= cap) { truncated = true; break }
      after = d.issues.pageInfo.endCursor
    }
    out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    const issues = out.slice(0, cap)
    return { issues, cursor: issues.length ? issues[issues.length - 1].updatedAt : null, truncated: truncated || out.length > cap }
  }

  async create(teamId: string, fields: IssueFields & { title: string }): Promise<RemoteIssue> {
    const input = { teamId, ...(await this.input(teamId, fields, null)) }
    const d = await this.call<{ issueCreate: { success: boolean; issue?: RawIssue } }>('Create', `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE} } } }`, { input })
    if (!d.issueCreate.success || !d.issueCreate.issue) throw new SyncError('refused', 'Linear did not create the issue.')
    return toRemote(d.issueCreate.issue)
  }

  async update(teamId: string, id: string, fields: IssueFields, currentStateId: string | null = null): Promise<RemoteIssue> {
    const input = await this.input(teamId, fields, currentStateId)
    if (!Object.keys(input).length) {
      const d = await this.call<{ issue: RawIssue }>('Issue', `query Issue($id: String!) { issue(id: $id) { ${ISSUE} } }`, { id })
      return toRemote(d.issue)
    }
    const d = await this.call<{ issueUpdate: { success: boolean; issue?: RawIssue } }>('Update', `mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE} } } }`, { id, input })
    if (!d.issueUpdate.success || !d.issueUpdate.issue) throw new SyncError('refused', 'Linear did not save the change.')
    return toRemote(d.issueUpdate.issue)
  }

  /** Board fields as Linear's input: a state id for the status, label ids (missing labels made on the team). */
  private async input(teamId: string, f: IssueFields, currentStateId: string | null): Promise<Record<string, unknown>> {
    const needMeta = f.status !== undefined || f.labels !== undefined || f.estimate !== undefined
    const meta = needMeta ? await this.teamMeta(teamId) : null
    const input: Record<string, unknown> = {}
    if (f.title !== undefined) input.title = f.title
    if (f.description !== undefined) input.description = f.description
    if (f.priority !== undefined) input.priority = PRIORITY_TO_LINEAR[f.priority]
    if (f.dueDate !== undefined) input.dueDate = f.dueDate
    if (f.parentId !== undefined) input.parentId = f.parentId
    if (f.estimate !== undefined && meta?.estimates) input.estimate = f.estimate
    if (f.status !== undefined && meta) {
      const s = stateForStatus(meta.states, f.status, currentStateId)
      if (s && s.id !== currentStateId) input.stateId = s.id
    }
    if (f.labels !== undefined && meta) input.labelIds = await this.labelIds(teamId, meta, f.labels)
    return input
  }

  private async labelIds(teamId: string, meta: TeamMeta, names: string[]): Promise<string[]> {
    const ids: string[] = []
    for (const name of names) {
      const known = meta.labels.get(name.toLowerCase())
      if (known) { ids.push(known); continue }
      const d = await this.call<{ issueLabelCreate: { success: boolean; issueLabel?: { id: string; name: string } } }>('LabelCreate',
        'mutation LabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }', { input: { name, teamId } })
      const made = d.issueLabelCreate.issueLabel?.id
      if (!made) continue
      meta.labels.set(name.toLowerCase(), made)
      ids.push(made)
    }
    return ids
  }

  /** States, labels (the team's and the workspace's) and estimates, cached ten minutes. */
  private async teamMeta(teamId: string, fresh = false): Promise<TeamMeta> {
    const kept = this.meta.get(teamId)
    if (kept && !fresh && this.now() - kept.at < 10 * 60_000) return kept
    const d = await this.call<{ team: { issueEstimationType?: string | null; states: { nodes: RemoteState[] }; labels: { nodes: { id: string; name: string }[] } }; issueLabels?: { nodes: { id: string; name: string }[] } }>('Team',
      'query Team($id: String!) { team(id: $id) { issueEstimationType states(first: 100) { nodes { id name type position } } labels(first: 250) { nodes { id name } } } issueLabels(first: 250, filter: { team: { null: true } }) { nodes { id name } } }',
      { id: teamId })
    const labels = new Map<string, string>()
    for (const l of [...(d.issueLabels?.nodes ?? []), ...d.team.labels.nodes]) labels.set(l.name.toLowerCase(), l.id)
    const m: TeamMeta = { states: d.team.states.nodes.map((s) => ({ id: s.id, name: s.name, type: s.type, position: s.position })), estimates: (d.team.issueEstimationType ?? 'notUsed') !== 'notUsed', labels, at: this.now() }
    this.meta.set(teamId, m)
    return m
  }

  /** One GraphQL request. Never retries here (the service backs off between polls). */
  private async call<T>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(this.opts.endpoint ?? linearEndpoint(), {
        method: 'POST',
        headers: { authorization: this.key, 'content-type': 'application/json' },
        body: JSON.stringify({ operationName, query, variables }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000)
      })
    } catch {
      // DNS, TLS, timeout or offline; the error is dropped because it can quote the request
      throw new SyncError('network')
    }
    let body: { data?: unknown; errors?: { message?: string; extensions?: { type?: string; code?: string; userPresentableMessage?: string } }[] } | null = null
    try { body = JSON.parse(await res.text()) } catch { body = null }
    const kinds = (body?.errors ?? []).map((e) => `${e.extensions?.type ?? ''} ${e.extensions?.code ?? ''}`.toLowerCase())
    if (res.status === 401 || res.status === 403 || kinds.some((k) => k.includes('authentication') || k.includes('forbidden'))) throw new SyncError('auth')
    if (res.status === 429 || kinds.some((k) => k.includes('ratelimited'))) throw new SyncError('rate_limited')
    if (res.status >= 500) throw new SyncError('remote')
    // "Entity not found" (deleted, purged from the trash, or a team the key lost): only the one issue is affected
    if ((body?.errors ?? []).some((e) => /not found|could not find/i.test(`${e.message ?? ''} ${e.extensions?.userPresentableMessage ?? ''}`))) throw new SyncError('gone')
    if (body?.errors?.length) throw new SyncError('refused')
    if (!body?.data) throw new SyncError('remote')
    return body.data as T
  }
}
