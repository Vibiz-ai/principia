/**
 * CONNECTIONS.md §3.7: every service's status per company (connections:list), loaded on first use and refetched only
 * for the company a `connections:changed` event names. Every connection slot reads from here, so connecting PostHog in
 * one place flips every other place within one event. Names, states and masked forms only: no key value ever.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { Id } from '@shared/types'
import type { Purpose, ServiceStatus } from '@shared/services'
import { hive } from '../lib/hive'

interface ConnState {
  /** companyId → its services (registry order); absent = not loaded */
  byCompany: Record<Id, ServiceStatus[]>
  /** null = not asked yet; false = main doesn't serve connections */
  available: boolean | null
}

let st: ConnState = { byCompany: {}, available: null }
const ls = new Set<() => void>()
const inflight = new Map<Id, Promise<void>>()
const wanted = new Set<Id>()
function set(p: Partial<ConnState>): void {
  st = { ...st, ...p }
  for (const l of ls) l()
}
export function getConnections(): ConnState {
  return st
}

export function loadConnections(companyId: Id): Promise<void> {
  wanted.add(companyId)
  const running = inflight.get(companyId)
  if (running) return running
  const p = hive.connections
    .list({ companyId })
    .then((list) => set({ byCompany: { ...st.byCompany, [companyId]: list }, available: true }))
    .catch(() => {
      if (st.available === null) set({ available: false })
    })
    .finally(() => inflight.delete(companyId))
  inflight.set(companyId, p)
  return p
}

let subscribed = false
function subscribe(): void {
  if (subscribed || typeof hive?.on !== 'function') return
  subscribed = true
  hive.on('connections:changed', ({ companyId }) => {
    for (const id of companyId ? [companyId] : [...wanted]) if (wanted.has(id)) void loadConnections(id)
  })
}

/** false once main answered that it doesn't serve connections (an older main): surfaces keep their old rows. */
export function useConnectionsAvailable(): boolean | null {
  return useSyncExternalStore(
    (l) => {
      ls.add(l)
      return () => ls.delete(l)
    },
    () => st.available
  )
}

/** One company's services (loads on first use, live after). */
export function useConnections(companyId: Id | null | undefined): ServiceStatus[] | null {
  const list = useSyncExternalStore(
    (l) => {
      ls.add(l)
      return () => ls.delete(l)
    },
    () => (companyId ? (st.byCompany[companyId] ?? null) : null)
  )
  useEffect(() => {
    subscribe()
    if (companyId && !st.byCompany[companyId]) void loadConnections(companyId)
  }, [companyId])
  return list
}

/** One service for one company, and whether it serves a purpose ("PostHog connected for dashboards?"). */
export function useConnection(companyId: Id | null | undefined, serviceId: string, purpose?: Purpose): { status: ServiceStatus | null; ok: boolean } {
  const list = useConnections(companyId)
  const status = list?.find((s) => s.serviceId === serviceId) ?? null
  const ok = !!status && status.state === 'connected' && (!purpose || !!status.purposes[purpose]?.ok)
  return { status, ok }
}

// ---------- the one connect sheet (CONNECTIONS.md §4.2) ----------

export interface ConnectRequest {
  companyId: Id
  serviceId: string
  /** what the founder was doing when they asked (orders the forms: a key first for a dashboard, a sign-in for tools) */
  purpose?: Purpose
  nonce: number
}
let sheet: ConnectRequest | null = null
const sheetLs = new Set<() => void>()
/** Opens the shared connect sheet over whatever is on screen (every slot, the palette, the desk). */
export function openConnect(companyId: Id, serviceId: string, purpose?: Purpose): void {
  sheet = { companyId, serviceId, ...(purpose ? { purpose } : {}), nonce: (sheet?.nonce ?? 0) + 1 }
  for (const l of sheetLs) l()
}
export function closeConnect(): void {
  sheet = null
  for (const l of sheetLs) l()
}
export function useConnectRequest(): ConnectRequest | null {
  return useSyncExternalStore(
    (l) => {
      sheetLs.add(l)
      return () => sheetLs.delete(l)
    },
    () => sheet
  )
}
