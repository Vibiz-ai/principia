/**
 * Principia Cloud console, the phone's two jobs: answer and glance (docs/CLOUD.md §13.2). Hash router (#/needs,
 * #/runs, #/runs/:id), a small state object, and one render function that rebuilds the screen from VNodes (text nodes
 * only). Polls every 15 s and follows /v1/events; a run's detail follows `?runId` for its log.
 */
import type { CloudAsk, CloudCompany, CloudRunDetail, CloudRunSummary, CloudWorkspace, PassportProposal } from '../../shared/cloud'
import { createApi, SignedOut } from './api'
import { mount, type VNode, h } from './dom'
import { appendLog, groupRuns, headerView, listOf, logLines, needsView, parseRoute, runDetailView, type Route } from './model'
import { renderHeader, renderNeeds, renderRunDetail, renderRuns, renderSignedOut, renderTabs, type Actions } from './render'
import { openEvents } from './sse'

interface State {
  route: Route
  signedOut: boolean
  online: boolean
  workspace: CloudWorkspace | null
  companies: CloudCompany[]
  asks: CloudAsk[]
  proposals: Record<string, PassportProposal[]>
  runs: CloudRunSummary[]
  run: CloudRunDetail | null
  log: string[]
  drafts: Record<string, string>
  error: string | null
}

const api = createApi()
const st: State = { route: parseRoute(location.hash), signedOut: false, online: true, workspace: null, companies: [], asks: [], proposals: {}, runs: [], run: null, log: [], drafts: {}, error: null }
const root = document.getElementById('app')!

const fail = (e: unknown): void => {
  if (e instanceof SignedOut) st.signedOut = true
  else {
    st.error = e instanceof Error ? e.message : String(e)
    if (e instanceof TypeError) st.online = false
  }
  render()
}

async function loadAll(): Promise<void> {
  try {
    const me = await api.me()
    st.workspace = me.workspace
    st.signedOut = false
    const [companies, asks, runs] = await Promise.all([api.call<unknown>('companies'), api.call<unknown>('asks'), api.call<unknown>('runs', { query: { limit: 60 } })])
    st.companies = listOf<CloudCompany>(companies, 'companies')
    st.asks = listOf<CloudAsk>(asks, 'asks')
    st.runs = listOf<CloudRunSummary>(runs, 'runs')
    const withFacts = st.companies.filter((c) => (c.passport?.pendingProposals ?? 0) > 0)
    st.proposals = Object.fromEntries(await Promise.all(withFacts.map(async (c) => [c.id, listOf<PassportProposal>(await api.call<unknown>('passportProposals', { params: { cid: c.id } }).catch(() => []), 'proposals')] as const)))
    st.online = true
    st.error = null
    render()
  } catch (e) {
    fail(e)
  }
}

let runEvents: { close(): void } | null = null
async function loadRun(id: string): Promise<void> {
  runEvents?.close()
  try {
    const [d, log] = await Promise.all([api.call<CloudRunDetail>('run', { params: { id } }), api.call<unknown>('runLog', { params: { id }, query: { tail: 200 } })])
    st.run = d
    st.log = logLines(log)
    render()
    runEvents = openEvents(
      (e) => {
        if (e.kind === 'log' && e.runId === id) st.log = appendLog(st.log, e.lines)
        else if (e.kind === 'step' && e.runId === id && st.run) st.run = { ...st.run, steps: [...st.run.steps.filter((s) => s.id !== e.step.id), e.step] }
        else if (e.kind === 'run' && e.run.id === id && st.run) st.run = { ...st.run, ...e.run }
        else return
        render()
      },
      { runId: id }
    )
  } catch (e) {
    fail(e)
  }
}

