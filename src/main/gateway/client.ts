import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { GatewayConnection } from '../../shared/gateway'

/** One MCP upstream session. stdout is protocol only; stderr is deliberately not retained. */
export class Upstream {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>()
  private seq = 0
  private session: string | null = null
  private ready?: Promise<void>
  constructor(private config: GatewayConnection, private credentials: Record<string, string>, private baseEnv: Record<string, string>) {}
  async request(method: string, params: unknown = {}): Promise<any> {
    if (!this.ready) this.ready = this.initialize()
    await this.ready
    return this.rpc(method, params)
  }
  private async initialize(): Promise<void> {
    if (this.config.transport === 'stdio') {
      this.child = spawn(this.config.command!, this.config.args ?? [], { env: { ...this.baseEnv, ...this.credentials }, stdio: 'pipe' })
      this.child.stderr.resume()
      const fail = () => { for (const p of this.pending.values()) p.reject(new Error('MCP server disconnected')); this.pending.clear() }
      this.child.on('error', fail); this.child.on('exit', fail)
      const lines = createInterface({ input: this.child.stdout })
      lines.on('line', line => { if (line.length > 4 * 1024 * 1024) return; try { const m = JSON.parse(line); const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(new Error('MCP upstream request failed')) : p.resolve(m.result) } catch {} })
    }
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'principia', version: '1.0.0' } })
    await this.rpc('notifications/initialized', {}, true)
  }
  private async rpc(method: string, params: unknown, notification = false): Promise<any> {
    const id = ++this.seq
    const body = JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, params })
    if (this.child) {
      if (notification) { this.child.stdin.write(body + '\n'); return }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP request timed out')) }, 60_000)
        this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } })
        this.child!.stdin.write(body + '\n', e => { if (e) this.pending.get(id)?.reject(new Error('MCP write failed')) })
      })
    }
    const res = await fetch(this.config.url!, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { ...this.credentials, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) }, body })
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}; check connection authentication`)
    this.session = res.headers.get('mcp-session-id') ?? this.session
    if (notification || res.status === 202 || res.status === 204) { await res.body?.cancel(); return }
    let message: any
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = res.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; let size = 0
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4 * 1024 * 1024) throw new Error('MCP response too large'); buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n'); let end: number; while ((end = buffer.indexOf('\n\n')) >= 0) { const event = buffer.slice(0, end); buffer = buffer.slice(end + 2); const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'); if (data) { const candidate = JSON.parse(data); if (candidate.id === id) { message = candidate; break } } } if (message) break } } finally { await reader.cancel() }
    } else { const text = await res.text(); if (text.length > 4 * 1024 * 1024) throw new Error('MCP response too large'); message = JSON.parse(text) }
    if (!message || message.id !== id || message.error) throw new Error('MCP upstream request failed')
    return message.result
  }
  close(): void { this.child?.kill(); for (const p of this.pending.values()) p.reject(new Error('Connection closed')); this.pending.clear() }
}
