/**
 * BROWSER.md §3: the principia-browser transport. Each agent spawn gets its own token, bound to ONE company; the
 * stdio MCP bridge (out/main/mcp-browser.js) forwards tool calls to main's 127.0.0.1 endpoint with that token. The
 * token, never an argument, decides which company's browser a call reaches. No Electron import.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { BROWSER_SERVER_NAME, BROWSER_TOOLS, isBrowserTool, type BrowserActivity, type BrowserToolResult } from '../../shared/browser'
import type { McpServerSpec } from '../../shared/engine'
import { runBrowserTool, type CompanyBrowser } from './tools'

export interface BrowserBackend {
  forCompany(companyId: string): CompanyBrowser
  setActivity(companyId: string, a: BrowserActivity): void
}

export interface BrowserGrantRequest {
  companyId: string
  /** shown in the panel: "Claude", "Codex", "Ana (Sales)" */
  agent: string
  /** one chat or task run: the panel opens by itself once per key */
  sessionKey: string
}

interface Grant extends BrowserGrantRequest {
  expires: number
}

export interface BrowserServiceOptions {
  backend: BrowserBackend
  /** out/main/mcp-browser.js; null = no bridge (tests) */
  bridgeScript: string | null
  execPath?: string
  now?: () => number
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
  /** off = no attachment (Settings, or the bridge is missing) */
  enabled?: () => boolean
}

const GRANT_MS = 7 * 24 * 3600_000
const MAX_BODY = 256 * 1024

export class BrowserService {
  private grants = new Map<string, Grant>()
  private server: http.Server | null = null
  port = 0
  /** calls of one company run one at a time (two agents never interleave clicks) */
  private queues = new Map<string, Promise<unknown>>()

  constructor(private readonly o: BrowserServiceOptions) {}

  get url(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  private now(): number {
    return this.o.now?.() ?? Date.now()
  }

  /** A new token for one spawn of one company. */
  grant(req: BrowserGrantRequest): string {
    const token = crypto.randomBytes(24).toString('base64url')
    this.grants.set(token, { ...req, expires: this.now() + GRANT_MS })
    return token
  }

  revoke(token: string): void {
    this.grants.delete(token)
  }

  /** The grant behind a token (null = unknown or expired). */
  lookup(token: string): Grant | null {
    const g = this.grants.get(token)
    if (!g) return null
    if (g.expires < this.now()) {
      this.grants.delete(token)
      return null
    }
    g.expires = this.now() + GRANT_MS
    return g
  }

  /** The stdio MCP server spec for one claude / codex spawn, or null (no company, server not running, off). */
  attachment(req: BrowserGrantRequest): McpServerSpec | null {
    if (!req.companyId || !this.url || !this.o.bridgeScript || this.o.enabled?.() === false) return null
    const token = this.grant(req)
    return {
      name: BROWSER_SERVER_NAME,
      command: this.o.execPath ?? process.execPath,
      args: [this.o.bridgeScript],
      env: { ELECTRON_RUN_AS_NODE: '1', PRINCIPIA_BROWSER_URL: this.url, PRINCIPIA_BROWSER_TOKEN: token }
    }
  }

  toolNames(): string[] {
    return [...BROWSER_TOOLS]
  }

  /** One tool call with a token. null = unknown token. */
  call(token: string, tool: string, args: unknown): Promise<BrowserToolResult> | null {
    const g = this.lookup(token)
    if (!g) return null
    if (!isBrowserTool(tool)) return Promise.resolve({ content: [{ type: 'text', text: `Unknown tool ${tool}` }], isError: true })
    const b = this.o.backend.forCompany(g.companyId)
    const caller = {
      agent: g.agent,
      sessionKey: g.sessionKey,
      activity: (doing: string) => this.o.backend.setActivity(g.companyId, { agent: g.agent, doing, at: new Date(this.now()).toISOString(), sessionKey: g.sessionKey })
    }
    const prev = this.queues.get(g.companyId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(() => runBrowserTool(b, caller, tool, args))
    this.queues.set(g.companyId, next)
    void next.finally(() => {
      if (this.queues.get(g.companyId) === next) this.queues.delete(g.companyId)
    })
    return next
  }

  async start(port = 0): Promise<string> {
    if (this.server && this.port) return this.url!
    const server = http.createServer((req, res) => void this.handle(req, res))
    server.keepAliveTimeout = 5_000
    server.requestTimeout = 3 * 60_000
    server.headersTimeout = 30_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
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
    const send = (status: number, body: unknown): void => {
      if (res.headersSent) return
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(text)
    }
    try {
      // no web page may call in (Origin), and no other host name (DNS rebinding)
      if (req.headers.origin) return send(403, 'Forbidden')
      const host = String(req.headers.host ?? '')
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return send(403, 'Forbidden')
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
      if (req.method !== 'POST' || url.pathname !== '/v1/call') return send(404, 'Not found. POST /v1/call')
      const auth = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization ?? ''))
      if (!auth) return send(401, 'Missing Authorization: Bearer $PRINCIPIA_BROWSER_TOKEN')
      const body = await readBody(req)
      let parsed: { tool?: unknown; args?: unknown }
      try {
        parsed = JSON.parse(body || '{}') as { tool?: unknown; args?: unknown }
      } catch {
        return send(400, 'Body is not JSON')
      }
      const p = this.call(auth[1]!, String(parsed.tool ?? ''), parsed.args ?? {})
      if (!p) return send(401, 'Unknown or expired browser token')
      send(200, await p)
    } catch (e) {
      send(e instanceof BodyTooLarge ? 413 : 500, e instanceof Error ? e.message.split('\n')[0]! : 'Internal error')
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
        reject(new BodyTooLarge('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export const bridgeScriptPath = (mainDir: string): string => path.join(mainDir, 'mcp-browser.js')
