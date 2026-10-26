/**
 * The phone screens as VNodes (text nodes only: agent text can never become markup). Mobile first, one hand: the
 * company switcher on top, four tabs at the bottom, big targets. The landing page's look: Cinzel lettering for titles,
 * cool greys on near-black, and a white line engraving only where the screen is otherwise empty (pairing, nothing to
 * show yet).
 */
import { h, type VNode } from '../console/dom'
import { bust } from '../console/render'
import type { PhoneAgent, PhoneAsk, PhoneChatRow, PhoneChats, PhoneCompany, PhoneDone, PhoneNeeds, PhoneNow, PhoneRoom, PhoneRoomMember, PhoneSession, PhoneTaskNeed, PhoneThreadItem, PhoneWho, PhoneWorking } from '../../shared/remote'
import { md } from './markdown'
import { ago, chatLines, headline, type ChatLine, type ChatReplica, type Tab } from './model'

export interface Actions {
  tab(t: Tab): void
  company(id: string): void
  togglePause(): void
  open(ref: { kind: 'session' | 'agent'; id: string }): void
  back(): void
  answerAsk(askId: string, optionId: string | null): void
  approve(taskId: string): void
  sendBack(taskId: string): void
  /** Not needed: cancel a task that waits on you (it leaves Needs you; reopen it from the Board on the Mac) */
  notNeeded(taskId: string): void
  /** the queued messages go now: the turn stops and they follow (the Mac's Send now) */
  sendNow(): void
  /** insert @handle in the composer */
  mention(handle: string): void
  answerTask(taskId: string, option: string | null): void
  chatAnswer(requestId: string, decision: { kind: 'allow' } | { kind: 'deny'; message?: string } | { kind: 'answer'; answers: Record<string, string> } | { kind: 'skip' } | { kind: 'approvePlan' } | { kind: 'rejectPlan'; message?: string }): void
  pickOption(key: string, option: string, multi: boolean): void
  channel(id: string): void
  pair(): void
  /** hosted: open a pairing link pasted into the app (a Home Screen app on iPhone cannot be reached by the QR) */
  pasteLink(text: string): void
  retry(): void
  /** hosted: forget the Mac this phone remembers (its address and token) */
  forget(): void
  draft(key: string, value: string): void
}

export interface View {
  companies: PhoneCompany[]
  companyId: string | null
  tab: Tab
  online: boolean
  error: string | null
  toast: string | null
  busy: ReadonlySet<string>
  drafts: Readonly<Record<string, string>>
  picks: Readonly<Record<string, string[]>>
  now: PhoneNow | null
  needs: PhoneNeeds | null
  chats: PhoneChats | null
  room: PhoneRoom | null
  session: PhoneSession | null
  replica: ChatReplica | null
  agent: PhoneAgent | null
  openKind: 'session' | 'agent' | null
}

const face = (w: PhoneWho | null, size: 'sm' | 'md' = 'md'): VNode => h('span', { class: `face face--${size}`, 'aria-hidden': 'true' }, w?.bust ? bust(w.bust) : ring())
const ring = (): VNode => h('svg', { class: 'ring', viewBox: '0 0 40 40' }, h('circle', { cx: '20', cy: '20', r: '19' }))
const whoLine = (w: PhoneWho | null, fallback: string): VNode => h('span', { class: 'who' }, h('b', null, w?.name ?? fallback), w?.role ? h('span', { class: 'role' }, ` · ${w.role}`) : null)
const tile = (k: 'ok' | 'needs' | 'fail' | 'run' | 'q'): VNode => h('span', { class: `tes tes--${k}`, 'aria-hidden': 'true' })
const btn = (label: string, on: () => void, o: { kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; key?: string; small?: boolean; wide?: boolean } = {}): VNode =>
  h('button', { type: 'button', class: `btn${o.kind ? ` btn--${o.kind}` : ''}${o.small ? ' btn--sm' : ''}${o.wide ? ' btn--wide' : ''}`, disabled: o.disabled, 'data-key': o.key, on: { click: () => on() } }, label)
/** the white line engravings (public/art, from the landing page), used sparingly */
export type Plate = 'arch' | 'senate' | 'scribe' | 'forum'
const plate = (name: Plate, eager = false): VNode =>
  h('figure', { class: 'plate', 'aria-hidden': 'true' }, h('img', { src: `/art/${name}.webp`, alt: '', width: '900', height: '503', decoding: 'async', loading: eager ? 'eager' : 'lazy', fetchpriority: eager ? 'high' : undefined }))
