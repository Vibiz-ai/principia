/**
 * FORUM.md §4.1.2: the Forum's localhost HTTP transport. `POST /v1/<tool>` with `Authorization: Bearer <step token>`
 * and the JSON arguments; `GET /v1/schema`. Bound to 127.0.0.1 on a free port. Browsers cannot reach it: any request
 * with an Origin header or a Host other than 127.0.0.1:<port> / localhost:<port> is refused. No Electron imports.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { forumSchema, isForumTool, type ForumTool } from './protocol'

export interface ForumHttpHandler {
  /** null = unknown or expired token */
  call(token: string, tool: ForumTool, args: unknown, signal: AbortSignal): Promise<{ status: number; text: string }> | null
}

const MAX_BODY = 64 * 1024

export class ForumHttpServer {
  private server: http.Server | null = null
  port = 0

  constructor(private readonly handler: ForumHttpHandler) {}

  get url(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  async start(port = 0): Promise<string> {
    if (this.server && this.port) return this.url!
    const server = http.createServer((req, res) => void this.handle(req, res))
    server.keepAliveTimeout = 5_000
    // forum_ask may wait up to 10 minutes for a human
    server.requestTimeout = 11 * 60_000
    server.headersTimeout = 30_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    // never keeps Principia alive on quit
    server.unref()
    this.server = server
    this.port = (server.address() as AddressInfo).port
    return this.url!
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    this.port = 0
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, text: string, type = 'text/plain; charset=utf-8') => {
      if (res.headersSent) return
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(text)
    }
    try {
      // no browser: an Origin header means a web page is calling; a foreign Host means DNS rebinding
      if (req.headers.origin) return send(403, 'Forbidden')
      const host = String(req.headers.host ?? '')
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return send(403, 'Forbidden')
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
      if (req.method === 'GET' && url.pathname === '/v1/schema') return send(200, JSON.stringify(forumSchema()), 'application/json')
      const m = /^\/v1\/([a-z_]+)$/.exec(url.pathname)
      if (req.method !== 'POST' || !m) return send(404, 'Not found. POST /v1/<tool> or GET /v1/schema')
      if (!isForumTool(m[1])) return send(404, `Unknown tool ${m[1]}`)
      const auth = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization ?? ''))
      if (!auth) return send(401, 'Missing Authorization: Bearer $PRINCIPIA_FORUM_TOKEN')
      const body = await readBody(req)
      let args: unknown = {}
      if (body.trim()) {
        try {
          args = JSON.parse(body)
        } catch {
          return send(400, 'Body is not JSON')
        }
      }
      const ac = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) ac.abort()
      })
      const p = this.handler.call(auth[1], m[1], args, ac.signal)
      if (!p) return send(401, 'Unknown or expired Forum token (it lives as long as the step)')
      const out = await p
      send(out.status, out.text)
    } catch (e) {
      send(e instanceof BodyTooLarge ? 413 : 500, e instanceof Error ? e.message.split('\n')[0] : 'Internal error')
    }
  }
}

class BodyTooLarge extends Error {}
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new BodyTooLarge('Body too large (max 64 KB)'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
