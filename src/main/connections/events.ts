/**
 * CONNECTIONS.md §3.7: `connections:changed`, coalesced over 150 ms per company. Every place that changes a key, a
 * gateway connection, an account, Slack, Linear or a connection choice calls `connectionsChanged`; the renderer's
 * connection store refetches only the companies named (null = all). Pure scheduling: the sender is injected so tests
 * and the cloud runner can use it without Electron.
 */
export type ChangedSender = (payload: { companyId: string | null; serviceId: string | null }) => void

const COALESCE_MS = 150
let sender: ChangedSender | null = null
let timer: NodeJS.Timeout | null = null
/** company id → service id (null = every service); the key `*` = every company */
let pending = new Map<string, string | null>()
const listeners = new Set<(companyId: string | null) => void>()

export function setConnectionsSender(fn: ChangedSender | null): void {
  sender = fn
}
/** Main-side listeners (the playbooks' "waiting for Stripe" check), called once per flush. */
export function onConnectionsChanged(fn: (companyId: string | null) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function connectionsChanged(companyId: string | null = null, serviceId: string | null = null): void {
  const k = companyId ?? '*'
  if (pending.has(k) && pending.get(k) !== serviceId) pending.set(k, null)
  else pending.set(k, serviceId)
  if (timer) return
  timer = setTimeout(flush, COALESCE_MS)
  timer.unref?.()
}

export function flush(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const batch = pending
  pending = new Map()
  const all = batch.has('*')
  const items: [string | null, string | null][] = all ? [[null, null]] : [...batch].map(([c, s]) => [c, s])
  for (const [companyId, serviceId] of items) {
    try {
      sender?.({ companyId, serviceId })
    } catch {
      /* the window may be gone */
    }
    for (const l of listeners) {
      try {
        l(companyId)
      } catch {
        /* a listener never stops the others */
      }
    }
  }
}
