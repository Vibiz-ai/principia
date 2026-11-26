/**
 * Cloud chats on the control plane (docs/CLOUD-CHATS.md): the start request becomes the runtime's ChatProcSpec (the
 * Claude sign-in, the GitHub token and the shared keys come from this cloud, never from the request), and the attach
 * WebSocket carries the process's stdin and stdout for a paired Mac.
 *
 * Attach: `GET /v1/chats/:id/attach?from=<offset>` with the device token as a Bearer header. Every frame is JSON
 * (CloudChatDown / CloudChatUp in src/shared/cloud.ts). A Mac that reconnects with the offset it has seen gets the
 * rest and nothing twice.
 */
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CloudChatDown, CloudChatStart, CloudChatUp } from '../../shared/cloud'
import { PHONE_SHELL_PATH } from '../../shared/remote'
import type { ChatProcSpec, ProviderMaterial } from '../contract'
import { authenticate } from './auth'
import type { Ctx } from './context'
import { ApiError, badRequest } from './http'

export const CHAT_ID = /^[A-Za-z0-9_-]{1,80}$/
const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GITHUB_HTTPS = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?\/?$/
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/
const ATTACH = /^\/v1\/chats\/([A-Za-z0-9_-]{1,80})\/attach\/?$/
/** stdin frames can carry images (base64) in a user message: six of 5 MB is about 41 MB of base64 */
const MAX_FRAME = 48 * 1024 * 1024

export function chatStartSpec(id: string, b: Partial<CloudChatStart>, from: { provider: ProviderMaterial | null; githubToken: string | null; secrets: Record<string, string> }): ChatProcSpec {
  if (b.adapter !== undefined && b.adapter !== 'claude') throw badRequest('Only Claude chats run in the cloud for now.')
  if (typeof b.conversationId !== 'string' || !CONVERSATION.test(b.conversationId)) throw badRequest('conversationId must be a UUID.')
  if (!from.provider) throw new ApiError('conflict', 'Claude is not signed in on your cloud. Connect it on the Cloud page.')
  const repoUrl = typeof b.repoUrl === 'string' && b.repoUrl ? b.repoUrl.trim() : null
  if (repoUrl && !GITHUB_HTTPS.test(repoUrl)) throw badRequest('repoUrl must be a GitHub https address.')
  const branch = typeof b.branch === 'string' && b.branch ? b.branch : null
  if (branch && !BRANCH.test(branch)) throw badRequest('Invalid branch name.')
  const name = repoUrl ? repoUrl.replace(/\.git\/?$|\/$/g, '').split('/').pop()! : ''
  return {
    id,
    conversationId: b.conversationId,
    resume: b.resume === true,
    model: typeof b.model === 'string' ? b.model.slice(0, 80) : null,
    permissionMode: typeof b.permissionMode === 'string' ? b.permissionMode : null,
    bypass: b.bypass === true,
    systemPrompt: typeof b.systemPrompt === 'string' ? b.systemPrompt.slice(0, 64 * 1024) : null,
    repo: repoUrl ? { id: 'chat', name, url: repoUrl, branch, token: from.githubToken } : null,
    provider: from.provider,
    secrets: from.secrets,
    githubToken: from.githubToken
  }
}

export function attachChatSockets(server: Server, o: { ctx: Ctx; onInput(): void }): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://control.local')
    } catch {
      return refuse(socket, '400 Bad Request')
    }
    // the phone's live socket, its shell and a preview's sockets are phoneApi.ts's
    if (url.pathname === '/api/live' || url.pathname === PHONE_SHELL_PATH || url.pathname.startsWith('/preview/')) return
    const m = ATTACH.exec(url.pathname)
    if (!m) return refuse(socket, '404 Not Found')
    const who = authenticate(o.ctx, req)
    // a paired Mac only: the console (a cookie session) never drives a process
    if (!who || who.kind !== 'device') return refuse(socket, '401 Unauthorized')
    const id = m[1]!
    const from = Math.max(0, Number(url.searchParams.get('from') ?? 0) || 0)
    wss.handleUpgrade(req, socket, head, (ws) => follow(ws, id, from))
  }
  const follow = (ws: WebSocket, id: string, from: number): void => {
    const send = (f: CloudChatDown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f))
    }
    let detach: (() => void) | null = null
    try {
      detach = o.ctx.runtime.chats.attach(id, from, {
        out: (d, at) => send({ t: 'out', at, d }),
        err: (d) => send({ t: 'err', d }),
        state: (info) => send({ t: 'state', info })
      })
    } catch (e) {
      o.ctx.log.warn('cloud chat: attach failed', { id, error: (e as Error).message })
    }
    if (!detach) {
      ws.close(4404, 'No such chat')
      return
    }
    // a frame over the limit (or any socket failure) closes this socket, never the cloud
    ws.on('error', (e) => o.ctx.log.warn('cloud chat: socket error', { id, error: e.message }))
    ws.on('message', (raw) => {
      let f: CloudChatUp
      try {
        f = JSON.parse(String(raw)) as CloudChatUp
      } catch {
        return
      }
      if (f.t === 'in' && typeof f.d === 'string') {
        o.onInput()
        o.ctx.runtime.chats.write(id, f.d)
      } else if (f.t === 'end') o.ctx.runtime.chats.end(id)
      else if (f.t === 'signal' && (f.sig === 'SIGINT' || f.sig === 'SIGTERM' || f.sig === 'SIGKILL')) o.ctx.runtime.chats.signal(id, f.sig)
    })
    // keep NATs and proxies from closing a quiet chat
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25_000)
    ping.unref()
    ws.on('close', () => {
      clearInterval(ping)
      detach?.()
    })
  }
  server.on('upgrade', onUpgrade)
  return {
    close() {
      server.off('upgrade', onUpgrade)
      for (const c of wss.clients) c.terminate()
      wss.close()
    }
  }
}

function refuse(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
