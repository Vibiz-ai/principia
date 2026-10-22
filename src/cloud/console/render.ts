/**
 * Console screens as VNodes (docs/CLOUD.md §13.2, mockup docs/cloud.html "Web console · your phone"): header with the
 * Online tile and Pause, Needs you (asks with options and free text, passport facts with Accept and Reject, the
 * mosaic empty state), Runs (Running, Today, Earlier) and a run's detail (steps, log tail, Forum posts, Cancel).
 * Pure functions of view models and callbacks; every server or agent string is a text child.
 */
import { BUSTS, type BustNode } from './busts.gen'
import { h, type VNode } from './dom'
import type { AskView, HeaderView, NeedsView, ProposalView, RunDetailView, RunGroups, RunRow, Tessera } from './model'

export interface Actions {
  answer(askId: string, payload: { option?: string; text?: string }): void
  decide(companyId: string, ids: string[], decision: 'accept' | 'reject'): void
  openRun(id: string): void
  cancelRun(id: string): void
  togglePause(): void
  tab(t: 'needs' | 'runs'): void
  /** keeps a half-typed answer across re-renders */
  draft(askId: string, text: string): void
}

const tes = (k: Tessera): VNode => h('span', { class: `tes tes--${k}`, 'aria-hidden': 'true' })

export function renderHeader(v: HeaderView, a: Actions, title: string): VNode {
  return h(
    'header',
    { class: 'top' },
    h('div', { class: 'top__l' }, h('span', { class: 'pt' }, title), h('span', { class: 'ws' }, v.workspace)),
    h(
      'div',
      { class: 'top__r' },
      h('span', { class: 'online' }, tes(v.online ? 'ok' : 'fail'), v.status),
      h(
        'button',
        { type: 'button', class: `pause${v.paused ? ' is-on' : ''}`, role: 'switch', 'aria-checked': v.paused ? 'true' : 'false', on: { click: () => a.togglePause() } },
        h('span', { class: 'sw', 'aria-hidden': 'true' }, h('i', null)),
        v.paused ? 'Paused' : 'Pause cloud'
      )
    )
  )
}

/** The persona ring: a white hairline circle, for an agent that is not one of the personas. */
const ring = (): VNode => h('svg', { class: 'ring', viewBox: '0 0 40 40', 'aria-hidden': 'true' }, h('circle', { cx: '20', cy: '20', r: '19' }))

const fromNode = (n: BustNode): VNode => h(n.t, n.a, ...(n.c ?? []).map(fromNode))
/**
 * The same line-art bust as the desktop (VOICE.md §5.4), from busts.gen.ts (generated from the desktop's Bust): built
 * with createElementNS and setAttribute like every other node, never markup. "Marcus II" draws Marcus.
 */
export function bust(name: string): VNode {
  const b = BUSTS[name.replace(/ [IVX]+$/, '')]
  return b ? fromNode({ ...b, a: { ...b.a, class: 'bust', 'aria-hidden': 'true' } }) : ring()
}

export function renderAsk(v: AskView, a: Actions, draft: string): VNode {
  return h(
    'article',
    { class: 'card', 'data-ask': v.id },
    h('div', { class: 'who' }, bust(v.name), h('b', null, v.name), v.role ? ` · ${v.role}` : null),
    h('div', { class: 'co' }, v.where),
    h('p', { class: 'q' }, v.question),
    v.options.length ? h('div', { class: 'opts' }, v.options.map((o) => h('button', { type: 'button', class: 'opt', on: { click: () => a.answer(v.id, { option: o }) } }, o))) : null,
    h(
      'form',
      { class: 'free', on: { submit: (e: Event) => (e.preventDefault(), a.answer(v.id, { text: ((e.target as HTMLFormElement).elements.namedItem('t') as HTMLInputElement | null)?.value ?? '' })) } },
      h('input', { name: 't', class: 'inp', placeholder: 'Or write an answer…', maxlength: '8000', value: draft, autocomplete: 'off', 'aria-label': `Answer ${v.name}`, 'data-draft': v.id, on: { input: (e: Event) => a.draft(v.id, (e.target as HTMLInputElement).value) } }),
      h('button', { type: 'submit', class: 'btn' }, 'Send')
    )
  )
}

export function renderProposal(p: ProposalView, a: Actions): VNode {
  return h(
    'article',
    { class: 'card thin' },
    h('div', null, h('b', null, p.title), h('span', { class: 'sub' }, p.line)),
    h(
      'div',
      { class: 'opts' },
      h('button', { type: 'button', class: 'opt', on: { click: () => a.decide(p.companyId, p.ids, 'accept') } }, 'Accept'),
      h('button', { type: 'button', class: 'opt ghost', on: { click: () => a.decide(p.companyId, p.ids, 'reject') } }, 'Reject')
    )
  )
}

