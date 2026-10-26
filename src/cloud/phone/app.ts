/**
 * Principia on your phone (REMOTE.md): watch what the agents do and keep the work going. Hash router
 * (#/c/<company>/<tab>[/session|agent/<id>]), one state object, screens rebuilt from VNodes (text nodes only), and a
 * composer dock that is never rebuilt while you type. Live over one WebSocket: the Mac says what changed, the phone
 * refetches what is on screen; an open chat follows the Mac's own chat ops.
 *
 * Hosted (REMOTE.md RA6, the build for its own https site): the pairing link names the Mac's address
 * (`#mac=…&code=…`), the token is kept in this site's localStorage and sent as a bearer, and the socket's first message
 * carries it. The site itself holds no data: everything comes from the Mac, which is the authority.
 */
import type { ChatOp, ChatSnapshot } from '../../shared/chat'
import { macFromTyped, parseMoveHash, parsePairHash, type PhoneResumeResponse, type PhoneAgent, type PhoneChats, type PhoneCompany, type PhoneMe, type PhoneNeeds, type PhoneNow, type PhonePairResponse, type PhoneRoom, type PhoneRoomMessage, type PhoneServerMsg, type PhoneSession, type PhoneChatRef } from '../../shared/remote'
import { ApiError, createApi, MacGone, NotPaired } from './api'
import { checkMac, forgetMac, liveUrl, pastedPairHash, loadMac, macHost, saveMac, type PairedMac, type StorageLike } from './mac'
import { mount, type VNode } from '../console/dom'
import { openLive, type Live } from './live'
import { ChatReplica, chatMessageAction, placeMessage, deviceName, terminalComposer, insertMention, mentionAt, mentionMatches, parseRoute, routeHash, type Route, type Tab } from './model'
import { renderAgent, renderChats, renderHeader, renderNeeds, renderNow, renderPair, renderRoom, renderSession, renderSignedOut, renderTabs, type Actions, type View } from './render'

declare const __PHONE_HOSTED__: boolean
/** the build for its own site (vite.phone-site.config.ts); the Mac's own bundle is same-origin */
const HOSTED = typeof __PHONE_HOSTED__ !== 'undefined' && __PHONE_HOSTED__
const store: StorageLike | null = (() => {
  try {
    return window.localStorage
  } catch {
    return null
  }
})()
let paired: PairedMac | null = HOSTED ? loadMac(store) : null
/** hosted, while pairing: the Mac named by the link */
let pairMac: string | null = null
const api = createApi(undefined, { base: () => (HOSTED ? (pairMac ?? paired?.mac ?? '') : ''), token: () => (HOSTED ? (paired?.token ?? null) : null) })
const pairOf = (hash: string): { code: string; mac: string | null } | null => {
  const p = parsePairHash(hash)
  // the Mac's own page pairs with itself; the hosted site needs the Mac's address
  if (!p) return null
  if (HOSTED && !p.mac) return null
  return p
}
/** a Home Screen app (iOS keeps its storage apart from Safari's, and the QR always opens Safari) */
const STANDALONE = (() => {
  try {
    return (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches
  } catch {
    return false
  }
})()
const $ = (id: string): HTMLElement => document.getElementById(id)!
const doc = document as unknown as Parameters<typeof mount>[1]

interface State {
  phase: 'boot' | 'pair' | 'out' | 'in'
  /** gone: hosted, the Mac's last address does not answer (the tunnel stopped or changed) */
  outReason: 'unpaired' | 'off' | 'revoked' | 'gone'
  pairError: string | null
  /** hosted, signed out: why a pasted link was not a pairing link */
  pasteError: string | null
  me: PhoneMe | null
  route: Route
  online: boolean
  error: string | null
  toast: string | null
  busy: Set<string>
  drafts: Record<string, string>
  picks: Record<string, string[]>
  now: PhoneNow | null
  needs: PhoneNeeds | null
  chats: PhoneChats | null
  room: PhoneRoom | null
  session: PhoneSession | null
  replica: ChatReplica | null
  agent: PhoneAgent | null
}
const st: State = { phase: 'boot', outReason: 'unpaired', pairError: null, pasteError: null, me: null, route: parseRoute(location.hash), online: false, error: null, toast: null, busy: new Set(), drafts: {}, picks: {}, now: null, needs: null, chats: null, room: null, session: null, replica: null, agent: null }
let live: Live | null = null
try {
  // the app scrolls itself (a chat opens at its newest message); the browser never restores an old position
  history.scrollRestoration = 'manual'
} catch {
  /* older browsers */
}
let toastTimer: ReturnType<typeof setTimeout> | null = null

// ---------- small helpers ----------

/**
 * Cards must not move under a thumb: when the Needs-you list changes (a new ask arrives, an answered one leaves),
 * a tap on a card's button in the next moment is held, and the phone says so, instead of pressing whatever slid
 * into that spot.
 */
const SETTLE_MS = 900
let needsKeys = ''
let settleUntil = 0
function setNeeds(n: PhoneNeeds): void {
  const keys = [...n.asks.map((x) => x.id), ...n.tasks.map((t) => `${t.kind}:${t.taskId}`)].join('|')
  if (st.needs && keys !== needsKeys) settleUntil = Date.now() + SETTLE_MS
  needsKeys = keys
  st.needs = n
}
function settling(): boolean {
  if (Date.now() >= settleUntil || st.route.tab !== 'needs' || st.route.open) return false
  say('The list just changed. Check the card and tap again.')
  return true
}

/** The last company and tab, so reopening the page lands where you were (this phone only). */
const LAST = 'principia.phone.last'
function remember(r: Route): void {
  try {
    localStorage.setItem(LAST, routeHash({ ...r, open: null }))
  } catch {
    /* private mode */
  }
}
function remembered(): string | null {
  try {
    const h = localStorage.getItem(LAST)
    return h && h.startsWith('#/c/') ? h : null
  } catch {
    return null
  }
}

const companyId = (): string | null => st.route.companyId
const companies = (): PhoneCompany[] => st.me?.companies ?? []
function say(text: string): void {
  st.toast = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    st.toast = null
    renderToast()
  }, 2600)
  renderToast()
}
/** Signed out on the Mac's side: hosted, the kept token is worthless now, so it goes. */
function signedOut(reason: State['outReason']): void {
  if (reason !== 'gone' && HOSTED) {
    forgetMac(store)
    paired = null
    live?.close()
    live = null
  }
  st.phase = 'out'
  st.outReason = reason
  render()
}
function fail(e: unknown): void {
  if (e instanceof NotPaired) return signedOut('unpaired')
  say(e instanceof ApiError ? e.message : e instanceof TypeError ? 'Your Mac is not reachable right now.' : e instanceof Error ? e.message : String(e))
}
async function busy<T>(key: string, f: () => Promise<T>): Promise<T | undefined> {
  if (st.busy.has(key)) return undefined
  st.busy.add(key)
  render()
  try {
    return await f()
  } catch (e) {
    fail(e)
    return undefined
  } finally {
    st.busy.delete(key)
    render()
  }
}
function go(r: Partial<Route>): void {
  const next = { ...st.route, ...r }
  const hash = routeHash(next)
  if (location.hash !== hash) location.hash = hash
  else onRoute()
}

