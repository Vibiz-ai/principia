/**
 * LINEAR.md §7: a fake Linear for tests and QA, so neither ever reaches api.linear.app. It answers the GraphQL
 * operations linear.ts sends (by operationName, from the variables), keeps teams, workflow states, labels and issues
 * in memory, and logs every request (operation and variables, never the key). Run it on its own with
 * `node scripts/fake-linear.ts` and point the app at it with PRINCIPIA_LINEAR_API.
 *
 * Admin routes for QA: GET /__log, GET /__issues, POST /__admin {op:'edit'|'create'|'delete'|'revoke'|'restore'|'clearLog'}.
 * Plain TypeScript (no parameter properties or enums) so Node runs it without a build step.
 */
import http from 'node:http'

export interface FakeState { id: string; name: string; type: string; position: number }
export interface FakeTeam { id: string; key: string; name: string; issueEstimationType: string; states: FakeState[]; seq: number }
export interface FakeLabel { id: string; name: string; teamId: string | null }
export interface FakeIssue {
  id: string; identifier: string; teamId: string; title: string; description: string; priority: number; estimate: number | null; dueDate: string | null
  stateId: string; labelIds: string[]; parentId: string | null; updatedAt: string; createdAt: string
}
export interface FakeLogEntry { at: string; op: string; variables: unknown; status: number }
export interface FakeEdit { title?: string; description?: string; priority?: number; stateName?: string; labels?: string[]; estimate?: number | null; dueDate?: string | null; parentKey?: string | null }

const states = (p: string): FakeState[] => [
  { id: `${p}-st-triage`, name: 'Triage', type: 'triage', position: 0 },
  { id: `${p}-st-backlog`, name: 'Backlog', type: 'backlog', position: 1 },
  { id: `${p}-st-todo`, name: 'Todo', type: 'unstarted', position: 2 },
  { id: `${p}-st-progress`, name: 'In Progress', type: 'started', position: 3 },
  { id: `${p}-st-review`, name: 'In Review', type: 'started', position: 4 },
  { id: `${p}-st-done`, name: 'Done', type: 'completed', position: 5 },
  { id: `${p}-st-canceled`, name: 'Canceled', type: 'canceled', position: 6 }
]

export class FakeLinear {
  key: string
  base = 'http://127.0.0.1'
  revoked = false
  workspace = 'Acme Labs'
  teams: FakeTeam[]
  labels: FakeLabel[]
  issues: FakeIssue[] = []
  log: FakeLogEntry[] = []
  private ids = 0
  private clock: () => Date
  constructor(opts: { key: string; now?: () => Date; seed?: boolean }) {
    this.key = opts.key
    this.clock = opts.now ?? (() => new Date())
    this.teams = [
      { id: 'team-eng', key: 'ENG', name: 'Engineering', issueEstimationType: 'fibonacci', states: states('eng'), seq: 0 },
      { id: 'team-des', key: 'DES', name: 'Design', issueEstimationType: 'notUsed', states: states('des'), seq: 0 }
    ]
    this.labels = [{ id: 'lab-bug', name: 'Bug', teamId: 'team-eng' }, { id: 'lab-feature', name: 'Feature', teamId: 'team-eng' }, { id: 'lab-ws', name: 'Customer', teamId: null }]
    if (opts.seed !== false) this.seed()
  }
  private id(p: string): string { return `${p}-${(++this.ids).toString(36)}` }
  private now(): string {
    // strictly increasing, so two writes in one millisecond still order
    let t = this.clock().getTime()
    const last = this.issues.reduce((m, i) => Math.max(m, Date.parse(i.updatedAt)), 0)
    if (t <= last) t = last + 1
    return new Date(t).toISOString()
  }
  private seed(): void {
    const ago = (days: number) => new Date(this.clock().getTime() - days * 86_400_000).toISOString()
    const add = (title: string, stateName: string, priority: number, labels: string[], extra: Partial<FakeIssue> = {}) => {
      const i = this.createIssue('team-eng', { title, description: `${title}.`, priority, stateName, labels })
      Object.assign(i, extra)
      return i
    }
    const login = add('Fix the login redirect loop', 'Todo', 2, ['Bug'], { estimate: 3, dueDate: '2026-11-07' })
    add('Ship the onboarding emails', 'In Progress', 1, ['Feature'])
    add('Review the pricing page copy', 'In Review', 3, [])
    add('Crash reports from the beta', 'Triage', 0, ['Bug'])
    const child = add('Add a test for the redirect', 'Backlog', 4, [])
    child.parentId = login.id
    add('Write the changelog', 'Done', 3, [], { updatedAt: ago(3) })
    add('Old migration cleanup', 'Done', 4, [], { updatedAt: ago(40) })
  }

