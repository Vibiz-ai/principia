/**
 * Console events (docs/CLOUD.md §6): GET /v1/events over EventSource (same origin, the session cookie rides along).
 * `?runId=` adds `log` events for one run. EventSource reconnects by itself; `close()` stops it.
 */
import type { CloudEvent } from '../../shared/cloud'

const KINDS = ['run', 'step', 'log', 'ask', 'provider', 'workspace'] as const

export function openEvents(onEvent: (e: CloudEvent) => void, opts: { runId?: string; onOpen?: () => void; onError?: () => void; base?: string } = {}): { close(): void } {
  if (typeof EventSource === 'undefined') return { close: () => {} }
  const es = new EventSource(`${opts.base ?? ''}/v1/events${opts.runId ? `?runId=${encodeURIComponent(opts.runId)}` : ''}`)
  const handle = (ev: MessageEvent<string>): void => {
    try {
      const data = JSON.parse(ev.data) as CloudEvent
      onEvent({ ...data, kind: data.kind ?? (ev.type as CloudEvent['kind']) } as CloudEvent)
    } catch {
      /* not JSON */
    }
  }
  for (const k of KINDS) es.addEventListener(k, handle as EventListener)
  es.onmessage = handle
  es.onopen = () => opts.onOpen?.()
  es.onerror = () => opts.onError?.()
  return { close: () => es.close() }
}
