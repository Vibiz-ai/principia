/**
 * REMOTE.md: Phone, this Mac on your phone. The desktop IPC (remote:*), the Phone API routes and view shapes, and the
 * live socket messages. The phone app (src/cloud/phone) only knows these shapes, so the same app can later point at
 * Principia Cloud. TYPE-ONLY except small `as const` lists and pure helpers. No Node or DOM imports.
 */
import type { ChatDecision, ChatOp, ChatSnapshot } from './chat'

type Id = string
type V = void

export const REMOTE_CSRF_HEADER = 'x-principia-csrf'
export const REMOTE_COOKIE = 'pp_device'
/** RA2: a pairing code lives 5 minutes and works once */
export const REMOTE_PAIR_TTL_MS = 5 * 60_000
/** RA2: pairing tries per minute, across all callers */
export const REMOTE_PAIR_PER_MINUTE = 5
export const REMOTE_LIMITS = { name: 60, text: 8000, answer: 4000 } as const
/** RA2: a device token lives 90 days after its last use (each use pushes it out) */
export const REMOTE_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000
/** RA2: after a rotation the old token still works this long, so a lost answer never signs the phone out */
export const REMOTE_ROTATE_GRACE_MS = 2 * 60_000

/**
 * RA8: "Turn Phone on when Principia starts". null/undefined (never set): on once at least one phone is paired, else off.
 */
export function phoneAutoStartOn(setting: boolean | null | undefined, paired: number): boolean {
  return typeof setting === 'boolean' ? setting : paired > 0
}

// ---------- hosted mode (REMOTE.md RA6): the phone app on its own https site, talking to this Mac cross-origin ----------

/**
 * The official address of the hosted phone app (a static site: it holds no data, the Mac is the authority). Settings ›
 * App › Phone › "Phone app address" defaults to it. null until it is deployed: the pairing link then opens the Mac's own
 * page (same-origin mode).
 */
export const PHONE_SITE_URL: string | null = 'https://principia-phone.vibiz.dev'
/** the bearer scheme in hosted mode (Safari blocks third-party cookies, so no cookie crosses origins) */
export const REMOTE_AUTH_SCHEME = 'Bearer'
/** a socket from the hosted app must say who it is (`{ t: 'auth', token }`) within this long, or it is closed */
export const REMOTE_WS_AUTH_MS = 5_000

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/
/**
 * `https://x.example/any/path` -> `https://x.example`, or null. https only, except a loopback http address (a phone app
 * served on this Mac for testing). No credentials, no wildcard.
 */
export function siteOrigin(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.trim() || url.length > 2048) return null
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.username || u.password) return null
  // a plain host name (letters, digits, dots, dashes) or loopback: never a wildcard or anything odd
  if (!/^[a-z0-9.-]+$/.test(u.hostname) && !LOOPBACK.test(u.hostname)) return null
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.test(u.hostname))) return null
  return u.origin
}
/**
 * The setting -> the phone app origin the Mac links to and accepts (CORS, WebSocket Origin). Absent or null: the official
 * address; '' (the person cleared it): none, the Mac's own page only.
 */
export function phoneSiteOrigin(setting: string | null | undefined, official: string | null = PHONE_SITE_URL): string | null {
  if (setting === '') return null
  return siteOrigin(setting ?? official)
}
/**
 * The pairing link. Hosted: `<site>/#mac=<this Mac's address>&code=<one-time code>`. Same-origin: `<mac>/#pair=<code>`.
 * Both live in the fragment, so neither the code nor the Mac's address reaches a server log.
 */