  team(id: string): FakeTeam | undefined { return this.teams.find((t) => t.id === id) }
  byKey(key: string): FakeIssue | undefined { return this.issues.find((i) => i.identifier === key) }
  private stateByName(teamId: string, name: string): FakeState | undefined { return this.team(teamId)?.states.find((s) => s.name.toLowerCase() === name.toLowerCase()) }
  private labelIdsFor(teamId: string, names: string[]): string[] {
    return names.map((n) => this.labels.find((l) => l.name.toLowerCase() === n.toLowerCase() && (l.teamId === teamId || l.teamId === null))?.id ?? (() => { const l = { id: this.id('lab'), name: n, teamId }; this.labels.push(l); return l.id })())
  }
  createIssue(teamId: string, f: FakeEdit & { title: string }): FakeIssue {
    const team = this.team(teamId)!
    const at = this.now()
    const issue: FakeIssue = {
      id: this.id('iss'), identifier: `${team.key}-${++team.seq}`, teamId, title: f.title, description: f.description ?? '', priority: f.priority ?? 0, estimate: f.estimate ?? null, dueDate: f.dueDate ?? null,
      stateId: (f.stateName && this.stateByName(teamId, f.stateName)?.id) || team.states.find((s) => s.type === 'triage')!.id, labelIds: this.labelIdsFor(teamId, f.labels ?? []), parentId: null, updatedAt: at, createdAt: at
    }
    this.issues.push(issue)
    return issue
  }
  /** QA's hand in Linear: edits an issue the way a person in Linear would (updatedAt moves). */
  edit(key: string, f: FakeEdit): FakeIssue {
    const i = this.byKey(key)
    if (!i) throw new Error(`no issue ${key}`)
    if (f.title !== undefined) i.title = f.title
    if (f.description !== undefined) i.description = f.description
    if (f.priority !== undefined) i.priority = f.priority
    if (f.estimate !== undefined) i.estimate = f.estimate
    if (f.dueDate !== undefined) i.dueDate = f.dueDate
    if (f.stateName !== undefined) i.stateId = this.stateByName(i.teamId, f.stateName)?.id ?? i.stateId
    if (f.labels !== undefined) i.labelIds = this.labelIdsFor(i.teamId, f.labels)
    if (f.parentKey !== undefined) i.parentId = f.parentKey ? this.byKey(f.parentKey)?.id ?? null : null
    i.updatedAt = this.now()
    return i
  }
  /** Mutations Principia sent (QA checks this for echoes). */
  writes(op?: string): FakeLogEntry[] { return this.log.filter((e) => (op ? e.op === op : ['Create', 'Update', 'LabelCreate'].includes(e.op))) }

  raw(i: FakeIssue): unknown {
    const st = this.team(i.teamId)!.states.find((s) => s.id === i.stateId)!
    return {
      id: i.id, identifier: i.identifier, url: `${this.base}/issue/${i.identifier}`, title: i.title, description: i.description, priority: i.priority, estimate: i.estimate, dueDate: i.dueDate, updatedAt: i.updatedAt,
      state: { id: st.id, name: st.name, type: st.type }, labels: { nodes: i.labelIds.map((id) => this.labels.find((l) => l.id === id)).filter(Boolean).map((l) => ({ id: l!.id, name: l!.name })) }, parent: i.parentId ? { id: i.parentId } : null
    }
  }
  private matches(i: FakeIssue, f: unknown): boolean {
    if (!f || typeof f !== 'object') return true
    const o = f as Record<string, any>
    if (Array.isArray(o.and) && !o.and.every((x: unknown) => this.matches(i, x))) return false
    if (Array.isArray(o.or) && !o.or.some((x: unknown) => this.matches(i, x))) return false
    if (o.team?.id?.eq && i.teamId !== o.team.id.eq) return false
    if (o.updatedAt?.gt && !(i.updatedAt > new Date(o.updatedAt.gt).toISOString())) return false
    if (o.state?.type?.nin) { const st = this.team(i.teamId)!.states.find((s) => s.id === i.stateId)!; if (o.state.type.nin.includes(st.type)) return false }
    return true
  }