const actions: Actions = {
  answer(askId, payload) {
    const ask = st.asks.find((a) => a.id === askId)
    if (!ask) return
    const answer = payload.option ?? (payload.text ?? st.drafts[askId] ?? '').trim()
    if (!answer) return
    void api
      .call<CloudAsk>('askAnswer', { params: { id: askId }, body: { answer } })
      .then(() => {
        st.asks = st.asks.map((a) => (a.id === askId ? { ...a, status: 'answered' as const, answer } : a))
        delete st.drafts[askId]
        render()
      })
      .catch(fail)
  },
  decide(companyId, ids, decision) {
    void Promise.all(ids.map((pid) => api.call('passportDecide', { params: { cid: companyId, pid, decision } })))
      .then(() => {
        st.proposals = { ...st.proposals, [companyId]: [] }
        render()
      })
      .catch(fail)
  },
  openRun(id) {
    location.hash = `#/runs/${encodeURIComponent(id)}`
  },
  cancelRun(id) {
    if (!confirm('Cancel this cloud run?')) return
    void api.call('runCancel', { params: { id } }).then(() => loadRun(id)).catch(fail)
  },
  togglePause() {
    const next = !st.workspace?.paused
    if (!confirm(next ? 'Pause your cloud? Running runs are canceled and schedules wait until you resume.' : 'Resume your cloud?')) return
    void api
      .call<CloudWorkspace>('workspacePatch', { body: { paused: next } })
      .then((w) => {
        st.workspace = w && 'paused' in w ? w : st.workspace && { ...st.workspace, paused: next }
        render()
      })
      .catch(fail)
  },
  tab() {
    /* the hash change routes */
  },
  draft(askId, text) {
    st.drafts[askId] = text
  }
}

function screen(): VNode {
  if (st.signedOut) return h('main', { class: 'app' }, h('header', { class: 'top' }, h('span', { class: 'pt' }, 'PRINCIPIA')), renderSignedOut())
  const head = headerView({ workspace: st.workspace?.name ?? null, online: st.online, paused: !!st.workspace?.paused })
  const needs = needsView(st.asks, st.proposals, st.companies)
  const r = st.route
  const tab: 'needs' | 'runs' = r.tab === 'needs' ? 'needs' : 'runs'
  const body =
    r.tab === 'needs'
      ? renderNeeds(needs, actions, st.drafts)
      : r.tab === 'runs'
        ? renderRuns(groupRuns(st.runs, st.companies), actions)
        : st.run && st.run.id === r.id
          ? renderRunDetail(runDetailView(st.run, st.companies), st.log, actions)
          : h('p', { class: 'sub pad' }, 'Loading…')
  return h('main', { class: 'app' }, renderHeader(head, actions, tab === 'needs' ? 'NEEDS YOU' : 'RUNS'), st.error ? h('p', { class: 'err' }, st.error) : null, h('div', { class: 'body' }, body), renderTabs(tab, needs.count, actions))
}

function render(): void {
  // keep the half-typed answer focused across re-renders
  const active = document.activeElement as HTMLInputElement | null
  const focusAsk = active?.getAttribute?.('data-draft') ?? null
  const el = mount(screen(), document) as Node
  root.replaceChildren(el)
  if (focusAsk) {
    const again = root.querySelector<HTMLInputElement>(`[data-draft="${CSS.escape(focusAsk)}"]`)
    if (again) {
      again.focus()
      again.setSelectionRange(again.value.length, again.value.length)
    }
  }
}

window.addEventListener('hashchange', () => {
  st.route = parseRoute(location.hash)
  if (st.route.tab === 'run') void loadRun(st.route.id)
  else {
    runEvents?.close()
    runEvents = null
  }
  render()
})

render()
void loadAll().then(() => {
  if (st.route.tab === 'run') void loadRun(st.route.id)
})
setInterval(() => void loadAll(), 15_000)
openEvents(
  (e) => {
    if (e.kind === 'ask') st.asks = [e.ask, ...st.asks.filter((a) => a.id !== e.ask.id)]
    else if (e.kind === 'run') st.runs = [e.run, ...st.runs.filter((r) => r.id !== e.run.id)]
    else if (e.kind === 'workspace') st.workspace = e.workspace
    else return
    render()
  },
  {
    onOpen: () => {
      if (!st.online) {
        st.online = true
        render()
      }
    },
    onError: () => {
      if (st.online && !st.signedOut) {
        st.online = false
        render()
      }
    }
  }
)