// ---------- data ----------

async function loadMe(): Promise<void> {
  st.me = await api.me()
  const cs = st.me.companies
  if (!cs.some((c) => c.id === st.route.companyId)) {
    const first = cs.find((c) => !c.personal) ?? cs[0]
    if (first) {
      st.route = { companyId: first.id, tab: st.route.tab, open: null }
      history.replaceState(null, '', routeHash(st.route))
    }
  }
}
/**
 * RA2: rotate on resume. The app opened (or came back to a Mac): the Mac gives a new token for the one this phone
 * holds (hosted: in the body; the Mac's own page: a new cookie). The old one keeps working for a moment, so a lost
 * answer never signs the phone out. Once per start.
 */
async function resumeToken(): Promise<void> {
  try {
    const out = await api.call<PhoneResumeResponse>('resume', { body: {} })
    if (HOSTED && paired && out.token && /^[A-Za-z0-9_-]{16,200}$/.test(out.token)) {
      paired = { ...paired, token: out.token }
      saveMac(store, paired)
    }
  } catch {
    /* the old token still works; next start tries again */
  }
}
/**
 * RA8: the Mac's address changed (a quick tunnel is new after each restart). The new address must prove it is this
 * phone's Mac (checkMac: a fresh nonce signed with the token's hash, bound to that address) before the token goes there.
 */
