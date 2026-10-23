// Vendored from open-passport 0.1.0 (packages/js/src/core/mcpProtocol.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// A transport-free MCP message handler (SPEC.md §9.4, §11.6) for the stdio server and the reference host. Dual-era:
// modern requests (protocol 2026-07-28: per-request `_meta`, `server/discover`, no sessions, `resultType`) and legacy
// clients that open with `initialize` (2025-11-25 and earlier) are both served from the same tool surface.
import type { ToolResult, ToolSpec } from './tools'
import { toolCallResult } from './tools'

export const MODERN_VERSIONS = ['2026-07-28'] as const
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
export const SUPPORTED_VERSIONS: string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS]
export const META_VERSION = 'io.modelcontextprotocol/protocolVersion'

export interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export interface McpServerSpec {
  name: string
  version: string
  instructions: string
  tools(): ToolSpec[]
  /** runs a tool; throws ToolForbidden when the caller lacks the scope (hosts answer 403 insufficient_scope) */
  call(name: string, args: Record<string, unknown>): Promise<ToolResult> | ToolResult
}

export class ToolForbidden extends Error {
  readonly scope: string
  constructor(scope: string, message: string) {
    super(message)
    this.scope = scope
  }
}

export interface McpReply {
  /** HTTP status a Streamable HTTP transport should use (stdio ignores it) */
  status: number
  /** the JSON-RPC response, or null for an accepted notification */
  body: Record<string, unknown> | null
  /** the request used the initialize handshake (legacy era) */
  legacyInit?: boolean
  /** set when a tool call needs a scope the caller lacks */
  insufficientScope?: string
  /** the protocol version the request declared (modern) */
  modernVersion?: string
}

const rpcError = (id: JsonRpcMessage['id'], code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } })

/** The protocol version a modern request declares in `params._meta`, or null for legacy traffic. */
export function declaredVersion(msg: JsonRpcMessage): string | null {
  const meta = msg.params?._meta as Record<string, unknown> | undefined
  const v = meta?.[META_VERSION]
  return typeof v === 'string' ? v : null
}

export async function handleMcpMessage(spec: McpServerSpec, msg: JsonRpcMessage): Promise<McpReply> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') return { status: 400, body: rpcError(msg?.id ?? null, -32600, 'invalid request: send one JSON-RPC request per message') }
  const isNotification = msg.id === undefined
  if (isNotification) return { status: 202, body: null }
  const modern = declaredVersion(msg)
  if (modern !== null && !(MODERN_VERSIONS as readonly string[]).includes(modern)) {
    return { status: 400, body: rpcError(msg.id, -32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: modern }) }
  }
  const done = (result: Record<string, unknown>): McpReply => ({ status: 200, body: { jsonrpc: '2.0', id: msg.id, result: modern ? { resultType: 'complete', ...result } : result }, ...(modern ? { modernVersion: modern } : {}) })
  const capabilities = { tools: { listChanged: false } }
  const serverInfo = { name: spec.name, version: spec.version }
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '')
      const protocolVersion = (LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : LEGACY_VERSIONS[0]
      return { status: 200, body: { jsonrpc: '2.0', id: msg.id, result: { protocolVersion, capabilities, serverInfo, instructions: spec.instructions } }, legacyInit: true }
    }
    case 'server/discover':
      return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities, serverInfo, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }, instructions: spec.instructions })
    case 'ping':
      return done({})
    case 'tools/list':
      return done({ tools: spec.tools() })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}) as Record<string, unknown>
      try {
        const r = await spec.call(name, args)
        return done(toolCallResult(r))
      } catch (e) {
        if (e instanceof ToolForbidden) return { status: 403, body: rpcError(msg.id, -32001, e.message, { scope: e.scope }), insufficientScope: e.scope }
        return done(toolCallResult({ text: e instanceof Error ? e.message : String(e), isError: true }))
      }
    }
    default:
      return { status: modern ? 404 : 200, body: rpcError(msg.id, -32601, `method not found: ${msg.method}`) }
  }
}