const empty = (title: string, line: string, art: Plate): VNode => h('div', { class: 'empty' }, plate(art), h('b', null, title), h('p', null, line))

export function renderHeader(v: View, a: Actions): VNode {
  const co = v.companies.find((c) => c.id === v.companyId)
  return h(
    'header',
    { class: 'top' },
    h(
      'label',
      { class: 'switcher' },
      h('span', { class: 'sr' }, 'Company'),
      h(
        'select',
        { class: 'switcher__sel', 'aria-label': 'Company', on: { change: (e: Event) => a.company((e.target as HTMLSelectElement).value) } },
        ...v.companies.map((c) => h('option', { value: c.id, selected: c.id === v.companyId }, c.needs ? `(${c.needs}) ${c.name}` : c.name))
      ),
      h('svg', { class: 'chev', viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 4.5 6 7.5 9 4.5' }))
    ),
    h('span', { class: `conn ${v.online ? 'is-on' : ''}`, title: v.online ? 'Connected to your Mac' : 'Reconnecting', role: 'status' }, tile(v.online ? 'ok' : 'q'), v.online ? h('span', { class: 'sr' }, 'Connected') : 'Offline'),
    co && !co.personal ? h('button', { type: 'button', class: `pause ${co.paused ? 'is-paused' : ''}`, 'aria-pressed': co.paused ? 'true' : 'false', disabled: v.busy.has('pause'), on: { click: () => a.togglePause() } }, h('span', { class: 'sw' }, h('i')), co.paused ? 'Paused' : 'Running') : null
  )
}

export function renderTabs(v: View, a: Actions): VNode {
  const co = v.companies.find((c) => c.id === v.companyId)
  const needs = v.needs?.count ?? co?.needs ?? 0
  const t = (id: Tab, label: string, icon: VNode, badge?: number): VNode =>
    h('button', { type: 'button', class: `tab ${v.tab === id ? 'on' : ''}`, 'aria-current': v.tab === id ? 'page' : undefined, on: { click: () => a.tab(id) } }, icon, h('span', null, label), badge ? h('i', { class: 'badge' }, String(badge)) : null)
  return h(
    'nav',
    { class: 'tabs', 'aria-label': 'Sections' },
    t('now', 'Now', ico('M4 12h4l2-5 4 10 2-5h4')),
    t('needs', 'Needs you', ico('M12 4 20 18H4z M12 10v3 M12 15.5v.5'), needs),
    t('chats', 'Chats', ico('M5 6h14v9H9l-4 3z')),
    t('room', 'Team room', ico('M4 18v-2a4 4 0 0 1 4-4h0a4 4 0 0 1 4 4v2 M8 9a2.5 2.5 0 1 0 0-.01 M14 18v-1.5a3.5 3.5 0 0 1 6 0V18 M17 9.5a2 2 0 1 0 0-.01'))
  )
}
const ico = (d: string): VNode => h('svg', { class: 'ico', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, h('path', { d }))

// ---------- Now ----------

export function renderNow(v: View, a: Actions, now = Date.now()): VNode {
  const n = v.now
  if (!n) return loading()
  return h(
    'section',
    { class: 'page' },
    h('h1', { class: 'title' }, n.name),
    h('p', { class: 'lede' }, headline({ working: n.working.length, needs: n.needs, paused: n.paused }), n.autopilot && n.autopilot !== 'held' ? h('span', { class: `ap is-${n.autopilot}` }, n.autopilotLabel ?? (n.autopilot === 'on' ? 'Autopilot on' : 'Autopilot off')) : null),
    n.paused ? h('div', { class: 'banner' }, h('span', { class: 'glyph' }, '‖'), `${n.name} is paused. Agents start nothing new and schedules wait.`) : null,
    n.needs ? h('button', { type: 'button', class: 'callout', on: { click: () => a.tab('needs') } }, tile('needs'), `${n.needs} thing${n.needs === 1 ? '' : 's'} need${n.needs === 1 ? 's' : ''} you`, h('span', { class: 'go' }, '›')) : null,
    h('h2', { class: 'sec' }, 'Working now'),
    n.working.length ? h('div', { class: 'list' }, ...n.working.map((w) => workingRow(w, a, now))) : h('div', { class: 'card quiet' }, n.paused ? 'Resume to let agents pick up their work.' : 'No one is working right now.'),
    h('h2', { class: 'sec' }, 'Finished lately'),
    n.done.length ? h('div', { class: 'list rows' }, ...n.done.map((d) => doneRow(d, now))) : h('div', { class: 'card quiet' }, 'Nothing finished yet.')
  )
}
function workingRow(w: PhoneWorking, a: Actions, now: number): VNode {
  return h(
    'button',
    { type: 'button', class: 'card row', disabled: !w.open, on: { click: () => w.open && a.open(w.open) } },
    face(w.who),
    h('span', { class: 'row__t' }, whoLine(w.who, w.title), h('span', { class: 'row__s' }, w.title), w.activity ? h('span', { class: 'activity' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), w.activity) : null),
    h('span', { class: 'tm' }, ago(w.startedAt, now))
  )
}
function doneRow(d: PhoneDone, now: number): VNode {
  return h(
    'div',
    { class: 'drow' },
    tile(d.status === 'failed' ? 'fail' : d.status === 'review' ? 'needs' : 'ok'),
    h('span', { class: 'row__t' }, h('b', null, d.title), h('span', { class: 'row__s' }, [d.who?.name, d.status === 'review' ? 'waiting for your OK' : d.status === 'failed' ? 'stopped' : 'done'].filter(Boolean).join(' · ')), d.summary ? h('span', { class: 'sum' }, d.summary) : null),
    h('span', { class: 'tm' }, ago(d.at, now))
  )
}

// ---------- Needs you ----------

export function renderNeeds(v: View, a: Actions, now = Date.now()): VNode {
  const n = v.needs
  if (!n) return loading()
  if (!n.asks.length && !n.tasks.length) return h('section', { class: 'page' }, empty('Nothing needs you', 'Your team asks here when they need a decision.', 'senate'))
  return h('section', { class: 'page' }, h('h1', { class: 'title' }, 'Needs you'), h('div', { class: 'list' }, ...n.asks.map((x) => askCard(x, v, a, now)), ...n.tasks.map((t) => taskCard(t, v, a, now))))
}
function askCard(x: PhoneAsk, v: View, a: Actions, now: number): VNode {
  const busy = v.busy.has(`ask:${x.id}`)
  const key = `ask:${x.id}`
  return h(
    'article',
    { class: 'card ask' },
    h('div', { class: 'card__h' }, face(x.who, 'sm'), whoLine(x.who, 'Agent'), h('span', { class: 'tm' }, ago(x.at, now))),
    h('p', { class: 'q' }, x.question ?? x.title),
    x.detail && x.detail !== x.question ? h('p', { class: 'detail mono' }, x.detail) : null,
    x.options.length ? h('div', { class: 'opts' }, ...x.options.map((o) => btn(o.label, () => a.answerAsk(x.id, o.id), { kind: o.kind === 'deny' ? 'ghost' : 'primary', disabled: busy, key: `${key}:${o.id}` }))) : null,
    x.text ? h('div', { class: 'free' }, h('textarea', { class: 'inp', rows: '2', 'data-k': key, placeholder: 'Your answer', on: { input: (e: Event) => a.draft(key, (e.target as HTMLTextAreaElement).value) } }), btn('Send', () => a.answerAsk(x.id, null), { kind: 'primary', disabled: busy || !(v.drafts[key] ?? '').trim() })) : null,
    !x.options.length && !x.text && !x.open ? h('p', { class: 'sub' }, 'Answer this on your Mac.') : null,
    x.open ? h('button', { type: 'button', class: 'link', on: { click: () => a.open(x.open!) } }, 'Open the conversation ›') : null
  )
}
function taskCard(t: PhoneTaskNeed, v: View, a: Actions, now: number): VNode {
  const busy = v.busy.has(`task:${t.taskId}`)
  const ans = `answer:${t.taskId}`
  return h(
    'article',
    { class: 'card ask' },
    h('div', { class: 'card__h' }, face(t.who, 'sm'), whoLine(t.who, t.kind === 'idea' ? 'Principia' : 'Board'), h('span', { class: 'tm' }, ago(t.at, now))),
    h('p', { class: 'kicker' }, t.kind === 'review' ? 'Ready for your OK' : t.kind === 'question' ? 'A question' : t.kind === 'idea' ? 'Idea' : 'Stuck'),
    h('b', { class: 'card__t' }, t.title),
    h('p', { class: 'q' }, t.text),
    t.kind === 'review'
      ? reviewButtons(t.taskId, v, a)
      : t.kind === 'question'
        ? h(
            'div',
            { class: 'col' },
            t.options.length ? h('div', { class: 'opts' }, ...t.options.map((o) => btn(o, () => a.answerTask(t.taskId, o), { kind: 'primary', disabled: busy }))) : null,
            h('div', { class: 'free' }, h('textarea', { class: 'inp', rows: '2', 'data-k': ans, placeholder: 'Your answer', on: { input: (e: Event) => a.draft(ans, (e.target as HTMLTextAreaElement).value) } }), btn('Send', () => a.answerTask(t.taskId, null), { kind: 'primary', disabled: busy || !(v.drafts[ans] ?? '').trim() }))
          )
        : null,
    t.kind !== 'idea' ? h('button', { type: 'button', class: 'link', disabled: busy, on: { click: () => a.notNeeded(t.taskId) } }, 'Not needed') : null,
    t.agentId ? h('button', { type: 'button', class: 'link', on: { click: () => a.open({ kind: 'agent', id: t.agentId! }) } }, 'Open the conversation ›') : null
  )
}

/** Approve / Send back; Send back opens a box for what should change (the same in Needs you and the conversation). */
function reviewButtons(taskId: string, v: View, a: Actions, small = false): VNode {
  const busy = v.busy.has(`task:${taskId}`)
  const back = `back:${taskId}`
  if (v.drafts[`${back}:open`] === '1')
    return h(
      'div',
      { class: 'free col' },
      h('textarea', { class: 'inp', rows: '3', 'data-k': back, placeholder: 'What should change?', on: { input: (e: Event) => a.draft(back, (e.target as HTMLTextAreaElement).value) } }),
      h('div', { class: 'opts' }, btn('Send back', () => a.sendBack(taskId), { kind: 'primary', disabled: busy || !(v.drafts[back] ?? '').trim(), small }), btn('Cancel', () => a.draft(`${back}:open`, ''), { kind: 'ghost', small }))
    )
  return h('div', { class: 'opts' }, btn('Approve', () => a.approve(taskId), { kind: 'primary', disabled: busy, small }), btn('Send back', () => a.draft(`${back}:open`, '1'), { kind: 'ghost', disabled: busy, small }))
}

// ---------- Chats ----------

export function renderChats(v: View, a: Actions, now = Date.now()): VNode {
  const c = v.chats
  if (!c) return loading()
  if (!c.rows.length) return h('section', { class: 'page' }, empty('No chats yet', 'Conversations with your agents and Claude show here.', 'scribe'))
  return h('section', { class: 'page' }, h('h1', { class: 'title' }, 'Chats'), h('div', { class: 'list rows' }, ...c.rows.map((r) => chatRow(r, a, now))))
}
function chatRow(r: PhoneChatRow, a: Actions, now: number): VNode {
  return h(
    'button',
    { type: 'button', class: 'crow', on: { click: () => a.open(r.ref) } },
    face(r.who, 'sm'),
    h('span', { class: 'row__t' }, h('span', { class: 'crow__h' }, h('b', null, r.title), r.live ? h('span', { class: 'livepill' }, 'Live') : null), r.line ? h('span', { class: 'row__s' }, r.line) : null),
    h('span', { class: 'tm' }, ago(r.at, now))
  )
}

export function renderSession(v: View, a: Actions): VNode {
  const s = v.session
  if (!s) return loading()
  const head = h('div', { class: 'chead' }, h('button', { type: 'button', class: 'back', 'aria-label': 'Back', on: { click: () => a.back() } }, '‹'), h('span', { class: 'chead__t' }, h('b', null, s.title), h('span', { class: 'row__s' }, v.replica ? turnWords(v.replica) : s.terminal?.ended ? 'Ended' : 'In a terminal on your Mac')))
  if (!v.replica) {
    const t = s.terminal
    return h('section', { class: 'page chat' }, head, h('div', { class: 'card quiet' }, t?.activity ? h('p', { class: 'activity' }, h('i', { class: 'dot' }), t.activity) : null, h('p', null, t?.canReply ? 'It finished and waits for you. Reply below and it carries on.' : 'This one runs in a terminal on your Mac. You can reply here when it waits for you.')))
  }
  const lines = chatLines(v.replica.items)
  const q = v.replica.snap.queue
  return h('section', { class: 'page chat' }, head, h('div', { class: 'msgs', 'data-scroll': 'chat' }, ...lines.map((l) => chatLine(l, v, a)), ...q.map((x, n) => h('div', { class: 'msg me queued' }, h('p', null, x.text), h('span', { class: 'qline' }, h('span', null, v.replica!.busy ? 'Queued: sends when it finishes' : 'Waiting to send'), n === q.length - 1 ? h('button', { type: 'button', class: 'qnow', disabled: v.busy.has('sendNow'), on: { click: () => a.sendNow() } }, v.replica!.busy ? 'Stop and send now' : 'Send now') : null)))))
}
function turnWords(r: ChatReplica): string {
  const t = r.snap.turn
  if (t === 'working' || t === 'starting') return r.snap.activity ?? 'Working'
  if (t === 'needs') return 'Waiting for you'
  if (t === 'sleeping') return 'Asleep: a message wakes it'
  if (t === 'ended') return 'Ended'
  if (t === 'error') return 'Something went wrong'
  return 'Your turn'
}
function chatLine(l: ChatLine, v: View, a: Actions): VNode {
  const busy = v.busy.has(`req:${'requestId' in l ? l.requestId : ''}`)
  switch (l.t) {
    case 'me':
      return h('div', { class: `msg me${l.queued ? ' queued' : ''}` }, h('p', null, l.text))
    case 'say':
      return h('div', { class: 'msg say' }, md(l.text), l.streaming ? h('span', { class: 'caret', 'aria-hidden': 'true' }) : null)
    case 'thinking':
      return h('div', { class: 'tool' }, tile('run'), 'Thinking')
    case 'tool':
      return h('div', { class: 'tool' }, tile(l.status === 'run' ? 'run' : l.status === 'ok' ? 'ok' : 'fail'), h('span', { class: 'tool__t' }, h('span', null, l.text, l.sub ? h('span', { class: 'sub' }, ` · ${l.sub} step${l.sub === 1 ? '' : 's'}`) : null), l.code ? h('code', { class: 'tool__c' }, l.code) : null))
    case 'plan':
      return h('div', { class: 'card plan' }, h('p', { class: 'kicker' }, `Plan · ${l.done} of ${l.total} done`), ...l.items.map((i) => h('p', { class: `todo ${i.done ? 'is-done' : i.now ? 'is-now' : ''}` }, i.done ? '✓ ' : i.now ? '● ' : '○ ', i.text)))
    case 'permission':
      return h(
        'div',
        { class: 'card gate' },
        h('p', { class: 'q' }, l.title),
        l.detail ? h('p', { class: 'detail mono' }, l.detail) : null,
        l.open ? h('div', { class: 'opts' }, btn('Allow', () => a.chatAnswer(l.requestId, { kind: 'allow' }), { kind: 'primary', disabled: busy }), btn('Deny', () => a.chatAnswer(l.requestId, { kind: 'deny' }), { kind: 'ghost', disabled: busy })) : h('p', { class: 'sub' }, l.outcome ?? '')
      )
    case 'question': {
      if (!l.open) return h('div', { class: 'card gate' }, ...l.questions.map((q) => h('p', { class: 'q' }, q.question)), h('p', { class: 'sub' }, l.answers ? Object.values(l.answers).join(' · ') : 'Skipped'))
      const key = `qa:${l.requestId}`
      const answers: Record<string, string> = {}
      for (const q of l.questions) {
        const picked = v.picks[`${key}:${q.question}`] ?? []
        if (picked.length) answers[q.question] = picked.join(', ')
      }
      const one = l.questions.length === 1 && !l.questions[0]!.multi
      return h(
        'div',
        { class: 'card gate' },
        ...l.questions.map((q) =>
          h(
            'div',
            { class: 'col' },
            h('p', { class: 'q' }, q.question),
            h('div', { class: 'opts' }, ...q.options.map((o) => btn(o, () => (one ? a.chatAnswer(l.requestId, { kind: 'answer', answers: { [q.question]: o } }) : a.pickOption(`${key}:${q.question}`, o, q.multi)), { kind: (v.picks[`${key}:${q.question}`] ?? []).includes(o) ? 'primary' : undefined, disabled: busy })))
          )
        ),
        h('div', { class: 'free' }, h('textarea', { class: 'inp', rows: '1', 'data-k': key, placeholder: 'Or type an answer', on: { input: (e: Event) => a.draft(key, (e.target as HTMLTextAreaElement).value) } })),
        h(
          'div',
          { class: 'opts' },
          btn('Send', () => {
            const typed = (v.drafts[key] ?? '').trim()
            const out = typed ? Object.fromEntries(l.questions.map((q) => [q.question, typed])) : answers
            if (Object.keys(out).length) a.chatAnswer(l.requestId, { kind: 'answer', answers: out })
          }, { kind: 'primary', disabled: busy || (!Object.keys(answers).length && !(v.drafts[key] ?? '').trim()) }),
          btn('Skip', () => a.chatAnswer(l.requestId, { kind: 'skip' }), { kind: 'ghost', disabled: busy })
        )
      )
    }
    case 'planCard':
      return h(
        'div',
        { class: 'card gate' },
        h('p', { class: 'kicker' }, 'The plan'),
        h('div', { class: 'q' }, md(l.plan)),
        l.open ? h('div', { class: 'opts' }, btn('Approve the plan', () => a.chatAnswer(l.requestId, { kind: 'approvePlan' }), { kind: 'primary', disabled: busy }), btn('Keep planning', () => a.chatAnswer(l.requestId, { kind: 'rejectPlan' }), { kind: 'ghost', disabled: busy })) : h('p', { class: 'sub' }, l.outcome ?? '')
      )
    case 'notice':
      return h('div', { class: `notice notice--${l.tone}` }, l.text)
    case 'end':
      return h('div', { class: 'end' }, l.text)
  }
}

export function renderAgent(v: View, a: Actions, now = Date.now()): VNode {
  const g = v.agent
  if (!g) return loading()
  return h(
    'section',
    { class: 'page chat' },
    h('div', { class: 'chead' }, h('button', { type: 'button', class: 'back', 'aria-label': 'Back', on: { click: () => a.back() } }, '‹'), face(g.who, 'sm'), h('span', { class: 'chead__t' }, whoLine(g.who, 'Agent'), h('span', { class: 'row__s' }, g.status))),
    h('div', { class: 'msgs', 'data-scroll': 'chat' }, ...(g.items.length ? g.items.map((i) => threadItem(i, v, a, now)) : [h('p', { class: 'sub center' }, `Message ${g.who.name}. ${g.who.name} answers in its own chat and puts work on the board when it should be tracked.`)]))
  )
}
function threadItem(i: PhoneThreadItem, v: View, a: Actions, now: number): VNode {
  const busy = v.busy.has(`task:${i.taskId}`)
  switch (i.kind) {
    case 'me':
      return h('div', { class: 'msg me' }, h('p', null, i.text), h('span', { class: 'tm' }, ago(i.at, now)))
    case 'note':
    case 'task':
      return h('div', { class: 'end' }, i.text)
    case 'agent': {
      const ans = `answer:${i.taskId}`
      return h(
        'div',
        { class: 'msg say' },
        md(i.text),
        i.card === 'review' ? reviewButtons(i.taskId, v, a, true) : null,
        i.card === 'ask' ? h('div', { class: 'free' }, h('textarea', { class: 'inp', rows: '1', 'data-k': ans, placeholder: 'Your answer', on: { input: (e: Event) => a.draft(ans, (e.target as HTMLTextAreaElement).value) } }), btn('Send', () => a.answerTask(i.taskId, null), { kind: 'primary', disabled: busy || !(v.drafts[ans] ?? '').trim(), small: true })) : null,
        h('span', { class: 'tm' }, ago(i.at, now))
      )
    }
  }
}

// ---------- Team room ----------

export function renderRoom(v: View, a: Actions, now = Date.now()): VNode {
  const r = v.room
  if (!r) return loading()
  if (!r.enabled) return h('section', { class: 'page' }, empty('The team room is off', r.message ?? 'Turn on Companies and Departments on your Mac.', 'forum'))
  const by = new Map(r.members.map((m) => [m.id, m]))
  const agents = r.members.filter((m) => m.kind === 'agent')
  const whoOpen = v.drafts['room:who:open'] === '1'
  return h(
    'section',
    { class: 'page chat' },
    h(
      'div',
      { class: 'chead' },
      r.channels.length > 1
        ? h('select', { class: 'chan', 'aria-label': 'Channel', on: { change: (e: Event) => a.channel((e.target as HTMLSelectElement).value) } }, ...r.channels.map((c) => h('option', { value: c.id, selected: c.id === r.channelId }, c.label)))
        : h('b', null, r.channels[0]?.label ?? '#general'),
      agents.length
        ? h('button', { type: 'button', class: 'whobtn', 'aria-expanded': whoOpen ? 'true' : 'false', on: { click: () => a.draft('room:who:open', whoOpen ? '' : '1') } }, `${agents.length} agent${agents.length === 1 ? '' : 's'} · who's who ${whoOpen ? '▴' : '▾'}`)
        : h('span', { class: 'row__s' }, 'No agents in this company yet')
    ),
    whoOpen ? h('div', { class: 'whos' }, ...agents.map((m) => h('button', { type: 'button', class: 'whos__m', on: { click: () => a.mention(m.handle) } }, h('b', null, m.name), m.role ? h('span', { class: 'role' }, m.role) : null, h('span', { class: 'sub' }, `@${m.handle}`)))) : null,
    h(
      'div',
      { class: 'msgs', 'data-scroll': 'chat' },
      ...(r.messages.length ? r.messages.map((m) => roomMsg(m.authorId, m.text, m.at, m.kind, by, r.me, now, !!m.threadId)) : [h('p', { class: 'sub center' }, 'Say hello. @mention an agent and it answers here.')]),
      ...(r.answering ?? []).map((n) => h('div', { class: 'typing' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), `${n} is replying…`))
    )
  )
}
function roomMsg(author: string, text: string, at: string, kind: string, by: Map<string, PhoneRoomMember>, me: string | null, now: number, reply = false): VNode {
  const m = by.get(author)
  if (kind === 'system') return h('div', { class: 'end' }, text)
  const mine = author === me
  return h('div', { class: `msg ${mine ? 'me' : 'say'}${reply ? ' reply' : ''}` }, mine ? null : h('span', { class: 'author' }, `${reply ? '↳ ' : ''}${m ? `${m.name}${m.role ? ` · ${m.role}` : ''}` : 'Someone'}`), mine ? h('p', null, text) : md(text), h('span', { class: 'tm' }, ago(at, now)))
}

// ---------- shells ----------

export function loading(): VNode {
  return h('div', { class: 'page' }, h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel short' }))
}

/** "Principia" in Cinzel over the arch: the pairing and signed-out screens */
const lettering = (): VNode[] => [plate('arch', true), h('h1', { class: 'brand' }, 'Principia')]
const status = (tile: 'ok' | 'needs' | 'fail' | 'run' | 'q', text: string): VNode => h('p', { class: 'status', role: 'status' }, h('span', { class: `tes tes--${tile}`, 'aria-hidden': 'true' }), h('span', null, text))

export interface PairView {
  name: string
  error: string | null
  busy: boolean
  /** hosted: the Mac's host the link names ("quiet-tree-42.trycloudflare.com"); null on the Mac's own page */
  mac: string | null
  /** hosted: this phone is already paired with another Mac (its host); pairing replaces it */
  replaces?: string | null
  /** hosted, in the browser (not a Home Screen app): say where the pairing lives */
  browserTab?: boolean
}
export function renderPair(p: PairView, a: Actions): VNode {
  return h(
    'section',
    { class: 'pairing' },
    ...lettering(),
    h('p', { class: 'lede' }, 'Pair this phone with your Mac to watch your agents and keep the work going.'),
    p.busy ? status('run', 'Pairing') : p.error ? status('fail', 'Code not accepted') : status('needs', 'One-time code'),
    p.mac ? h('p', { class: 'fine' }, `Your Mac: ${p.mac}`) : null,
    p.replaces ? h('p', { class: 'notice notice--warn', role: 'alert' }, `This phone is paired with another Mac (${p.replaces}). Pair only if this link came from your own Mac: pairing here replaces it.`) : null,
    h('div', { class: 'fill' }),
    h('label', { class: 'field' }, h('span', null, 'Name this phone'), h('input', { class: 'inp', 'data-k': 'pair:name', value: p.name, maxlength: '60', autocomplete: 'off', on: { input: (e: Event) => a.draft('pair:name', (e.target as HTMLInputElement).value) } })),
    p.error ? h('p', { class: 'err' }, p.error) : null,
    btn(p.busy ? 'Pairing…' : p.replaces ? 'Replace and pair' : 'Pair this phone', () => a.pair(), { kind: 'primary', disabled: p.busy, wide: true }),
    h('p', { class: 'fine' }, 'The code works once, for 5 minutes. Your Mac lists this phone in Settings › App › Phone, with Revoke.'),
    p.browserTab ? h('p', { class: 'fine' }, 'Want it on your Home Screen? On iPhone the Home Screen app keeps its own sign-in: add it first, open it, and paste this link there.') : null
  )
}

export interface OutView {
  reason: 'unpaired' | 'off' | 'revoked' | 'gone'
  /** the app runs on its own site (hosted mode) */
  hosted: boolean
  /** hosted: the Mac this phone remembers */
  mac: string | null
  error: string | null
  /** hosted: a Home Screen app (the QR opens the browser, never this app), so pasting the link is the way in */
  standalone?: boolean
  /** hosted: what is in the paste field, and why it was not a pairing link */
  paste?: string
  pasteError?: string | null
  /** RA8: checking a new address */
  busy?: boolean
}
/**
 * Hosted: the pairing link, pasted. On iPhone a Home Screen app keeps its own storage and the camera's QR always opens
 * the browser, so the app itself needs a way in: copy the link on the Mac (Universal Clipboard) or long-press the QR in
 * the camera and Copy Link, then paste it here.
 */
function pasteField(o: OutView, a: Actions): VNode {
  const read = (el: EventTarget | null): string => ((el as HTMLElement | null)?.closest('.paste')?.querySelector('input') as HTMLInputElement | null)?.value ?? ''
  // RA8: a phone that is still paired takes the Mac's new address: its words (or its link), no new pairing
  const moved = o.reason === 'gone'
  return h(
    'div',
    { class: 'paste' },
    h(
      'label',
      { class: 'field' },
      h('span', null, moved ? 'The new address from your Mac' : o.standalone ? 'Paste the pairing link' : 'Or paste the pairing link'),
      h('input', { class: 'inp', 'data-k': 'pair:paste', value: o.paste ?? '', type: moved ? 'text' : 'url', inputmode: moved ? 'text' : 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: moved ? 'quiet-tree-forty-two' : 'https://…#mac=…&code=…', on: { input: (e: Event) => a.draft('pair:paste', (e.target as HTMLInputElement).value), keydown: (e: Event) => (e as KeyboardEvent).key === 'Enter' && a.pasteLink(read(e.target)) } })
    ),
    o.pasteError ? h('p', { class: 'err' }, o.pasteError) : null,
    h('button', { type: 'button', class: `btn btn--wide${o.standalone || moved ? ' btn--primary' : ''}`, disabled: o.busy ? true : undefined, on: { click: (e: Event) => a.pasteLink(read(e.target)) } }, moved ? (o.busy ? 'Checking…' : 'Connect') : 'Open the link'),
    moved
      ? h('p', { class: 'fine' }, 'On your Mac: Settings › App › Phone shows its address in words under Paired phones. Type them here. The address must prove it is your Mac before this phone signs in there.')
      : o.standalone
        ? h('p', { class: 'fine' }, 'On your Mac, Copy link under the code, or long-press the code in the Camera and Copy Link.')
        : null
  )
}

export function renderSignedOut(o: OutView, a: Actions): VNode {
  const line =
    o.reason === 'gone'
      ? 'Your Mac is not at its last address. Phone may be off there, or its address changed after a restart. This phone is still paired.'
      : o.reason === 'off'
        ? 'Phone was turned off on your Mac. Turn it on again and scan a new code.'
        : o.reason === 'revoked'
          ? 'This phone was removed on your Mac. Scan a new code to pair it again.'
          : 'On your Mac, open Settings › App › Phone, turn it on and scan the code with this phone.'
  const head = o.reason === 'gone' ? status('q', 'Waiting for your Mac') : o.reason === 'unpaired' ? status('q', 'Not paired') : status('fail', o.reason === 'off' ? 'Phone is off' : 'Removed on your Mac')
  return h(
    'section',
    { class: 'pairing' },
    ...lettering(),
    h('p', { class: 'lede' }, line),
    head,
    o.error ? h('p', { class: 'err' }, o.error) : null,
    o.reason === 'gone' && o.mac ? h('p', { class: 'fine' }, `Last address: ${o.mac}`) : null,
    h('div', { class: 'fill' }),
    o.hosted ? pasteField(o, a) : null,
    btn('Try again', () => a.retry(), { kind: o.reason === 'gone' && !o.standalone ? 'primary' : 'ghost', wide: true }),
    o.reason === 'gone' ? btn('Forget this Mac', () => a.forget(), { kind: 'ghost', wide: true }) : null,
    o.hosted ? h('p', { class: 'fine' }, 'This page keeps nothing but the key to your Mac. Your work stays on the Mac.') : null
  )
}