async function moveTo(mac: string): Promise<void> {
  if (!HOSTED || !paired) return
  if (st.busy.has('move')) return
  st.busy.add('move')
  st.pasteError = null
  render()
  try {
    const r = await checkMac((...a) => fetch(...a), mac, paired)
    if (r !== 'ok') {
      st.phase = 'out'
      st.outReason = r === 'unknown' ? 'unpaired' : 'gone'
      st.pasteError =
        r === 'unknown'
          ? 'That Mac does not know this phone any more. Scan a new code on your Mac.'
          : r === 'gone'
            ? 'Nothing answers at that address. On your Mac, check that Phone is on and shared, then try again.'
            : 'That address is not your Mac. Check the words in Settings › App › Phone on your Mac.'
      if (r === 'unknown') {
        forgetMac(store)
        paired = null
      }
      return
    }
    paired = { ...paired, mac }
    saveMac(store, paired)
    live?.close()
    live = null
    st.drafts['pair:paste'] = ''
    history.replaceState(null, '', remembered() ?? '#/')
    st.route = parseRoute(location.hash)
    await start()
    if (st.phase === 'in') say('Connected to your Mac at its new address')
  } finally {
    st.busy.delete('move')
    render()
  }
}
const cid = (): Record<string, string> => ({ companyId: companyId() ?? '' })
async function loadNow(): Promise<void> {
  st.now = await api.call<PhoneNow>('now', { params: cid() })
}
async function loadNeeds(): Promise<void> {
  setNeeds(await api.call<PhoneNeeds>('needs', { params: cid() }))
}
async function loadChats(): Promise<void> {
  st.chats = await api.call<PhoneChats>('chats', { params: cid() })
}
async function loadRoom(channelId?: string | null): Promise<void> {
  st.room = await api.call<PhoneRoom>('room', { params: cid(), query: { channelId: channelId ?? st.room?.channelId ?? undefined } })
}
async function loadSession(id: string): Promise<void> {
  const s = await api.call<PhoneSession>('session', { params: { ...cid(), sessionId: id } })
  st.session = s
  st.replica = s.chat ? new ChatReplica(s.chat as ChatSnapshot) : null
}
async function loadAgent(id: string): Promise<void> {
  st.agent = await api.call<PhoneAgent>('agent', { params: { ...cid(), agentId: id } })
  // AGENT CHAT: an agent's conversation is its own chat, read with the same chat model as any chat (streaming, tool
  // lines, Allow / Deny): the agent's screen becomes that chat, in place (Back still returns to the list)
  const sid = st.agent.chatSessionId
  if (sid && st.route.open?.kind === 'agent' && st.route.open.id === id) {
    st.route = { ...st.route, open: { kind: 'session', id: sid } }
    history.replaceState(null, '', routeHash(st.route))
    st.agent = null
    await loadSession(sid)
  }
}

/** What the screen needs, fetched; the needs count always (the tab badge). */
async function loadScreen(): Promise<void> {
  const r = st.route
  const jobs: Promise<void>[] = [loadNeeds()]
  if (r.open?.kind === 'session') jobs.push(loadSession(r.open.id))
  else if (r.open?.kind === 'agent') jobs.push(loadAgent(r.open.id))
  else if (r.tab === 'now') jobs.push(loadNow())
  else if (r.tab === 'chats') jobs.push(loadChats())
  else if (r.tab === 'room') jobs.push(loadRoom())
  await Promise.all(jobs)
}
function subscribe(): void {
  const r = st.route
  if (!companyId()) return
  live?.send({ t: 'sub', companyId: companyId()!, sessionId: r.open?.kind === 'session' ? r.open.id : null, channelId: r.tab === 'room' ? (st.room?.channelId ?? null) : null })
}

let routeSeq = 0
async function onRoute(): Promise<void> {
  const prev = st.route
  st.route = parseRoute(location.hash)
  if (st.phase !== 'in') return
  if (!companies().some((c) => c.id === st.route.companyId)) {
    await loadMe().catch(fail)
  }
  if (st.route.companyId) remember(st.route)
  const changedCo = prev.companyId !== st.route.companyId
  if (changedCo) {
    st.now = st.needs = st.chats = null
    st.room = null
  }
  if (st.route.open?.id !== prev.open?.id || st.route.open?.kind !== prev.open?.kind) {
    st.session = null
    st.replica = null
    st.agent = null
    stick = true
  }
  render()
  const n = ++routeSeq
  try {
    await loadScreen()
    if (n !== routeSeq) return
    subscribe()
  } catch (e) {
    fail(e)
  }
  render()
}

// ---------- live ----------

