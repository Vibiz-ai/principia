/**
 * Minimal MCP-over-stdio server (newline-delimited JSON-RPC 2.0), MEMORY.md §5. No runtime dependency.
 * Methods: initialize, notifications/initialized, ping, tools/list, tools/call. Unknown methods -> -32601.
 */
import type { ToolDef, ToolResult } from './tools'

export const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const DEFAULT_PROTOCOL = '2025-06-18'

export interface CallContext {
  /** JSON-RPC id of the tools/call request. */
  requestId: string | number | null
  /** params._meta of the request (claude: "claudecode/toolUseId"). */
  meta: Record<string, unknown> | null
  /** Aborted when the client sends notifications/cancelled for this request (LIVE.md A4c). */
  signal: AbortSignal
}

export interface McpHandlers {
  serverInfo: { name: string; version: string }
  instructions(): string
  listTools(): ToolDef[]
  /** May be async (ask_user blocks on the user's answer); the loop keeps answering ping meanwhile. */
  callTool(name: string, args: unknown, ctx?: CallContext): ToolResult | Promise<ToolResult>
}

type Json = Record<string, unknown>
interface Req {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Json
}

const ok = (id: Req['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
const err = (id: Req['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const errMsg = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] : 'Internal error')

/** Marker: the request was canceled by the client; send no response (MCP cancellation). */
const CANCELED = Symbol('canceled')

/** In-flight async tool calls by request id (for notifications/cancelled). */
export type Inflight = Map<string | number, AbortController>

/**
 * Core dispatcher. Returns the response, null (notification / canceled), or a Promise of it for async tool calls.
 */
export function dispatch(h: McpHandlers, msg: unknown, inflight: Inflight = new Map()): Json | null | Promise<Json | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return err(null, -32600, 'Invalid Request')
  const m = msg as Req
  const isNotification = m.id === undefined
  if (typeof m.method !== 'string') return isNotification ? null : err(m.id, -32600, 'Invalid Request')
  try {
    switch (m.method) {
      case 'initialize': {
        const asked = typeof m.params?.protocolVersion === 'string' ? (m.params.protocolVersion as string) : ''
        return ok(m.id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: h.serverInfo,
          instructions: h.instructions()
        })
      }
      case 'ping':
        return isNotification ? null : ok(m.id, {})
      // claude 2.1.x probes this before tools/list; answering {} is accepted (LIVE.md §4.2)
      case 'server/discover':
        return isNotification ? null : ok(m.id, {})
      case 'notifications/cancelled': {
        const rid = m.params?.requestId
        if (typeof rid === 'string' || typeof rid === 'number') inflight.get(rid)?.abort()
        return null
      }
      case 'tools/list':
        return ok(m.id, { tools: h.listTools() })
      case 'tools/call': {
        const name = m.params?.name
        if (typeof name !== 'string') return err(m.id, -32602, 'Missing tool name')
        const ac = new AbortController()
        const meta = m.params?._meta && typeof m.params._meta === 'object' ? (m.params._meta as Record<string, unknown>) : null
        const r = h.callTool(name, m.params?.arguments ?? {}, { requestId: m.id ?? null, meta, signal: ac.signal })
        if (!(r instanceof Promise)) return ok(m.id, r)
        const key = m.id
        if (key !== undefined && key !== null) inflight.set(key, ac)
        return r
          .then((res) => ok(m.id, res) as Json)
          .catch((e: unknown) => (ac.signal.aborted ? CANCELED : (err(m.id, -32603, errMsg(e)) as Json)))
          .then((res) => {
            if (key !== undefined && key !== null && inflight.get(key) === ac) inflight.delete(key)
            return res === CANCELED || isNotification ? null : (res as Json)
          })
      }
      default:
        if (m.method.startsWith('notifications/')) return null
        return isNotification ? null : err(m.id, -32601, `Method not found: ${m.method}`)
    }
  } catch (e) {
    return isNotification ? null : err(m.id, -32603, errMsg(e))
  }
}

/** Sync API (memory tools are sync). An async tool result here is an internal error. */
export function handleMessage(h: McpHandlers, msg: unknown): Json | null {
  const r = dispatch(h, msg)
  if (r instanceof Promise) {
    r.catch(() => undefined)
    return err((msg as Req)?.id, -32603, 'async tool result on the sync path')
  }
  return r
}

function parseLine(line: string): { ok: true; value: unknown } | { ok: false; out: string } | null {
  const t = line.trim()
  if (!t) return null
  try {
    return { ok: true, value: JSON.parse(t) }
  } catch {
    return { ok: false, out: JSON.stringify(err(null, -32700, 'Parse error')) }
  }
}

/** Handles one raw line (may be a JSON-RPC batch array). Returns the serialized response line or null. Sync tools only. */
export function handleLine(h: McpHandlers, line: string): string | null {
  const p = parseLine(line)
  if (!p) return null
  if (!p.ok) return p.out
  const parsed = p.value
  if (Array.isArray(parsed)) {
    const out = parsed.map((m) => handleMessage(h, m)).filter((r): r is Json => r !== null)
    return out.length ? JSON.stringify(out) : null
  }
  const r = handleMessage(h, parsed)
  return r ? JSON.stringify(r) : null
}

/** Async variant used by the stdio loop: async tool calls resolve later (responses may be out of order). */
export async function handleLineAsync(h: McpHandlers, line: string, inflight: Inflight): Promise<string | null> {
  const p = parseLine(line)
  if (!p) return null
  if (!p.ok) return p.out
  const parsed = p.value
  if (Array.isArray(parsed)) {
    const out = (await Promise.all(parsed.map((m) => dispatch(h, m, inflight)))).filter((r): r is Json => r !== null)
    return out.length ? JSON.stringify(out) : null
  }
  const r = await dispatch(h, parsed, inflight)
  return r ? JSON.stringify(r) : null
}

/** Wires stdin/stdout. Exits when stdin closes (the agent CLI owns the process). */
export function serveStdio(h: McpHandlers, io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; onClose: () => void }): void {
  let buf = ''
  const inflight: Inflight = new Map()
  const run = (line: string) => {
    handleLineAsync(h, line, inflight)
      .then((out) => {
        if (out) io.stdout.write(out + '\n')
      })
      .catch(() => undefined)
  }
  io.stdin.setEncoding?.('utf8')
  io.stdin.on('data', (chunk: string | Buffer) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      run(line)
    }
  })
  io.stdin.on('end', () => {
    if (buf.trim()) run(buf)
    // the client is gone: cancel pending asks (A4c) so Hive closes them, then exit
    for (const ac of inflight.values()) ac.abort()
    setTimeout(() => io.onClose(), inflight.size ? 200 : 0)
  })
}