export function pairLinkFor(o: { site: string | null; mac: string; code: string }): string {
  const mac = o.mac.replace(/\/+$/, '')
  return o.site ? `${o.site}/#mac=${encodeURIComponent(mac)}&code=${o.code}` : `${mac}/#pair=${o.code}`
}
/** A pairing fragment: `#mac=…&code=…` (hosted) or `#pair=…` (same-origin, mac null). */
export function parsePairHash(hash: string): { code: string; mac: string | null } | null {
  const q = new URLSearchParams(hash.replace(/^#\/?/, ''))
  const code = q.get('code') ?? q.get('pair')
  if (!code || !/^[0-9a-f]{32}$/.test(code)) return null
  if (!q.has('mac')) return q.has('pair') ? { code, mac: null } : null
  const mac = siteOrigin(q.get('mac'))
  return mac ? { code, mac } : null
}

// ---------- a new address for a paired phone (REMOTE.md RA8) ----------

/**
 * What the Mac signs to prove it is the Mac a paired phone knows, at the address the phone is calling. The key is the
 * SHA-256 (hex) of the phone's token: the Mac keeps only that, the phone can compute it, nobody else has it. The origin
 * binds the proof to the address the phone asked, so a look-alike address that relays to the real Mac gets a proof
 * the phone refuses (the real Mac signs its own address).
 */
export function helloMessage(origin: string, nonce: string): string {
  return `principia-hello-v1|${origin.replace(/\/+$/, '').toLowerCase()}|${nonce}`
}
export const HELLO_NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/
/** quick-tunnel words ("quiet-tree-forty-two") -> their https origin */
const TUNNEL_SUFFIX = '.trycloudflare.com'
/**
 * The link the Mac shows a paired phone after its address changed: `<site>/#move=<this Mac's address>`. It carries
 * no code and no secret: the phone only goes there after the Mac there proves it knows this phone (helloMessage).
 */
export function moveLinkFor(o: { site: string; mac: string }): string {
  return `${o.site}/#move=${encodeURIComponent(o.mac.replace(/\/+$/, ''))}`
}
/** `#move=<mac>` -> the Mac's origin, or null */
export function parseMoveHash(hash: string): string | null {
  const q = new URLSearchParams(hash.replace(/^#\/?/, ''))
  return q.has('move') ? siteOrigin(q.get('move')) : null
}
/** A quick tunnel's words, shown on the Mac to type on the phone: `https://quiet-tree.trycloudflare.com` -> `quiet-tree`. */
export function tunnelWords(url: string | null | undefined): string | null {
  const o = siteOrigin(url)
  if (!o) return null
  const host = new URL(o).hostname
  return host.endsWith(TUNNEL_SUFFIX) ? host.slice(0, -TUNNEL_SUFFIX.length) : null
}
/**
 * What the phone's "New address" field accepts: the move link of this site (or its `#move=…` part), a Mac address
 * (https), or the tunnel's words ("quiet tree forty two" / "quiet-tree-forty-two"). Returns the Mac's origin, or null.
 */
export function macFromTyped(text: string, siteOriginNow: string | null): string | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 2048) return null
  const i = t.indexOf('#')
  if (i >= 0) {
    if (i > 0) {
      try {
        if (new URL(t).origin !== siteOriginNow) return null
      } catch {
        return null
      }
    }
    return parseMoveHash(t.slice(i))
  }
  if (/^https?:\/\//i.test(t)) return siteOrigin(t)
  const words = t.toLowerCase().replace(/\.trycloudflare\.com\/?$/, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!/^[a-z0-9]+(-[a-z0-9]+){1,9}$/.test(words) || words.length > 63) return null
  return `https://${words}${TUNNEL_SUFFIX}`
}

// ---------- desktop (Settings › App › Phone) ----------

export interface RemoteDevice {
  id: Id
  name: string
  createdAt: string
  lastSeenAt: string | null
  /** live sockets of this device right now */
  online: boolean
}
export type RemoteTunnelState = 'off' | 'starting' | 'on' | 'error' | 'missing'
export interface RemoteState {
  enabled: boolean
  /** `http://127.0.0.1:<port>` while on */
  localUrl: string | null
  tunnel: { state: RemoteTunnelState; url: string | null; message: string | null }
  /** every paired phone (kept across restarts), whether Phone is on or off */
  devices: RemoteDevice[]
  /** RA8: Phone and its tunnel turn on by themselves when Principia starts (the setting, or its default) */
  autoStart?: boolean
}
export interface RemotePairLink {
  /** `<url>/#pair=<code>`: the code is in the fragment, never sent to a server log */
  link: string
  expiresAt: string
  /** the link goes through the tunnel (reachable from a phone), else it opens only on this Mac */
  public: boolean
  /** the hosted phone app this link opens (its origin), or null: the Mac's own page */
  site?: string | null
}

export interface RemoteInvokeMap {
  'remote:state': [V, RemoteState]
  'remote:setEnabled': [{ on: boolean }, RemoteState]
  'remote:tunnel': [{ on: boolean }, RemoteState]
  'remote:pairLink': [V, RemotePairLink]
  'remote:revoke': [{ id: Id }, RemoteState]
  /** RA2: every paired phone is signed out (each must pair again) */
  'remote:signOutAll': [V, RemoteState]
}
export const REMOTE_CHANNELS = ['remote:state', 'remote:setEnabled', 'remote:tunnel', 'remote:pairLink', 'remote:revoke', 'remote:signOutAll'] as const satisfies readonly (keyof RemoteInvokeMap)[]
export interface RemoteEventMap {
  'remote:changed': RemoteState
}
export const REMOTE_EVENTS = ['remote:changed'] as const satisfies readonly (keyof RemoteEventMap)[]

/** "Phone on · 1 device", "Phone on · no phone yet" (status bar, Settings). */
export function remoteStatusLine(s: Pick<RemoteState, 'enabled' | 'devices'> | null | undefined): string {
  if (!s?.enabled) return ''
  const n = s.devices.filter((d) => d.online).length
  return n ? `Phone on · ${n} device${n === 1 ? '' : 's'}` : 'Phone on'
}

// ---------- Phone API ----------

export const REMOTE_ROUTES = {
  pair: 'POST /api/pair',
  /** RA8: no token; the Mac proves it knows a paired phone at this address (helloMessage) */
  hello: 'POST /api/hello',
  /** RA2: the phone came back: a new token for the one it holds (the old one works for REMOTE_ROTATE_GRACE_MS) */
  resume: 'POST /api/resume',
  me: 'GET /api/me',
  signOut: 'POST /api/sign-out',
  now: 'GET /api/c/:companyId/now',
  pause: 'POST /api/c/:companyId/pause',
  needs: 'GET /api/c/:companyId/needs',
  answerAsk: 'POST /api/c/:companyId/asks/:askId/answer',
  approveTask: 'POST /api/c/:companyId/tasks/:taskId/approve',
  sendBackTask: 'POST /api/c/:companyId/tasks/:taskId/send-back',
  answerTask: 'POST /api/c/:companyId/tasks/:taskId/answer',
  /** RA3: the company's board, read only (Planned, Working, Needs you, Done in the last 7 days) */
  tasks: 'GET /api/c/:companyId/tasks',
  /** RA3: one task of the board, read only, with what the phone may do about it now (its Needs you entry) */
  task: 'GET /api/c/:companyId/tasks/:taskId',
  /** Not needed: the task is canceled and leaves Needs you (reopen it from the Board on the Mac) */
  cancelTask: 'POST /api/c/:companyId/tasks/:taskId/cancel',
  chats: 'GET /api/c/:companyId/chats',
  session: 'GET /api/c/:companyId/sessions/:sessionId',
  sessionSend: 'POST /api/c/:companyId/sessions/:sessionId/send',
  sessionStop: 'POST /api/c/:companyId/sessions/:sessionId/stop',
  sessionAnswer: 'POST /api/c/:companyId/sessions/:sessionId/answer',
  sessionReply: 'POST /api/c/:companyId/sessions/:sessionId/reply',
  /** an ended terminal session opens again on the Mac, same conversation; answers { sessionId } of the new one */
  sessionContinue: 'POST /api/c/:companyId/sessions/:sessionId/continue',
  agent: 'GET /api/c/:companyId/agents/:agentId',
  agentSend: 'POST /api/c/:companyId/agents/:agentId/send',
  room: 'GET /api/c/:companyId/room',
  roomPost: 'POST /api/c/:companyId/room/post',
  live: 'GET /api/live'
} as const
export type RemoteRouteName = keyof typeof REMOTE_ROUTES

export function remoteRoutePath(name: RemoteRouteName, params: Record<string, string> = {}): string {
  const path = REMOTE_ROUTES[name].split(' ')[1]!
  return path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
    const v = params[key]
    if (v === undefined) throw new Error(`remoteRoutePath(${name}): missing :${key}`)
    return encodeURIComponent(v)
  })
}
export function remoteRouteMethod(name: RemoteRouteName): 'GET' | 'POST' {
  return REMOTE_ROUTES[name].split(' ')[0] as 'GET' | 'POST'
}
/** The route a request matches, with its params (decoded), or null. */
export function matchRemoteRoute(method: string, pathname: string): { name: RemoteRouteName; params: Record<string, string> } | null {
  for (const [name, spec] of Object.entries(REMOTE_ROUTES) as [RemoteRouteName, string][]) {
    const [m, p] = spec.split(' ') as [string, string]
    if (m !== method) continue
    const keys: string[] = []
    const re = new RegExp(`^${p.replace(/:([a-zA-Z]+)/g, (_x, k: string) => (keys.push(k), '([^/]+)'))}$`)
    const hit = re.exec(pathname)
    if (!hit) continue
    const params: Record<string, string> = {}
    try {
      keys.forEach((k, i) => (params[k] = decodeURIComponent(hit[i + 1]!)))
    } catch {
      return null
    }
    return { name, params }
  }
  return null
}

export interface PhoneWho {
  /** persona name with personas on, else the role label */
  name: string
  role: string
  /** a persona name the phone has a line-art bust for, or null */
  bust: string | null
}
export type PhoneChatRef = { kind: 'session'; id: Id } | { kind: 'agent'; id: Id }

export interface PhoneCompany {
  id: Id
  name: string
  personal: boolean
  paused: boolean
  working: number
  needs: number
}
export interface PhoneMe {
  device: { id: Id; name: string }
  csrf: string
  /** where this API runs: this Mac now, the cloud later */
  host: 'mac' | 'cloud'
  companies: PhoneCompany[]
}

export interface PhoneWorking {
  key: string
  who: PhoneWho | null
  title: string
  /** the live activity sentence, the same one the desktop shows */
  activity: string | null
  startedAt: string
  open: PhoneChatRef | null
}
export interface PhoneDone {
  key: string
  title: string
  who: PhoneWho | null
  at: string
  /** 'review': finished, waiting for you */
  status: 'done' | 'review' | 'failed'
  summary: string | null
}
export interface PhoneNow {
  companyId: Id
  name: string
  paused: boolean
  /** AUTOPILOT.md §7: the company's Autopilot switch, read-only on the phone ('held' while paused). Absent on older Macs. */
  autopilot?: 'on' | 'off' | 'held'
  /** "Autopilot on · Ads watch": the switch and the autopilots on, in words. Absent on older Macs. */
  autopilotLabel?: string
  needs: number
  working: PhoneWorking[]
  done: PhoneDone[]
}

export interface PhoneAsk {
  id: Id
  title: string
  question: string | null
  detail: string | null
  who: PhoneWho | null
  /** never 'focus' (that needs the terminal) or 'allow_always' (a rule: Mac only) */
  options: { id: string; label: string; kind: 'allow' | 'allow_step' | 'deny' | 'choice' }[]
  /** a free-text answer is allowed (questions; a deny note) */
  text: boolean
  at: string
  open: PhoneChatRef | null
}
export interface PhoneTaskNeed {
  taskId: Id
  /** idea: a suggestion from Principia (taskId is the suggestion's id; decided on the Mac) */
  kind: 'review' | 'question' | 'stuck' | 'idea'
  title: string
  text: string
  who: PhoneWho | null
  agentId: Id | null
  at: string
  /** quick answers offered by the agent (questions) */
  options: string[]
}
export interface PhoneNeeds {
  companyId: Id
  count: number
  asks: PhoneAsk[]
  tasks: PhoneTaskNeed[]
}

/** The board on the phone (RA3, read only): which list a task is in. */
export type PhoneTaskColumn = 'planned' | 'working' | 'needs' | 'done'
export interface PhoneTaskRow {
  id: Id
  /** the board's short id ("ACME-12") */
  identifier: string
  title: string
  /** the board status (triage, backlog, todo, in_progress, in_review, blocked, done) */
  status: string
  column: PhoneTaskColumn
  who: PhoneWho | null
  agentId: Id | null
  /** working: what its agent does right now; needs: why it waits on you; planned: blocked by what */
  line: string | null
  /** 0 none … 1 urgent … 4 low (the board's priority) */
  priority: number
  at: string
}
export interface PhoneTasks {
  companyId: Id
  planned: PhoneTaskRow[]
  working: PhoneTaskRow[]
  needs: PhoneTaskRow[]
  /** done in the last 7 days, newest first (at most PHONE_TASKS_DONE) */
  done: PhoneTaskRow[]
  /** planned tasks left out of the list (beyond PHONE_TASKS_PLANNED) */
  more: number
}
export const PHONE_TASKS_PLANNED = 60
export const PHONE_TASKS_DONE = 30
export interface PhoneTaskDetail extends PhoneTaskRow {
  description: string
  /** the agent's report, when it sent one */
  summary: string | null
  doneNote: string | null
  createdAt: string
  updatedAt: string
  /** what the phone may do now: its Needs you entry (approve, send back, answer, not needed), else null */
  need: PhoneTaskNeed | null
}

export interface PhoneChatRow {
  key: string
  ref: PhoneChatRef
  title: string
  who: PhoneWho | null
  live: boolean
  at: string
  /** one line: what it is doing now, or what was said last */
  line: string | null
}
export interface PhoneChats {
  companyId: Id
  rows: PhoneChatRow[]
}

export interface PhoneSession {
  ref: PhoneChatRef & { kind: 'session' }
  title: string
  who: PhoneWho | null
  /**
   * the chat view: a chat session's own (stream-json), or a terminal session's transcript read as a chat (mode
   * 'terminal', live through the same numbered ops). null: nothing to show as a chat (a terminal with no transcript yet)
   */
  chat: ChatSnapshot | null
  /** a terminal session: its live line, and what the phone may do with it */
  terminal: PhoneTerminal | null
}
export interface PhoneTerminal {
  activity: string | null
  /** it finished and waits at its prompt */
  canReply: boolean
  ended: boolean
  /** a message can be typed into it now (running, nothing asked): it takes it at once or right after this step */
  canType?: boolean
  /** why it cannot take a message now, in plain words ("It is asking you something: answer it above") */
  held?: string | null
  /** where the conversation shown comes from: its transcript (chat), its screen (screen), or nothing yet */
  source?: 'transcript' | 'screen' | null
  /** the terminal's last lines, ANSI-stripped (source 'screen'; then live through { t: 'screen' }) */
  screen?: string | null
  /** what it asks right now (answered like Needs you) */
  asks?: PhoneAsk[]
  /** ended: Continue opens it again on the Mac, in the same conversation (sessionContinue) */
  canContinue?: boolean
}

export type PhoneThreadItem =
  | { kind: 'me'; id: string; at: string; text: string; taskId: string }
  | { kind: 'agent'; id: string; at: string; text: string; taskId: string; card: 'review' | 'ask' | 'blocked' | null }
  | { kind: 'task'; id: string; at: string; taskId: string; text: string }
  | { kind: 'note'; id: string; at: string; text: string; taskId: string }
export interface PhoneAgent {
  ref: PhoneChatRef & { kind: 'agent' }
  who: PhoneWho
  /** "Working on Spring menu", "Paused", "Free" */
  status: string
  items: PhoneThreadItem[]
  /** AGENT CHAT: the agent's own chat (newest, a running one first); the phone opens it like any chat, same chat model */
  chatSessionId?: Id | null
}

export interface PhoneRoomMember {
  id: Id
  handle: string
  name: string
  kind: 'human' | 'agent' | 'guest'
  role: string | null
}
export interface PhoneRoomMessage {
  id: Id
  seq: number
  channelId: Id
  threadId: Id | null
  authorId: Id
  kind: 'text' | 'ask' | 'proposal' | 'system'
  text: string
  at: string
}
export interface PhoneRoom {
  companyId: Id
  /** false: the Forum is off (it needs Companies and Departments) */
  enabled: boolean
  message: string | null
  me: Id | null
  channelId: Id | null
  channels: { id: Id; label: string }[]
  members: PhoneRoomMember[]
  messages: PhoneRoomMessage[]
  /** agents writing a reply in this channel right now ("Marcus is replying…") */
  answering?: string[]
}

// request bodies
export interface PhonePairRequest {
  code: string
  name: string
}
/** POST /api/pair: hosted mode (an allowed cross-origin caller) also gets the token, to send as a bearer */
export interface PhonePairResponse {
  device: { id: Id; name: string }
  token?: string
}
/** POST /api/hello */
export interface PhoneHelloRequest {
  device: Id
  nonce: string
}
export interface PhoneHelloResponse {
  /** hex HMAC-SHA256(key = sha256hex(token), helloMessage(the address called, nonce)) */
  proof: string
}
/** POST /api/resume: hosted mode gets the new token in the body; the Mac's own page gets a new cookie */
export interface PhoneResumeResponse {
  token?: string
  expiresAt: string
}
export interface PhoneAnswerRequest {
  optionId?: string
  text?: string
}
export interface PhoneTextRequest {
  text: string
}
/** RA3: no "always allow" from the phone */
export type PhoneChatDecision = Exclude<ChatDecision, { kind: 'allowAlways' }>
export interface PhoneSessionAnswer {
  requestId: string
  decision: PhoneChatDecision
}
export interface PhoneRoomPost {
  channelId: Id
  text: string
}

// ---------- live socket (/api/live) ----------

export type PhoneLiveView = 'now' | 'needs' | 'chats' | 'room' | 'companies'
export type PhoneClientMsg =
  | { t: 'sub'; companyId: Id; sessionId?: Id | null; channelId?: Id | null }
  | { t: 'ping' }
  /** hosted mode: the first message on the socket (the token never goes in the URL) */
  | { t: 'auth'; token: string }
export type PhoneServerMsg =
  | { t: 'hello' }
  | { t: 'pong' }
  /** something in these views changed: refetch the ones on screen (companyId null: any company) */
  | { t: 'changed'; companyId: Id | null; what: PhoneLiveView[] }
  /** chat ops of the subscribed session (the desktop's own chat:ops) */
  | { t: 'chat'; sessionId: Id; seq: number; ops: ChatOp[] }
  /** the subscribed terminal session's last lines (a terminal with no transcript to show as a chat) */
  | { t: 'screen'; sessionId: Id; text: string }
  /** a new message in the subscribed room channel */
  | { t: 'room'; message: PhoneRoomMessage }
  /** this device was revoked (or every phone signed out). 'off' is no longer sent: turning Phone off keeps phones paired */
  | { t: 'bye'; reason: 'off' | 'revoked' }