let refetch: ReturnType<typeof setTimeout> | null = null
let pendingWhat = new Set<string>()
function onLive(m: PhoneServerMsg): void {
  switch (m.t) {
    case 'changed':
      if (m.companyId && m.companyId !== companyId()) {
        if (m.what.includes('companies')) pendingWhat.add('companies')
      } else m.what.forEach((w) => pendingWhat.add(w))
      if (!refetch) refetch = setTimeout(flushLive, 150)
      return
    case 'chat': {
      const r = st.replica
      const act = chatMessageAction({ openId: st.route.open?.kind === 'session' ? st.route.open.id : null, session: st.session, hasReplica: !!r }, m.sessionId)
      if (act === 'reload') void loadSession(m.sessionId).then(() => render({ live: true }), () => undefined)
      if (act !== 'apply' || !r) return
      const res = r.apply(m.seq, m.ops as ChatOp[])
      if (res === 'gap') void loadSession(m.sessionId).then(() => render({ live: true }), () => undefined)
      else if (res === 'ok') render({ live: true })
      return
    }
    case 'screen': {
      // a terminal with no transcript yet: its last lines, live
      const s = st.session
      if (!s?.terminal || s.ref.id !== m.sessionId || st.route.open?.id !== m.sessionId) return
      st.session = { ...s, terminal: { ...s.terminal, screen: m.text, source: 'screen' } }
      render({ live: true })
      return
    }
    case 'room': {
      const room = st.room
      if (!room || room.channelId !== m.message.channelId || room.messages.some((x) => x.id === m.message.id)) return
      st.room = { ...room, messages: placeMessage(room.messages, m.message as PhoneRoomMessage) }
      render({ live: true })
      return
    }
    case 'bye':
      return signedOut(m.reason)
    default:
      return
  }
}
async function flushLive(): Promise<void> {
  refetch = null
  const what = pendingWhat
  pendingWhat = new Set()
  if (st.phase !== 'in') return
  const r = st.route
  const jobs: Promise<void>[] = []
  if (what.has('companies')) jobs.push(loadMe())
  if (what.has('needs')) jobs.push(loadNeeds())
  if (r.open?.kind === 'agent' && (what.has('chats') || what.has('now'))) jobs.push(loadAgent(r.open.id))
  else if (r.open?.kind === 'session' && !st.replica && what.has('chats')) jobs.push(loadSession(r.open.id))
  else if (!r.open && r.tab === 'now' && what.has('now')) jobs.push(loadNow())
  else if (!r.open && r.tab === 'chats' && what.has('chats')) jobs.push(loadChats())
  else if (!r.open && r.tab === 'room' && what.has('room')) jobs.push(loadRoom())
  try {
    await Promise.all(jobs)
    render({ live: true })
  } catch (e) {
    if (e instanceof NotPaired) fail(e)
  }
}

// ---------- actions ----------

