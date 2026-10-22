// The phone console (docs/CLOUD.md §13.2, §11): pure view models, DOM-free render functions, text-only mounting
// (agent text with <script> stays text), the API's CSRF and 401 handling, and a CSP-clean index.html.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CloudAsk, CloudRunDetail, CloudRunSummary } from '../../shared/cloud'
import { createApi, SignedOut } from './api'
import { findAll, h, mount, textOf, type DocLike, type ElLike } from './dom'
import { answerPayload, appendLog, groupRuns, headerView, logLines, needsView, parseRoute, routeHash, runDetailView, tessera } from './model'
import { renderHeader, renderNeeds, renderRunDetail, renderRuns, renderSignedOut, renderTabs, type Actions } from './render'

const COMPANIES = [
  { id: 'co_v', name: 'Vibiz' },
  { id: 'co_c', name: 'Cortie Moodboard' }
]
const ask = (id: string, p: Partial<CloudAsk> = {}): CloudAsk => ({ id, companyId: 'co_v', runId: 'r', agentName: 'Marcus · Copywriter', question: 'Ship today or Thursday?', options: ['Today', 'Thursday'], createdAt: new Date(2026, 9, 21, 6, 12).toISOString(), status: 'open', answer: null, ...p })
const run = (id: string, p: Partial<CloudRunSummary> = {}): CloudRunSummary => ({ id, companyId: 'co_v', kind: 'workflow', title: id, status: 'passed', trigger: 'schedule', adapters: ['codex'], createdAt: new Date(2026, 9, 21, 9, 0).toISOString(), startedAt: new Date(2026, 9, 21, 9, 0).toISOString(), endedAt: new Date(2026, 9, 21, 9, 4).toISOString(), summary: null, ...p })
const NOW = new Date(2026, 9, 21, 10, 0)
const noop: Actions = { answer: () => {}, decide: () => {}, openRun: () => {}, cancelRun: () => {}, togglePause: () => {}, tab: () => {}, draft: () => {} }

