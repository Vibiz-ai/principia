/**
 * The phone, straight to the cloud (docs/CLOUD-PHONE.md). This machine answers the same Phone API the Mac does
 * (src/shared/remote.ts, REMOTE.md), so the phone app (src/cloud/phone, served here at `/`) and the iPhone app work
 * against it with no Mac in between: `me` says `host: 'cloud'`, there is one "company" (your cloud), and its chats are
 * the ones this machine owns (phoneChats.ts).
 *
 * Auth: a phone is a cloud device (platform 'phone'). It pairs once with a one-time code from a link the Mac or the
 * console makes (POST /v1/phone-link), then sends its device token as a bearer; the live socket's first message
 * carries it (`{ t: 'auth', token }`), never the URL.
 */
import { createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { CHAT_IMAGE_TYPES, CHAT_IMAGE_BYTES, CHAT_IMAGE_MAX, type ChatDecision, type ChatImage, type ChatOp } from '../../shared/chat'
import { CLOUD_TOKEN_PREFIX } from '../../shared/cloud'
import {
  HELLO_NONCE_RE, helloMessage, matchRemoteRoute, PHONE_SHELL_PATH, PHONE_SITE_URL, REMOTE_WS_AUTH_MS,
  type PhoneAsk, type PhoneChats, type PhoneClientMsg, type PhoneMe, type PhoneNeeds, type PhoneNow, type PhoneRoom, type PhoneServerMsg, type PhoneSession, type PhoneTasks
} from '../../shared/remote'
import { authenticate, mintToken, sha256 } from './auth'
import type { Ctx } from './context'
import { newId } from './db'
import { ApiError } from './http'
import { CLOUD_CHAT_MODES, type PhoneChats as ChatService } from './phoneChats'
import type { PhoneTools } from './phoneTools'

/** the one company the phone sees on a cloud */
export const CLOUD_COMPANY = 'cloud'
const PHONE_CODE_TTL_MS = 10 * 60_000
const WHO = { name: 'Claude', role: 'Claude Code', bust: null }
const TEXT_MAX = 8000
/** images ride in the body: six of 5 MB in base64 */
const MAX_BODY = 48 * 1024 * 1024

export interface PhoneApiDeps {
  ctx: Ctx
  chats: ChatService
  /** the GitHub repositories the cloud's GitHub sign-in can reach (owner/name), newest push first */
  repos(): Promise<string[]>
  /** something changed that keeps a managed machine awake (activity.ts) */
  touched(): void
  /** a chat's folder: files, changes, the shell, previews (phoneTools.ts) */
  tools: PhoneTools
}

// ---------- pairing ----------

/** A link that pairs a phone with this cloud: `<cloud>/#mac=<cloud>&code=<32 hex>`, works once, for 10 minutes. */
export function mintPhoneLink(ctx: Ctx): { link: string; expiresAt: string } {
  const code = randomBytes(16).toString('hex')
  const now = ctx.now()
  const expiresAt = new Date(now.getTime() + PHONE_CODE_TTL_MS).toISOString()
  ctx.db.run('INSERT INTO pairing_codes (id, workspace_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', newId('pc_'), ctx.workspaceId, sha256(`phone:${code}`), now.toISOString(), expiresAt)
  const base = ctx.config.publicUrl.replace(/\/+$/, '')
  return { link: `${base}/#mac=${encodeURIComponent(base)}&code=${code}`, expiresAt }
}

function pairPhone(ctx: Ctx, b: { code?: unknown; name?: unknown }): { device: { id: string; name: string }; token: string } {
  const code = typeof b.code === 'string' && /^[0-9a-f]{32}$/.test(b.code) ? b.code : null
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : 'Phone'
  const now = ctx.now().toISOString()
  const used = code ? ctx.db.run('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', now, sha256(`phone:${code}`), now) : 0
  if (!used) throw new ApiError('unauthorized', 'That link has expired or was used already. Make a new one on your Mac: Cloud › Use on your phone.')
  const token = mintToken(CLOUD_TOKEN_PREFIX.device)
  const id = newId('dev_')
  ctx.db.run('INSERT INTO devices (id, workspace_id, name, platform, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, ctx.workspaceId, name, 'phone', sha256(token), now, now)
  ctx.audit({ kind: 'device', id, name }, 'device.pair', null, id, { platform: 'phone' })
  return { device: { id, name }, token }
}

/** a device token (from a header or the socket's first message) -> the device, or null */
export function deviceOf(ctx: Ctx, token: string | null): { id: string; name: string; platform: string } | null {
  if (!token) return null
  const p = authenticate(ctx, { headers: { authorization: `Bearer ${token}` } } as IncomingMessage)
  return p?.kind === 'device' ? { id: p.device.id, name: p.device.name, platform: p.device.platform } : null
}

/** a chat's folder, its shell and its previews: a paired phone only (never a Mac's token) */
const PHONE_ONLY = new Set(['sessionFiles', 'sessionFile', 'sessionChanges', 'sessionPorts', 'sessionPreview'])

// ---------- views ----------

function images(list: unknown): ChatImage[] {
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new ApiError('bad_request', 'images must be a list.')
  if (list.length > CHAT_IMAGE_MAX) throw new ApiError('bad_request', `Up to ${CHAT_IMAGE_MAX} images per message`)
  return list.map((im: { mime?: unknown; data?: unknown; thumb?: unknown }) => {
    const mediaType = CHAT_IMAGE_TYPES.find((t) => t === im?.mime)
    if (!mediaType || typeof im.data !== 'string') throw new ApiError('bad_request', 'Use a PNG, JPEG, GIF or WebP image')
    if (Math.floor((im.data.length * 3) / 4) > CHAT_IMAGE_BYTES) throw new ApiError('bad_request', 'An image is too large.')
    return { mediaType, data: im.data, ...(typeof im.thumb === 'string' ? { thumb: im.thumb } : {}) }
  })
}

function text(v: unknown, required = true): string {
  const t = typeof v === 'string' ? v.trim() : ''
  if (required && !t) throw new ApiError('bad_request', 'Write something first')
  if (t.length > TEXT_MAX) throw new ApiError('bad_request', `Keep it under ${TEXT_MAX} characters`)
  return t
}

const askId = (chat: string, req: string): string => `${chat}~${req}`

export function needsOf(chats: ChatService): PhoneNeeds {
  const asks: PhoneAsk[] = chats.asks().map(({ chat, item }) => {
    const base = { id: askId(chat.id, item.requestId), title: chat.title, who: WHO, at: chat.updatedAt, open: { kind: 'session' as const, id: chat.id } }
    if (item.kind === 'permission') {
      return { ...base, heading: `${item.tool}?`, question: item.description, detail: JSON.stringify(item.input).slice(0, 600), options: [{ id: 'allow', label: 'Allow', kind: 'allow' as const }, { id: 'deny', label: 'Deny', kind: 'deny' as const }], text: true }
    }
    if (item.kind === 'plan') return { ...base, heading: 'Approve the plan?', question: null, detail: item.plan.slice(0, 1200), options: [{ id: 'approve', label: 'Approve', kind: 'allow' as const }, { id: 'reject', label: 'Not yet', kind: 'deny' as const }], text: true }
    // a question: answered in the chat itself (its choices live there)
    return { ...base, heading: 'Claude has a question', question: item.questions.map((q) => q.question).join('\n'), detail: null, options: [], text: false }
  })
  return { companyId: CLOUD_COMPANY, count: asks.length, asks, tasks: [] }
}

function decisionFor(kind: string, b: { optionId?: unknown; text?: unknown }): ChatDecision {
  const note = typeof b.text === 'string' && b.text.trim() ? b.text.trim().slice(0, 4000) : undefined
  if (kind === 'plan') return b.optionId === 'approve' ? { kind: 'approvePlan' } : { kind: 'rejectPlan', ...(note ? { message: note } : {}) }
  if (b.optionId === 'allow') return { kind: 'allow' }
  return { kind: 'deny', ...(note ? { message: note } : {}) }
}

export function createPhoneApi(d: PhoneApiDeps) {
  const { ctx, chats } = d
  const paused = (): boolean => ctx.workspace().paused

  const company = () => {
    const rows = chats.list()
    return { id: CLOUD_COMPANY, name: 'Your cloud', personal: true, paused: paused(), working: rows.filter((r) => r.live).length, needs: chats.asks().length }
  }

  const nowView = (): PhoneNow => {
    const rows = chats.list()
    return {
      companyId: CLOUD_COMPANY,
      name: 'Your cloud',
      paused: paused(),
      needs: chats.asks().length,
      working: rows.filter((r) => r.live).map((r) => ({ key: `session:${r.id}`, who: WHO, title: r.title, activity: r.activity ?? (r.turn === 'needs' ? 'Needs you' : 'Working'), startedAt: r.updatedAt, open: { kind: 'session', id: r.id } })),
      done: rows.filter((r) => !r.live).slice(0, 15).map((r) => ({ key: `session:${r.id}`, title: r.title, who: WHO, at: r.updatedAt, status: 'done', summary: r.lastLine }))
    }
  }

  const chatsView = async (): Promise<PhoneChats & { repos: string[]; host: 'cloud' }> => {
    let repos: string[] = []
    try {
      repos = await d.repos()
    } catch (e) {
      ctx.log.warn('phone: could not list GitHub repositories', { error: (e as Error).message })
    }
    return {
      companyId: CLOUD_COMPANY,
      rows: chats.list().map((r) => ({ key: `session:${r.id}`, ref: { kind: 'session', id: r.id }, title: r.title, who: WHO, live: r.live, at: r.updatedAt, line: r.live ? (r.activity ?? 'Working') : (r.repo ? `${r.repo} · ` : '') + (r.lastLine ?? ''), cloud: true })),
      team: [],
      repos,
      host: 'cloud'
    }
  }

  const sessionView = (id: string): PhoneSession => {
    const r = chats.get(id)
    if (!r) throw new ApiError('not_found', 'That chat is not on your cloud.')
    return { ref: { kind: 'session', id }, title: r.repo ? `${r.title}` : r.title, who: WHO, chat: chats.snapshot(id), terminal: null, cloud: true }
  }

  const emptyTasks: PhoneTasks = { companyId: CLOUD_COMPANY, planned: [], working: [], needs: [], done: [], more: 0 }
  const noRoom: PhoneRoom = { companyId: CLOUD_COMPANY, enabled: false, message: 'The room is on your Mac. Your cloud runs chats.', me: null, channelId: null, channels: [], members: [], messages: [] }

  const wrap = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ApiError) throw e
      const status = (e as { status?: number }).status
      const code = (e as { code?: string }).code
      const msg = e instanceof Error ? e.message : String(e)
      if (status === 404 || code === 'not_found') throw new ApiError('not_found', msg)
      if (status === 400 || code === 'bad_request' || code === 'validation') throw new ApiError('bad_request', msg)
      if (status === 409 || code === 'conflict') throw new ApiError('conflict', msg)
      throw e
    }
  }

  /** One Phone API call; the device is already known (except pair and resume). */
  async function call(name: string, params: Record<string, string>, b: Record<string, unknown>, dev: { id: string; name: string; platform: string } | null, token: string | null): Promise<unknown> {
    if (name === 'pair') return pairPhone(ctx, b)
    if (name === 'hello') {
      // RA8: this cloud proves it knows the phone at this very address (the phone checks before it sends its token)
      const nonce = typeof b.nonce === 'string' && HELLO_NONCE_RE.test(b.nonce) ? b.nonce : null
      const row = typeof b.device === 'string' ? ctx.db.get<{ token_hash: string }>("SELECT token_hash FROM devices WHERE id = ? AND platform = 'phone' AND revoked_at IS NULL", b.device) : undefined
      if (!nonce) throw new ApiError('bad_request', 'nonce is required.')
      if (!row) throw new ApiError('not_found', 'This cloud does not know that phone.')
      return { proof: createHmac('sha256', row.token_hash).update(helloMessage(new URL(ctx.config.publicUrl).origin, nonce)).digest('hex') }
    }
    if (!dev) throw new ApiError('unauthorized', 'Pair this phone again.')
    if (PHONE_ONLY.has(name) && dev.platform !== 'phone') throw new ApiError('forbidden', 'This is for a paired phone.')
    if (params.companyId !== undefined && params.companyId !== CLOUD_COMPANY) throw new ApiError('not_found', 'There is one place on a cloud: your cloud.')
    switch (name) {
      case 'resume':
        // a cloud device token lasts until it is revoked: the same one comes back
        return { token: token ?? undefined, expiresAt: new Date(ctx.now().getTime() + 90 * 86_400_000).toISOString() }
      case 'me':
        return { device: dev, csrf: '', host: 'cloud', companies: [company()] } satisfies PhoneMe
      case 'signOut':
        ctx.db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', ctx.now().toISOString(), dev.id)
        revokedSockets(dev.id)
        return { ok: true }
      case 'now':
        return nowView()
      case 'needs':
        return needsOf(chats)
      case 'answerAsk': {
        const [chatId, requestId] = String(params.askId ?? '').split('~')
        const hit = chats.asks().find((a) => a.chat.id === chatId && a.item.requestId === requestId)
        if (!hit) throw new ApiError('conflict', 'Already answered')
        if (hit.item.kind === 'question') throw new ApiError('conflict', 'Answer it in the chat')
        await wrap(() => chats.answer(chatId!, requestId!, decisionFor(hit.item.kind, b)))
        d.touched()
        return needsOf(chats)
      }
      case 'tasks':
        return emptyTasks
      case 'chats':
        return chatsView()
      case 'newChat': {
        const repo = typeof b.repo === 'string' && b.repo ? b.repo : null
        const mode = typeof b.mode === 'string' && (CLOUD_CHAT_MODES as readonly string[]).includes(b.mode) ? b.mode : null
        const r = await wrap(() => chats.create({ text: text(b.text), images: images(b.images), repo, branch: typeof b.branch === 'string' ? b.branch : null, mode }))
        ctx.audit({ kind: 'device', id: dev.id, name: dev.name }, 'chat.start', null, r.id, { repo: r.repo })
        d.touched()
        return { sessionId: r.id }
      }
      case 'session':
        return wrap(() => sessionView(params.sessionId!))
      case 'sessionSend': {
        const imgs = images(b.images)
        await wrap(() => chats.send(params.sessionId!, text(b.text, !imgs.length), imgs))
        d.touched()
        return { ok: true }
      }
      case 'sessionStop':
        await wrap(() => chats.interrupt(params.sessionId!, b.sendNow === true))
        return { ok: true }
      case 'sessionAnswer': {
        const requestId = typeof b.requestId === 'string' ? b.requestId : ''
        const decision = b.decision as ChatDecision | undefined
        if (!requestId || !decision || typeof decision !== 'object' || decision.kind === 'allowAlways') throw new ApiError('bad_request', 'requestId and decision are required.')
        await wrap(() => chats.answer(params.sessionId!, requestId, decision))
        d.touched()
        return { ok: true }
      }
      case 'sessionFiles':
        return d.tools.files(params.sessionId!, params.path ?? '')
      case 'sessionFile':
        return d.tools.file(params.sessionId!, params.path ?? '')
      case 'sessionChanges':
        return d.tools.changes(params.sessionId!)
      case 'sessionPorts':
        return d.tools.ports(params.sessionId!)
      case 'sessionPreview': {
        const port = typeof b.port === 'number' ? b.port : Number(b.port)
        const out = d.tools.previewLink(dev, params.sessionId!, port)
        ctx.audit({ kind: 'device', id: dev.id, name: dev.name }, 'chat.preview', null, params.sessionId!, { port })
        return out
      }
      case 'room':
        return noRoom
      case 'pause':
        throw new ApiError('conflict', 'Pause your cloud from your Mac.')
      default:
        throw new ApiError('not_found', 'This is on your Mac, not your cloud.')
    }
  }

  // ---------- HTTP ----------

  const allowed = (origin: string | undefined): string | null => {
    if (!origin) return null
    const self = (() => {
      try {
        return new URL(ctx.config.publicUrl).origin
      } catch {
        return null
      }
    })()
    if (origin === self) return origin
    // the hosted phone app (principia-phone.vibiz.dev) may call this cloud too
    try {
      if (PHONE_SITE_URL && origin === new URL(PHONE_SITE_URL).origin) return origin
    } catch {
      /* none */
    }
    return null
  }

  /** true when it was a Phone API request (handled here) */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/')) return false
    const origin = allowed(req.headers.origin)
    const cors: Record<string, string> = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' })
      res.end()
      return true
    }
    // every answer is redacted like the /v1 routes' (a secret Claude saw never reaches the phone), except the
    // phone's own new token (pair, resume)
    const send = (status: number, v: unknown, raw = false): void => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      const text = JSON.stringify(v ?? null)
      res.end(raw ? text : ctx.redact(text))
    }
    const m = matchRemoteRoute(req.method ?? 'GET', url.pathname)
    if (!m) {
      send(404, { message: 'Not found.' })
      return true
    }
    try {
      const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null
      const open = m.name === 'pair' || m.name === 'hello'
      const dev = open ? null : deviceOf(ctx, token)
      if (!dev && !open) {
        send(401, { message: 'Pair this phone again.' })
        return true
      }
      let b: Record<string, unknown> = {}
      // pair and hello are open: a small body only
      if (req.method === 'POST') b = await readBody(req, open ? 16 * 1024 : MAX_BODY)
      const query = Object.fromEntries(url.searchParams)
      const out = await call(m.name, { ...m.params, ...query }, b, dev, token)
      send(200, out, m.name === 'pair' || m.name === 'resume')
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500
      if (status === 500) ctx.log.warn('phone api: failed', { route: m.name, error: ctx.redact((e as Error).message) })
      send(status, { message: status === 500 ? 'Something went wrong on your cloud.' : ctx.redact((e as Error).message) })
    }
    return true
  }

  // ---------- live socket (/api/live) ----------

  interface Sub { ws: WebSocket; device: string | null; sessionId: string | null; timer: NodeJS.Timeout | null; what: Set<string> }
  const subs = new Set<Sub>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const out = (s: Sub, m: PhoneServerMsg): void => {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(m))
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://cloud.local').pathname
    } catch {
      return false
    }
    // a preview's own sockets (a dev server's live reload): its token is in the path
    if (path.startsWith('/preview/')) {
      d.tools.previewUpgrade(req, socket, head)
      return true
    }
    if (path !== '/api/live' && path !== PHONE_SHELL_PATH) return false
    if (req.headers.origin && !allowed(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return true
    }
    if (path === PHONE_SHELL_PATH) {
      d.tools.shellUpgrade(req, socket, head)
      return true
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s: Sub = { ws, device: null, sessionId: null, timer: null, what: new Set() }
      const authWait = setTimeout(() => s.device || ws.close(4401, 'Who are you?'), REMOTE_WS_AUTH_MS)
      ws.on('error', () => undefined)
      ws.on('message', (raw) => {
        let msg: PhoneClientMsg
        try {
          msg = JSON.parse(String(raw)) as PhoneClientMsg
        } catch {
          return
        }
        if (!s.device) {
          const dev = msg.t === 'auth' ? deviceOf(ctx, msg.token) : null
          if (!dev) return ws.close(4401, 'Pair this phone again.')
          clearTimeout(authWait)
          s.device = dev.id
          subs.add(s)
          return out(s, { t: 'hello' })
        }
        if (msg.t === 'ping') return out(s, { t: 'pong' })
        // revoked since (or signed out elsewhere): this socket ends
        if (!ctx.db.get('SELECT id FROM devices WHERE id = ? AND revoked_at IS NULL', s.device)) return ws.close(4401, 'revoked')
        if (msg.t === 'sub') {
          s.sessionId = msg.sessionId && chats.get(msg.sessionId) ? msg.sessionId : null
          return out(s, { t: 'subbed', sessionId: s.sessionId, seq: s.sessionId ? chats.snapshot(s.sessionId).seq : 0 })
        }
      })
      ws.on('close', () => {
        clearTimeout(authWait)
        if (s.timer) clearTimeout(s.timer)
        subs.delete(s)
      })
    })
    return true
  }

  function revokedSockets(deviceId: string): void {
    for (const s of subs) if (s.device === deviceId) { out(s, { t: 'bye', reason: 'revoked' }); s.ws.close(4401, 'revoked') }
    d.tools.revoked(deviceId)
  }

  return {
    handle,
    upgrade,
    /** numbered ops of a chat, to the sockets that follow it */
    chatOps(id: string, seq: number, ops: ChatOp[]): void {
      for (const s of subs) if (s.sessionId === id) out(s, { t: 'chat', sessionId: id, seq, ops })
    },
    /** the lists changed: each socket refetches what it shows (at most every 300 ms) */
    changed(): void {
      for (const s of subs) {
        if (s.timer) continue
        s.timer = setTimeout(() => {
          s.timer = null
          out(s, { t: 'changed', companyId: CLOUD_COMPANY, what: ['now', 'needs', 'chats', 'companies'] })
        }, 300)
        s.timer.unref?.()
      }
    },
    /** a revoked device's sockets close */
    revoked: (deviceId: string): void => revokedSockets(deviceId),
    close(): void {
      for (const s of subs) s.ws.terminate()
      wss.close()
    }
  }
}
export type PhoneApi = ReturnType<typeof createPhoneApi>

async function readBody(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > max) throw new ApiError('bad_request', 'That is too large to send.')
    chunks.push(c as Buffer)
  }
  if (!n) return {}
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    throw new ApiError('bad_request', 'The body is not JSON.')
  }
}

/** Upgrades the HTTP server for /api/live (alongside the chat attach sockets). */
export function attachPhoneSockets(server: Server, api: PhoneApi): () => void {
  const on = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    api.upgrade(req, socket, head)
  }
  server.on('upgrade', on)
  return () => server.off('upgrade', on)
}