const actions: Actions = {
  tab(t: Tab) {
    go({ tab: t, open: null })
  },
  company(id) {
    go({ companyId: id, open: null })
  },
  togglePause() {
    const co = companies().find((c) => c.id === companyId())
    if (!co) return
    const next = !co.paused
    if (!confirm(next ? `Pause ${co.name}? Agents stop starting new work and its schedules wait. Other companies keep running.` : `Resume ${co.name}?`)) return
    void busy('pause', async () => {
      st.now = await api.call<PhoneNow>('pause', { params: cid(), body: { paused: next } })
      await loadMe()
      say(next ? `${co.name} is paused` : `${co.name} is running`)
    })
  },
  open(ref: PhoneChatRef) {
    go({ tab: 'chats', open: ref })
  },
  back() {
    go({ open: null })
  },
  answerAsk(askId, optionId) {
    const key = `ask:${askId}`
    const text = (st.drafts[key] ?? '').trim()
    if (settling()) return
    void busy(key, async () => {
      setNeeds(await api.call<PhoneNeeds>('answerAsk', { params: { ...cid(), askId }, body: { ...(optionId ? { optionId } : {}), ...(text ? { text } : {}) } }))
      delete st.drafts[key]
      say('Sent')
      // answered inside a terminal's conversation: its card goes and the composer comes back
      const open = st.route.open
      if (open?.kind === 'session' && st.session?.terminal) await loadSession(open.id)
    })
  },
  approve(taskId) {
    if (settling()) return
    void busy(`task:${taskId}`, async () => {
      setNeeds(await api.call<PhoneNeeds>('approveTask', { params: { ...cid(), taskId }, body: {} }))
      say('Approved')
      if (st.route.open?.kind === 'agent') await loadAgent(st.route.open.id)
    })
  },
  notNeeded(taskId) {
    if (settling()) return
    const t = st.needs?.tasks.find((x) => x.taskId === taskId)
    if (!window.confirm(`Cancel “${t?.title ?? 'this task'}”? It leaves Needs you. You can reopen it from the Board on your Mac.`)) return
    void busy(`task:${taskId}`, async () => {
      setNeeds(await api.call<PhoneNeeds>('cancelTask', { params: { ...cid(), taskId }, body: {} }))
      say('Canceled')
    })
  },
  sendBack(taskId) {
    const key = `back:${taskId}`
    const text = (st.drafts[key] ?? '').trim()
    if (!text || settling()) return
    void busy(`task:${taskId}`, async () => {
      setNeeds(await api.call<PhoneNeeds>('sendBackTask', { params: { ...cid(), taskId }, body: { text } }))
      delete st.drafts[key]
      delete st.drafts[`${key}:open`]
      say('Sent back')
    })
  },
  answerTask(taskId, option) {
    const key = `answer:${taskId}`
    const text = option ?? (st.drafts[key] ?? '').trim()
    if (!text || settling()) return
    void busy(`task:${taskId}`, async () => {
      setNeeds(await api.call<PhoneNeeds>('answerTask', { params: { ...cid(), taskId }, body: { text } }))
      delete st.drafts[key]
      say('Answered')
      if (st.route.open?.kind === 'agent') await loadAgent(st.route.open.id)
    })
  },
  chatAnswer(requestId, decision) {
    const open = st.route.open
    if (open?.kind !== 'session') return
    void busy(`req:${requestId}`, async () => {
      await api.call('sessionAnswer', { params: { ...cid(), sessionId: open.id }, body: { requestId, decision } })
      delete st.drafts[`qa:${requestId}`]
    })
  },
  continueSession() {
    const open = st.route.open
    if (open?.kind !== 'session') return
    void busy('continue', async () => {
      const out = await api.call<{ ok: boolean; sessionId?: string }>('sessionContinue', { params: { ...cid(), sessionId: open.id }, body: {} })
      say('Continuing on your Mac')
      if (out?.sessionId && out.sessionId !== open.id) go({ open: { kind: 'session', id: out.sessionId } })
    })
  },
  sendNow() {
    const open = st.route.open
    if (open?.kind !== 'session') return
    void busy('sendNow', async () => {
      await api.call('sessionStop', { params: { ...cid(), sessionId: open.id }, body: { sendNow: true } })
      stick = true
    })
  },
  mention(handle) {
    const ta = $('dock').querySelector('textarea')
    if (!ta) return
    const v = ta.value
    const sep = v && !/\s$/.test(v) ? ' ' : ''
    ta.value = `${v}${sep}@${handle} `
    ta.dispatchEvent(new Event('input'))
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    delete st.drafts['room:who:open']
    render()
  },
  pickOption(key, option, multi) {
    const cur = st.picks[key] ?? []
    st.picks[key] = multi ? (cur.includes(option) ? cur.filter((x) => x !== option) : [...cur, option]) : [option]
    render()
  },
  channel(id) {
    void (async () => {
      try {
        await loadRoom(id)
        subscribe()
        stick = true
        render()
      } catch (e) {
        fail(e)
      }
    })()
  },
  pair() {
    const p = pairOf(location.hash)
    if (!p) return
    const code = p.code
    const name = (st.drafts['pair:name'] ?? deviceName(navigator.userAgent)).trim() || 'Phone'
    void (async () => {
      st.busy.add('pair')
      st.pairError = null
      render()
      try {
        if (HOSTED) pairMac = p.mac
        const out = await api.call<PhonePairResponse>('pair', { body: { code, name } })
        if (HOSTED) {
          if (!out.token) throw new Error('Your Mac does not know this phone app yet. On your Mac, check Settings › App › Phone › Phone app address.')
          paired = { mac: p.mac!, token: out.token, device: out.device, pairedAt: new Date().toISOString() }
          saveMac(store, paired)
          live?.close()
          live = null
        }
        history.replaceState(null, '', '#/')
        st.route = parseRoute('#/')
        await start()
      } catch (e) {
        if (HOSTED) {
          pairMac = null
          // an old or used link on a phone already paired with this Mac: just go in
          if (e instanceof ApiError && e.status === 400 && paired?.mac === p.mac) {
            history.replaceState(null, '', remembered() ?? '#/')
            st.route = parseRoute(location.hash)
            await start()
            if (st.phase === 'in') return say('This phone is already paired')
          }
          st.pairError = e instanceof MacGone ? 'Your Mac did not answer, or it does not know this phone app. On your Mac, check that Phone is on and shared and that Settings › App › Phone › Phone app address is this site, then scan a new code.' : e instanceof Error ? e.message : String(e)
          return
        }
        // an old or used link on a phone that is already paired: just go in
        const signedIn = e instanceof ApiError && e.status === 400 ? await api.me().then(() => true, () => false) : false
        if (signedIn) {
          history.replaceState(null, '', remembered() ?? '#/')
          st.route = parseRoute(location.hash)
          await start()
          say('This phone is already paired')
        } else st.pairError = e instanceof Error ? e.message : String(e)
      } finally {
        pairMac = null
        st.busy.delete('pair')
        render()
      }
    })()
  },
  pasteLink(text) {
    const frag = pastedPairHash(text, location.origin)
    if (!frag) {
      // RA8: a phone that is still paired can take the Mac's new address (its words, its link) instead
      const mac = HOSTED && paired ? macFromTyped(text, location.origin) : null
      if (mac) return void moveTo(mac)
      st.pasteError = paired ? 'Type the words your Mac shows under Paired phones, or paste its link.' : 'That is not a pairing link for this app. Copy the whole link from your Mac and paste it again.'
      return render()
    }
    st.pasteError = null
    st.drafts['pair:paste'] = ''
    location.hash = frag
  },
  retry() {
    void start()
  },
  forget() {
    forgetMac(store)
    paired = null
    live?.close()
    live = null
    st.outReason = 'unpaired'
    render()
  },
  draft(key, value) {
    st.drafts[key] = value
    // a draft that opens or closes something (Send back) redraws; typing does not
    if (key.endsWith(':open')) render()
    else updateDisabled()
  }
}

/** Enable a Send button as soon as there is text, without rebuilding the screen under the caret. */
function updateDisabled(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLTextAreaElement>('#main textarea[data-k]'))) {
    const btn = el.parentElement?.querySelector<HTMLButtonElement>('button.btn--primary')
    if (btn && !st.busy.size) btn.disabled = !el.value.trim()
  }
}