/** The laurel mosaic of VOICE.md §5.8, simplified to the border and ground tiles (square, crisp, no gradients). */
export function mosaic(): VNode {
  const tiles: VNode[] = []
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 12; x++) {
      const edge = x === 0 || y === 0 || x === 11 || y === 8
      const leaf = !edge && ((x + y) % 5 === 0 || (x === 6 && y > 1 && y < 7))
      tiles.push(h('rect', { x: String(x * 10 + 0.8), y: String(y * 10 + 0.8), width: '8.4', height: '8.4', class: edge ? 'px-purple' : leaf ? 'px-white' : 'px-ground' }))
    }
  return h('svg', { class: 'mosaic', viewBox: '0 0 120 90', 'shape-rendering': 'crispEdges', 'aria-hidden': 'true' }, tiles)
}

export function renderNeeds(v: NeedsView, a: Actions, drafts: Record<string, string> = {}): VNode {
  if (v.empty) return h('section', { class: 'empty' }, mosaic(), h('p', null, 'Nothing needs you. Agents are working.'))
  return h(
    'section',
    { class: 'list' },
    v.asks.map((x) => renderAsk(x, a, drafts[x.id] ?? '')),
    v.proposals.map((p) => renderProposal(p, a))
  )
}

const runRow = (r: RunRow, a: Actions): VNode =>
  h('button', { type: 'button', class: 'run', on: { click: () => a.openRun(r.id) } }, tes(r.tess), h('span', { class: 'run__t' }, h('b', null, r.title), h('span', { class: 'sub' }, r.line)), h('span', { class: 'tm' }, r.time))

export function renderRuns(g: RunGroups, a: Actions): VNode {
  const group = (title: string, rows: RunRow[]): VNode | null => (rows.length ? h('section', { class: 'group' }, h('h2', null, title), h('div', { class: 'card rows' }, rows.map((r) => runRow(r, a)))) : null)
  if (!g.running.length && !g.today.length && !g.earlier.length) return h('section', { class: 'empty' }, mosaic(), h('p', null, 'No cloud runs yet.'))
  return h('div', { class: 'list' }, group('Running', g.running), group('Today', g.today), group('Earlier', g.earlier))
}

export function renderRunDetail(v: RunDetailView, log: string[], a: Actions): VNode {
  return h(
    'section',
    { class: 'detail' },
    h('a', { class: 'back', href: '#/runs' }, '‹ Runs'),
    h('div', { class: 'rhead' }, tes(v.tess), h('b', null, v.title)),
    h('div', { class: 'sub' }, v.head),
    h('div', { class: 'steps' }, v.steps.length ? v.steps.map((s) => h('div', { class: `step${s.active ? ' on' : ''}` }, tes(s.tess), h('span', { class: 'step__t' }, s.title), h('span', { class: 'meta' }, s.meta))) : h('div', { class: 'step sub' }, 'No steps yet.')),
    h('pre', { class: 'log', 'aria-label': 'Log tail' }, log.length ? log.join('\n') : v.emptyLog),
    v.posts.length ? h('div', { class: 'posts' }, h('h2', null, 'Forum posts'), v.posts.map((p) => h('div', { class: 'post' }, h('b', null, p.author), p.role ? h('span', { class: 'sub' }, ` · ${p.role}`) : null, h('p', null, p.text)))) : null,
    v.cancellable ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn ghost', on: { click: () => a.cancelRun(v.id) } }, 'Cancel run')) : null
  )
}

export function renderTabs(active: 'needs' | 'runs', needs: number, a: Actions): VNode {
  const tab = (key: 'needs' | 'runs', label: string, badge?: number): VNode =>
    h('a', { href: `#/${key}`, class: `tab${active === key ? ' on' : ''}`, 'aria-current': active === key ? 'page' : undefined, on: { click: () => a.tab(key) } }, label, badge ? h('i', null, String(badge)) : null)
  return h('nav', { class: 'tabs', 'aria-label': 'Sections' }, tab('needs', 'Needs you', needs), tab('runs', 'Runs'))
}

export function renderSignedOut(): VNode {
  return h('section', { class: 'empty' }, mosaic(), h('p', null, 'Open the console from Principia on your Mac to sign in.'), h('p', { class: 'sub' }, 'Cloud › Workspace › Open on your phone shows a code to scan.'))
}