describe('model', () => {
  it('routes', () => {
    expect(parseRoute('#/needs')).toEqual({ tab: 'needs' })
    expect(parseRoute('#/runs')).toEqual({ tab: 'runs' })
    expect(parseRoute('#/runs/crun%201')).toEqual({ tab: 'run', id: 'crun 1' })
    expect(parseRoute('')).toEqual({ tab: 'needs' })
    expect(parseRoute('#/forum/co/ch')).toEqual({ tab: 'needs' })
    expect(routeHash({ tab: 'run', id: 'crun 1' })).toBe('#/runs/crun%201')
  })
  it('needs: open asks oldest first, proposal rows per company, empty state', () => {
    const v = needsView([ask('b', { createdAt: '2026-10-21T07:00:00Z' }), ask('a', { createdAt: '2026-10-21T05:00:00Z' }), ask('x', { status: 'answered' })], { co_v: [{ id: 'p1', kind: 'delta', app: 'cloud', created: '', summary: 's' }, { id: 'p2', kind: 'delta', app: 'cloud', created: '', summary: 's' }], co_c: [] }, COMPANIES)
    expect(v.asks.map((a) => a.id)).toEqual(['a', 'b'])
    expect(v.asks[0]).toMatchObject({ name: 'Marcus', role: 'Copywriter' })
    expect(v.asks[0].where).toMatch(/^Vibiz · \d\d:\d\d$/)
    expect(v.proposals).toEqual([{ companyId: 'co_v', title: 'Passport · Vibiz', line: '2 new facts from cloud agents', ids: ['p1', 'p2'] }])
    expect(v.count).toBe(3)
    expect(needsView([], {}, COMPANIES).empty).toBe(true)
  })
  it('answer payload: offered option or trimmed text', () => {
    expect(answerPayload({ options: ['Today'] }, { option: 'Today' })).toEqual({ answer: 'Today' })
    expect(answerPayload({ options: ['Today'] }, { option: 'Never' })).toBeNull()
    expect(answerPayload({ options: [] }, { text: '  later ' })).toEqual({ answer: 'later' })
    expect(answerPayload({ options: [] }, { text: ' ' })).toBeNull()
  })
  it('runs grouped Running, Today, Earlier with plain time lines', () => {
    const g = groupRuns([run('done'), run('live', { status: 'running', endedAt: null }), run('asks', { status: 'needs_input' }), run('old', { createdAt: '2026-10-19T09:00:00Z', startedAt: '2026-10-19T09:00:00Z' })], COMPANIES, NOW)
    expect(g.running.map((r) => r.id).sort()).toEqual(['asks', 'live'])
    expect(g.today.map((r) => r.id)).toEqual(['done'])
    expect(g.earlier.map((r) => r.id)).toEqual(['old'])
    expect(g.today[0]).toMatchObject({ tess: 'ok', line: 'Vibiz · schedule · Codex', time: '09:00 · 4 min' })
    expect(g.running.find((r) => r.id === 'asks')?.time).toContain('needs you')
    expect(['passed', 'needs_input', 'failed', 'running', 'queued'].map(tessera)).toEqual(['ok', 'needs', 'fail', 'running', 'q'])
  })
  it('run detail, log tail and header', () => {
    const d: CloudRunDetail = { ...run('r1', { status: 'running' }), steps: [{ id: 's1', nodeId: 'a', title: 'Write brief', adapter: 'codex', status: 'running', startedAt: null, endedAt: null, usage: null }], artifacts: [], forumPosts: [{ id: 'm', channelId: 'c', threadId: null, author: { kind: 'agent', name: 'Marcus', role: 'Copywriter' }, kind: 'text', text: 'Posted', createdAt: '', replies: 0 }] }
    const v = runDetailView(d, COMPANIES)
    expect(v).toMatchObject({ cancellable: true, steps: [{ title: 'Write brief', tess: 'running', active: true, meta: 'Codex · running' }], posts: [{ author: 'Marcus', role: 'Copywriter', text: 'Posted' }], emptyLog: 'No log yet.' })
    // a finished run that wrote nothing says so; "No log yet." is only for a run still going
    const done = runDetailView({ ...d, status: 'passed', steps: [{ ...d.steps[0]!, adapter: 'shell', status: 'passed' }] }, COMPANIES)
    expect(done).toMatchObject({ emptyLog: 'This run wrote no output.', steps: [{ meta: 'Shell' }] })
    expect(textOf(renderRunDetail(done, [], noop))).toContain('This run wrote no output.')
    expect(textOf(renderRunDetail(done, ['› Probe', 'wrote ok'], noop))).toContain('wrote ok')
    expect(logLines({ lines: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(logLines({ text: 'a\nb' })).toEqual(['a', 'b'])
    expect(appendLog(['a'], ['b', 'c'], 2)).toEqual(['b', 'c'])
    expect(headerView({ workspace: 'w', online: false, paused: true })).toMatchObject({ status: 'Offline', paused: true })
  })
})

describe('render functions (DOM-free)', () => {
  it('Needs you: options as buttons, a free-text form, and the mosaic empty state', () => {
    const tree = renderNeeds(needsView([ask('a')], {}, COMPANIES), noop)
    expect(findAll(tree, (n) => n.tag === 'button' && n.attrs.class === 'opt').map(textOf)).toEqual(['Today', 'Thursday'])
    expect(findAll(tree, (n) => n.tag === 'form').length).toBe(1)
    const empty = renderNeeds(needsView([], {}, COMPANIES), noop)
    expect(textOf(empty)).toBe('Nothing needs you. Agents are working.')
    expect(findAll(empty, (n) => n.tag === 'svg' && n.attrs.class === 'mosaic').length).toBe(1)
  })
  it('clicking an option calls answer with that option', () => {
    const calls: unknown[] = []
    const tree = renderNeeds(needsView([ask('a')], {}, COMPANIES), { ...noop, answer: (id, p) => void calls.push([id, p]) })
    findAll(tree, (n) => n.tag === 'button' && textOf(n) === 'Thursday')[0].on.click(new Event('click'))
    expect(calls).toEqual([['a', { option: 'Thursday' }]])
  })
  it('runs, detail with Cancel, header with Pause, tabs with the needs count, signed out', () => {
    const runs = renderRuns(groupRuns([run('Morning brief', { status: 'running', endedAt: null })], COMPANIES, NOW), noop)
    expect(findAll(runs, (n) => n.tag === 'h2').map(textOf)).toEqual(['Running'])
    const d: CloudRunDetail = { ...run('r1', { status: 'running' }), steps: [], artifacts: [] }
    const det = renderRunDetail(runDetailView(d, COMPANIES), ['› line'], noop)
    expect(textOf(det)).toContain('Cancel run')
    expect(findAll(det, (n) => n.tag === 'pre').map(textOf)).toEqual(['› line'])
    expect(textOf(renderHeader(headerView({ workspace: 'lautaro-cloud', online: true, paused: false }), noop, 'NEEDS YOU'))).toContain('Pause cloud')
    expect(textOf(renderTabs('needs', 2, noop))).toBe('Needs you2Runs')
    expect(textOf(renderSignedOut())).toContain('Open the console from Principia on your Mac to sign in')
  })
  it('no Forum, Accounts or "Run a workflow" anywhere', () => {
    const all = [renderTabs('runs', 0, noop), renderNeeds(needsView([ask('a')], {}, COMPANIES), noop), renderRuns(groupRuns([run('x')], COMPANIES, NOW), noop)].map(textOf).join(' ')
    expect(all).not.toMatch(/Forum|Accounts|Run a workflow/)
  })
})

describe('text-only mounting', () => {
  /** a fake document that records how nodes are made */
  const fakeDoc = () => {
    const log: string[] = []
    type Fake = ElLike & { tag: string; attrs: Record<string, string>; kids: unknown[] }
    const el = (tag: string): Fake => ({ tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v }, appendChild(c) { this.kids.push(c); return c }, addEventListener: () => {} })
    const doc: DocLike = {
      createElement: (t) => (log.push(`el:${t}`), el(t)),
      createElementNS: (_ns, t) => (log.push(`svg:${t}`), el(t)),
      createTextNode: (t) => (log.push(`text:${t}`), { text: t })
    }
    return { doc, log }
  }
  it('agent text with <script> becomes a text node, never an element', () => {
    const evil = 'Ship it? <script>alert(document.cookie)</script><img src=x onerror=alert(1)>'
    const tree = renderNeeds(needsView([ask('a', { question: evil, agentName: '<b>Marcus</b> · <i>x</i>' })], {}, COMPANIES), noop)
    const { doc, log } = fakeDoc()
    mount(tree, doc)
    expect(log).toContain(`text:${evil}`)
    expect(log).not.toContain('el:script')
    expect(log).not.toContain('el:img')
    expect(log.filter((l) => l.startsWith('el:')).every((l) => ['el:section', 'el:article', 'el:div', 'el:b', 'el:span', 'el:p', 'el:button', 'el:form', 'el:input'].includes(l))).toBe(true)
  })
  it('an ask shows the persona bust the desktop draws, as SVG nodes; an unknown agent gets the plain ring', () => {
    const tree = renderNeeds(needsView([ask('a'), ask('b', { agentName: 'Marcus II · Copywriter' }), ask('c', { agentName: 'Some bot' })], {}, COMPANIES), noop)
    const svgs = findAll(tree, (n) => n.tag === 'svg')
    expect(svgs.map((n) => n.attrs.class)).toEqual(['bust', 'bust', 'ring'])
    expect(svgs[0]!.attrs).toMatchObject({ stroke: '#fff', fill: 'none', 'aria-hidden': 'true' })
    // the drawing itself: the profile, hair and drapery strokes, plus the faint avatar ring
    expect(findAll(svgs[0]!, (n) => n.tag === 'path').length).toBeGreaterThan(8)
    expect(findAll(svgs[0]!, (n) => n.tag === 'circle')[0]!.attrs['stroke-opacity']).toBe('0.2')
    expect(svgs[1]).toEqual(svgs[0])
    const { doc, log } = fakeDoc()
    mount(svgs[0]!, doc)
    expect(log.every((l) => l.startsWith('svg:'))).toBe(true)
  })
  it('h() refuses on* and innerHTML attributes', () => {
    const v = h('div', { onclick: 'alert(1)', innerHTML: '<b>x</b>', title: 'ok' }, 'x')
    expect(v.attrs).toEqual({ title: 'ok' })
  })
  it('the console source never uses innerHTML or insertAdjacentHTML', () => {
    for (const f of ['app.ts', 'render.ts', 'dom.ts', 'sse.ts', 'api.ts']) expect(fs.readFileSync(path.join(__dirname, f), 'utf8')).not.toMatch(/innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/)
  })
})

describe('api', () => {
  const fake = (routes: Record<string, { status: number; body: unknown }>) => {
    const seen: { url: string; init: RequestInit }[] = []
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      const r = routes[`${init.method} ${url.split('?')[0]}`] ?? { status: 404, body: { error: 'not_found', message: 'nope' } }
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as unknown as typeof fetch
    return { f, seen }
  }
  it('writes carry the CSRF from /v1/me and same-origin credentials', async () => {
    const { f, seen } = fake({ 'GET /v1/me': { status: 200, body: { csrf: 'csrf123', workspace: {} } }, 'POST /v1/asks/a/answer': { status: 200, body: { ok: true } } })
    const api = createApi(f)
    await api.call('askAnswer', { params: { id: 'a' }, body: { answer: 'Today' } })
    const post = seen.find((s) => s.init.method === 'POST')!
    expect((post.init.headers as Record<string, string>)['x-principia-csrf']).toBe('csrf123')
    expect(post.init.credentials).toBe('same-origin')
  })
  it('401 means signed out', async () => {
    const { f } = fake({ 'GET /v1/me': { status: 401, body: { error: 'unauthorized', message: 'x' } } })
    await expect(createApi(f).me()).rejects.toBeInstanceOf(SignedOut)
  })
})

describe('index.html', () => {
  it('works under CSP default-src self: no inline script, no inline handlers, no external origins', () => {
    const files = [path.join(__dirname, 'index.html')]
    const built = path.join(__dirname, '../../../out-cloud/console/index.html')
    if (fs.existsSync(built)) files.push(built)
    for (const f of files) {
      const html = fs.readFileSync(f, 'utf8')
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
      expect(scripts.length).toBe(1)
      for (const [, attrs, body] of scripts) {
        expect(attrs).toMatch(/\bsrc=/)
        expect(body.trim()).toBe('')
      }
      expect(html).not.toMatch(/\son[a-z]+=/i)
      expect(html).not.toMatch(/https?:\/\//)
      expect(html).not.toMatch(/<style/)
    }
  })
})