// ---------- render ----------

let stick = true
let deferred = false
function view(): View {
  return { companies: companies(), companyId: companyId(), tab: st.route.tab, online: st.online, error: st.error, toast: st.toast, busy: st.busy, drafts: st.drafts, picks: st.picks, now: st.now, needs: st.needs, chats: st.chats, room: st.room, session: st.session, replica: st.replica, agent: st.agent, openKind: st.route.open?.kind ?? null }
}
function screen(v: View): VNode {
  const r = st.route
  if (r.open?.kind === 'session') return renderSession(v, actions)
  if (r.open?.kind === 'agent') return renderAgent(v, actions)
  if (r.tab === 'needs') return renderNeeds(v, actions)
  if (r.tab === 'chats') return renderChats(v, actions)
  if (r.tab === 'room') return renderRoom(v, actions)
  return renderNow(v, actions)
}
function swap(el: HTMLElement, node: VNode | null): void {
  el.replaceChildren(...(node ? [mount(node, doc) as Node] : []))
}
function render(o: { live?: boolean } = {}): void {
  const main = $('main')
  const active = document.activeElement as HTMLElement | null
  // never rebuild a field under the caret for a live update: it waits until you leave the field
  if (o.live && active && main.contains(active) && active.matches('input, textarea, select')) {
    deferred = true
    return
  }
  deferred = false
  document.body.dataset.phase = st.phase
  if (st.phase === 'boot') return
  if (st.phase === 'pair') {
    swap($('hdr'), null)
    swap($('tabs'), null)
    const linkMac = pairOf(location.hash)?.mac ?? null
    // a link naming a different Mac than the one kept: say so before it replaces that pairing (a forged link)
    const replaces = HOSTED && paired && linkMac && paired.mac !== linkMac ? macHost(paired.mac) : null
    swap(main, renderPair({ name: st.drafts['pair:name'] ?? deviceName(navigator.userAgent), error: st.pairError, busy: st.busy.has('pair'), mac: macHost(linkMac) || null, replaces, browserTab: HOSTED && !STANDALONE }, actions))
    dock(null)
    return
  }
  if (st.phase === 'out') {
    swap($('hdr'), null)
    swap($('tabs'), null)
    swap(main, renderSignedOut({ reason: st.outReason, hosted: HOSTED, mac: macHost(paired?.mac) || null, error: st.error, standalone: STANDALONE, paste: st.drafts['pair:paste'] ?? '', pasteError: st.pasteError, busy: st.busy.has('move') }, actions))
    dock(null)
    return
  }
  const v = view()
  const chat = !!st.route.open || st.route.tab === 'room'
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120
  const y = window.scrollY
  const focusKey = active && main.contains(active) ? active.getAttribute('data-k') : null
  const sel = focusKey && active && 'selectionStart' in active ? [(active as HTMLTextAreaElement).selectionStart, (active as HTMLTextAreaElement).selectionEnd] : null
  swap($('hdr'), renderHeader(v, actions))
  swap(main, screen(v))
  swap($('tabs'), renderTabs(v, actions))
  for (const el of Array.from(main.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-k]'))) {
    const k = el.getAttribute('data-k')!
    if (st.drafts[k] !== undefined) el.value = st.drafts[k]!
  }
  if (focusKey) {
    const el = main.querySelector<HTMLTextAreaElement>(`[data-k="${CSS.escape(focusKey)}"]`)
    el?.focus()
    if (el && sel) el.setSelectionRange(sel[0] ?? 0, sel[1] ?? 0)
  }
  document.body.classList.toggle('is-chat', chat)
  dock(dockSpec())
  if (chat && (stick || atBottom)) {
    toBottom()
    if (st.session || st.agent || st.room) stick = false
  } else window.scrollTo(0, y)
  renderToast()
}
/** to the newest message, now and again once layout settles (fonts, the dock's height, the keyboard) */
function toBottom(): void {
  const go = (): void => {
    const el = document.scrollingElement ?? document.documentElement
    el.scrollTop = el.scrollHeight
  }
  go()
  requestAnimationFrame(go)
  setTimeout(go, 120)
}
function renderToast(): void {
  const t = $('toast')
  t.textContent = st.toast ?? ''
  t.classList.toggle('on', !!st.toast)
}
document.addEventListener('focusout', () => {
  if (deferred) setTimeout(() => deferred && !(document.activeElement as HTMLElement | null)?.matches('#main input, #main textarea') && render(), 0)
})

// ---------- the composer dock (built once per conversation, never under your thumbs) ----------

