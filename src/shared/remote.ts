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
  devices: RemoteDevice[]
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
}
export const REMOTE_CHANNELS = ['remote:state', 'remote:setEnabled', 'remote:tunnel', 'remote:pairLink', 'remote:revoke'] as const satisfies readonly (keyof RemoteInvokeMap)[]
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
  me: 'GET /api/me',
  signOut: 'POST /api/sign-out',
  now: 'GET /api/c/:companyId/now',
  pause: 'POST /api/c/:companyId/pause',
  needs: 'GET /api/c/:companyId/needs',
  answerAsk: 'POST /api/c/:companyId/asks/:askId/answer',
  approveTask: 'POST /api/c/:companyId/tasks/:taskId/approve',
  sendBackTask: 'POST /api/c/:companyId/tasks/:taskId/send-back',
  answerTask: 'POST /api/c/:companyId/tasks/:taskId/answer',
  /** Not needed: the task is canceled and leaves Needs you (reopen it from the Board on the Mac) */
  cancelTask: 'POST /api/c/:companyId/tasks/:taskId/cancel',
  chats: 'GET /api/c/:companyId/chats',
  session: 'GET /api/c/:companyId/sessions/:sessionId',
  sessionSend: 'POST /api/c/:companyId/sessions/:sessionId/send',
  sessionStop: 'POST /api/c/:companyId/sessions/:sessionId/stop',
  sessionAnswer: 'POST /api/c/:companyId/sessions/:sessionId/answer',
  sessionReply: 'POST /api/c/:companyId/sessions/:sessionId/reply',
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
  /** the chat view (stream-json): null when this session runs in a terminal */
  chat: ChatSnapshot | null
  /** a terminal session: its live line, and whether it waits for a reply */
  terminal: { activity: string | null; canReply: boolean; ended: boolean } | null
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
  /** a new message in the subscribed room channel */
  | { t: 'room'; message: PhoneRoomMessage }
  /** the Mac turned Phone off, or this device was revoked */
  | { t: 'bye'; reason: 'off' | 'revoked' }