  /** One GraphQL request. */
  handle(auth: string | undefined, body: { operationName?: string; variables?: Record<string, any> }): { status: number; json: unknown } {
    const op = body.operationName ?? '?'
    const v = body.variables ?? {}
    const answer = (status: number, json: unknown) => { this.log.push({ at: new Date().toISOString(), op, variables: v, status }); return { status, json } }
    if (this.revoked || !auth || auth.trim() !== this.key) return answer(400, { errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' } }] })
    const fail = (message: string) => answer(400, { errors: [{ message, extensions: { type: 'invalid input', code: 'INPUT_ERROR' } }] })
    switch (op) {
      case 'Teams': return answer(200, { data: { organization: { name: this.workspace }, teams: { nodes: this.teams.map((t) => ({ id: t.id, key: t.key, name: t.name })) } } })
      case 'Team': {
        const t = this.team(v.id)
        if (!t) return fail('team not found')
        return answer(200, { data: { team: { issueEstimationType: t.issueEstimationType, states: { nodes: t.states }, labels: { nodes: this.labels.filter((l) => l.teamId === t.id).map((l) => ({ id: l.id, name: l.name })) } }, issueLabels: { nodes: this.labels.filter((l) => l.teamId === null).map((l) => ({ id: l.id, name: l.name })) } } })
      }
      case 'Changed': {
        const all = this.issues.filter((i) => this.matches(i, v.filter)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        const start = v.after ? Number(v.after) : 0
        const page = all.slice(start, start + 50)
        const more = start + 50 < all.length
        return answer(200, { data: { issues: { nodes: page.map((i) => this.raw(i)), pageInfo: { hasNextPage: more, endCursor: more ? String(start + 50) : null } } } })
      }
      case 'Issue': {
        const i = this.issues.find((x) => x.id === v.id)
        return i ? answer(200, { data: { issue: this.raw(i) } }) : fail('issue not found')
      }
      case 'Create': {
        const inp = v.input ?? {}
        const t = this.team(inp.teamId)
        if (!t || !inp.title) return fail('teamId and title are required')
        const i = this.createIssue(t.id, { title: inp.title })
        this.applyInput(i, inp)
        return answer(200, { data: { issueCreate: { success: true, issue: this.raw(i) } } })
      }
      case 'Update': {
        const i = this.issues.find((x) => x.id === v.id)
        if (!i) return fail('issue not found')
        this.applyInput(i, v.input ?? {})
        i.updatedAt = this.now()
        return answer(200, { data: { issueUpdate: { success: true, issue: this.raw(i) } } })
      }
      case 'LabelCreate': {
        const inp = v.input ?? {}
        const l = { id: this.id('lab'), name: String(inp.name), teamId: inp.teamId ?? null }
        this.labels.push(l)
        return answer(200, { data: { issueLabelCreate: { success: true, issueLabel: { id: l.id, name: l.name } } } })
      }
      default: return fail(`unknown operation ${op}`)
    }
  }
  private applyInput(i: FakeIssue, inp: Record<string, any>): void {
    if (typeof inp.title === 'string') i.title = inp.title
    if (typeof inp.description === 'string') i.description = inp.description
    if (typeof inp.priority === 'number') i.priority = inp.priority
    if ('estimate' in inp) i.estimate = inp.estimate ?? null
    if ('dueDate' in inp) i.dueDate = inp.dueDate ?? null
    if ('parentId' in inp) i.parentId = inp.parentId ?? null
    if (typeof inp.stateId === 'string' && this.team(i.teamId)!.states.some((s) => s.id === inp.stateId)) i.stateId = inp.stateId
    if (Array.isArray(inp.labelIds)) i.labelIds = inp.labelIds.filter((id: string) => this.labels.some((l) => l.id === id))
  }

  admin(body: Record<string, any>): unknown {
    switch (body.op) {
      case 'edit': return this.raw(this.edit(String(body.key), body.fields ?? {}))
      case 'create': return this.raw(this.createIssue(body.teamId ?? 'team-eng', body.fields))
      case 'delete': { const n = this.issues.length; this.issues = this.issues.filter((i) => i.identifier !== String(body.key)); return { deleted: n - this.issues.length } }
      case 'revoke': this.revoked = true; return { revoked: true }
      case 'restore': this.revoked = false; return { revoked: false }
      case 'clearLog': this.log = []; return { cleared: true }
      default: throw new Error('unknown admin op')
    }
  }
}

/** Serves a FakeLinear on 127.0.0.1 (port 0 = any free port). */
export function startFakeLinear(fake: FakeLinear, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const send = (status: number, json: unknown, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(json, null, 1) : String(json)) }
      let body: any = {}
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} } catch { return send(400, { errors: [{ message: 'bad json' }] }) }
      const url = new URL(req.url ?? '/', fake.base)
      try {
        if (req.method === 'GET' && url.pathname === '/__log') return send(200, fake.log)
        if (req.method === 'GET' && url.pathname === '/__issues') return send(200, fake.issues.map((i) => fake.raw(i)))
        if (req.method === 'POST' && url.pathname === '/__admin') return send(200, fake.admin(body))
        if (req.method === 'GET' && url.pathname.startsWith('/issue/')) {
          const i = fake.byKey(decodeURIComponent(url.pathname.slice(7)))
          return send(i ? 200 : 404, i ? `<!doctype html><meta charset="utf-8"><title>${i.identifier}</title><body style="background:#111;color:#eee;font:14px system-ui;padding:24px"><p>Fake Linear</p><h1>${i.identifier} ${i.title.replace(/</g, '&lt;')}</h1></body>` : 'not found', 'text/html')
        }
        if (req.method === 'POST') { const r = fake.handle(req.headers.authorization, body); return send(r.status, r.json) }
        send(404, { error: 'not found' })
      } catch (e) { send(400, { error: String(e) }) }
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const addr = server.address() as { port: number }
    fake.base = `http://127.0.0.1:${addr.port}`
    resolve({ url: `${fake.base}/graphql`, close: () => new Promise<void>((r) => server.close(() => r())) })
  }))
}