interface DockSpec {
  key: string
  placeholder: string
  stop: boolean
  label: string
  mentions: boolean
  /** it cannot take a message now: Send is off (the placeholder says why) */
  held?: boolean
}
function dockSpec(): DockSpec | null {
  const r = st.route
  if (r.open?.kind === 'session') {
    const s = st.session
    if (!s) return null
    const t = s.terminal
    // a terminal on the Mac: write any time it runs (it takes the message now or right after this step); while it
    // asks something the box stays, with the reason in it and Send off
    if (t && t.canType !== undefined) {
      const c = terminalComposer(t, s.who?.name ?? 'Claude')
      return c && { key: `session:${s.ref.id}`, placeholder: c.placeholder, stop: false, label: 'Send', mentions: false, held: c.held }
    }
    if (st.replica) return { key: `session:${s.ref.id}`, placeholder: `Message ${s.who?.name ?? 'Claude'}`, stop: st.replica.busy, label: st.replica.busy ? 'Queue' : 'Send', mentions: false }
    return t?.canReply ? { key: `reply:${s.ref.id}`, placeholder: 'Reply', stop: false, label: 'Send', mentions: false } : null
  }
  if (r.open?.kind === 'agent') return st.agent ? { key: `agent:${st.agent.ref.id}`, placeholder: `Message ${st.agent.who.name}`, stop: false, label: 'Send', mentions: false } : null
  if (r.tab === 'room' && st.room?.enabled && st.room.channelId) return { key: `room:${st.room.channelId}`, placeholder: `Message ${st.room.channels.find((c) => c.id === st.room!.channelId)?.label ?? ''}`, stop: false, label: 'Send', mentions: true }
  return null
}
let dockKey = ''
function dock(spec: DockSpec | null): void {
  const el = $('dock')
  const sig = spec ? JSON.stringify(spec) : ''
  document.body.classList.toggle('has-dock', !!spec)
  if (!spec) {
    if (dockKey) el.replaceChildren()
    dockKey = ''
    return
  }
  if (sig === dockKey) return
  const sameConversation = dockKey && JSON.parse(dockKey).key === spec.key
  const prev = el.querySelector('textarea')
  const hadFocus = prev && document.activeElement === prev
  dockKey = sig
  if (sameConversation && prev) {
    // only the buttons changed (working / your turn): keep the field and the keyboard
    el.querySelector('.dock__btns')?.replaceWith(dockButtons(spec))
    prev.placeholder = spec.placeholder
    prev.setAttribute('aria-label', spec.placeholder)
    return
  }
  const ta = document.createElement('textarea')
  ta.className = 'dock__inp'
  ta.rows = 1
  ta.placeholder = spec.placeholder
  ta.setAttribute('aria-label', spec.placeholder)
  ta.setAttribute('enterkeyhint', 'send')
  ta.value = st.drafts[`dock:${spec.key}`] ?? ''
  const strip = document.createElement('div')
  strip.className = 'mentions'
  const grow = (): void => {
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(140, ta.scrollHeight)}px`
  }
  ta.addEventListener('input', () => {
    st.drafts[`dock:${spec.key}`] = ta.value
    grow()
    if (spec.mentions) mentionStrip(ta, strip)
  })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
      e.preventDefault()
      void send(spec, ta)
    }
  })
  const box = document.createElement('div')
  box.className = 'dock__row'
  box.append(ta, dockButtons(spec))
  el.replaceChildren(strip, box)
  grow()
  if (hadFocus) ta.focus()
}
function dockButtons(spec: DockSpec): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'dock__btns'
  if (spec.stop) {
    const stop = document.createElement('button')
    stop.type = 'button'
    stop.className = 'btn btn--ghost'
    stop.textContent = 'Stop'
    stop.addEventListener('click', () => void stopChat())
    wrap.append(stop)
  }
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'btn btn--primary'
  go.textContent = spec.label
  go.disabled = !!spec.held
  // keep the keyboard up: a tap on Send never steals focus from the field
  go.addEventListener('pointerdown', (e) => e.preventDefault())
  go.addEventListener('click', () => void send(spec, $('dock').querySelector('textarea')!))
  wrap.append(go)
  return wrap
}
function mentionStrip(ta: HTMLTextAreaElement, strip: HTMLElement): void {
  const at = mentionAt(ta.value, ta.selectionStart ?? ta.value.length)
  const room = st.room
  const list = at && room ? mentionMatches(room.members, at.query, room.me) : []
  strip.replaceChildren(
    ...list.map((m) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chip'
      b.textContent = `@${m.handle}${m.role ? ` · ${m.role}` : m.kind === 'human' ? '' : ''}`
      b.addEventListener('pointerdown', (e) => e.preventDefault())
      b.addEventListener('click', () => {
        const caret = ta.selectionStart ?? ta.value.length
        const out = insertMention(ta.value, at!.start, caret, m.handle)
        ta.value = out.text
        ta.setSelectionRange(out.caret, out.caret)
        ta.dispatchEvent(new Event('input'))
        ta.focus()
      })
      return b
    })
  )
}
let sendingDock = false
async function send(spec: DockSpec, ta: HTMLTextAreaElement): Promise<void> {
  const text = ta.value.trim()
  // the Enter key keeps the spec the field was built with: ask again whether it is held now
  if (!text || sendingDock || spec.held || dockSpec()?.held) return
  sendingDock = true
  const r = st.route
  try {
    if (r.open?.kind === 'session' && spec.key.startsWith('session:')) {
      // an agent's ended chat reopens in a new session (same conversation): follow it there
      const out = await api.call<{ ok: boolean; sessionId?: string }>('sessionSend', { params: { ...cid(), sessionId: r.open.id }, body: { text } })
      if (out?.sessionId && out.sessionId !== r.open.id) go({ open: { kind: 'session', id: out.sessionId } })
      // a terminal shows the message once the agent takes it (its transcript), so say it went
      else if (st.session?.terminal) say(st.replica?.busy ? 'Sent. It reads it right after this step.' : 'Sent')
      else if (st.replica && !st.replica.snap.available) await loadSession(r.open.id)
    }
    else if (r.open?.kind === 'session') {
      await api.call('sessionReply', { params: { ...cid(), sessionId: r.open.id }, body: { text } })
      await loadSession(r.open.id)
    } else if (r.open?.kind === 'agent') {
      // the agent's own chat: it answers there (and files board tasks itself when the work needs one)
      const out = await api.call<{ sessionId?: string; agent: PhoneAgent }>('agentSend', { params: { ...cid(), agentId: r.open.id }, body: { text } })
      st.agent = out.agent
      if (out.sessionId) go({ open: { kind: 'session', id: out.sessionId } })
    } else if (st.room?.channelId) {
      const m = await api.call<PhoneRoomMessage>('roomPost', { params: cid(), body: { channelId: st.room.channelId, text } })
      if (st.room && !st.room.messages.some((x) => x.id === m.id)) st.room = { ...st.room, messages: [...st.room.messages, m] }
    }
    ta.value = ''
    st.drafts[`dock:${spec.key}`] = ''
    ta.dispatchEvent(new Event('input'))
    stick = true
    render()
  } catch (e) {
    fail(e)
  } finally {
    sendingDock = false
  }
}
async function stopChat(): Promise<void> {
  const r = st.route
  if (r.open?.kind !== 'session') return
  try {
    await api.call('sessionStop', { params: { ...cid(), sessionId: r.open.id }, body: {} })
  } catch (e) {
    fail(e)
  }
}

// ---------- boot ----------

async function start(): Promise<void> {
  st.error = null
  if (pairOf(location.hash)) {
    st.phase = 'pair'
    return render()
  }
  // RA8: the Mac's "new address" link (#move=…): a paired phone checks it and goes there; nothing else uses it
  const move = HOSTED ? parseMoveHash(location.hash) : null
  if (move) {
    history.replaceState(null, '', remembered() ?? '#/')
    st.route = parseRoute(location.hash)
    if (paired) return moveTo(move)
  }
  // hosted with no Mac kept: nothing to ask, show how to pair
  if (HOSTED && !paired) {
    st.phase = 'out'
    st.outReason = 'unpaired'
    return render()
  }
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    const last = remembered()
    if (last) {
      history.replaceState(null, '', last)
      st.route = parseRoute(last)
    }
  }
  try {
    await loadMe()
    st.phase = 'in'
    void resumeToken()
  } catch (e) {
    if (e instanceof NotPaired) return signedOut('unpaired')
    st.phase = 'out'
    st.outReason = e instanceof MacGone ? 'gone' : 'unpaired'
    if (!(e instanceof MacGone)) st.error = e instanceof Error ? e.message : String(e)
    return render()
  }
  live ??= openLive({
    url: liveUrl(HOSTED ? (paired?.mac ?? '') : '', location),
    token: () => (HOSTED ? (paired?.token ?? null) : null),
    onUnauthorized: () => signedOut('unpaired'),
    onMessage: onLive,
    onState: (on) => {
      st.online = on
      render({ live: true })
    },
    onReconnect: () => {
      pendingWhat = new Set(['companies', 'needs', 'now', 'chats'])
      // a chat may have missed ops while the socket was down
      if (st.route.open?.kind === 'session') void loadSession(st.route.open.id).then(() => render({ live: true }), () => undefined)
      if (st.route.tab === 'room' && !st.route.open) void loadRoom().then(() => render({ live: true }), () => undefined)
      void flushLive()
    }
  })
  await onRoute()
}

window.addEventListener('hashchange', () => {
  if (pairOf(location.hash)) {
    st.pairError = null
    st.phase = 'pair'
    return render()
  }
  if (HOSTED && parseMoveHash(location.hash)) return void start()
  void onRoute()
})
// ticking times ("4m") stay true without a refetch
setInterval(() => st.phase === 'in' && render({ live: true }), 30_000)
void start()
