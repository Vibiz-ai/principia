/** A fake CDP target for driver tests: records commands, answers from handlers, emits events. */
import type { CdpTransport } from '../driver'

type Handler = (params: Record<string, unknown>) => unknown
export class FakeCdp implements CdpTransport {
  calls: { method: string; params: Record<string, unknown> }[] = []
  handlers = new Map<string, Handler>()
  private fns = new Set<(m: string, p: Record<string, unknown>) => void>()
  constructor() {
    this.on('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN' } } }))
  }
  on(method: string, h: Handler): this {
    this.handlers.set(method, h)
    return this
  }
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params })
    const h = this.handlers.get(method)
    return h ? await h(params) : {}
  }
  onEvent(fn: (m: string, p: Record<string, unknown>) => void): () => void {
    this.fns.add(fn)
    return () => void this.fns.delete(fn)
  }
  emit(method: string, params: Record<string, unknown> = {}): void {
    for (const f of this.fns) f(method, params)
  }
  methods(): string[] {
    return this.calls.map((c) => c.method)
  }
}
