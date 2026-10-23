/**
 * Open Passport, connected by default (CLOUD.md §7.1; Open Passport SPEC §11.2). Every cloud run of a company gets the
 * passport's L0 card (plus a department's L1 when asked) as `passportContext`, fetched from the workspace's host and
 * cached by revision; harvested `<passport-notes>` go back as `POST /notes` writes (proposals unless the runtime's
 * grant is trusted). The host being slow or down never blocks a run: 3 s, then the last card or nothing.
 */
import type { StepOutputEvent } from '../../shared/engine'
import type { PassportMaterial } from '../contract'
import { extractHarvestBlock, parseHarvestBlock, screenHarvest, type HarvestNote } from '../../main/memory/vault/suggest/harvest'

export const PASSPORT_TIMEOUT_MS = 3_000

type Fetch = typeof fetch

interface CardEntry { revision: number | null; text: string }

export interface PassportClientOptions {
  fetch?: Fetch
  timeoutMs?: number
  log?: { warn(msg: string, meta?: Record<string, unknown>): void }
}

const base = (p: PassportMaterial): string => `${p.internalUrl.replace(/\/+$/, '')}/v1/passports/${encodeURIComponent(p.passportId)}`
const headers = (p: PassportMaterial, extra: Record<string, string> = {}): Record<string, string> => ({ authorization: `Bearer ${p.token}`, ...extra })

export class PassportClient {
  private readonly cards = new Map<string, CardEntry>()
  private readonly fetch: Fetch
  private readonly timeoutMs: number

  constructor(private readonly o: PassportClientOptions = {}) {
    this.fetch = o.fetch ?? fetch
    this.timeoutMs = o.timeoutMs ?? PASSPORT_TIMEOUT_MS
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    return this.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) })
  }

  /**
   * The framed L0 card (+ the department's L1). Cached by revision: one small JSON read per run, and the markdown is
   * fetched again only when the revision moved. Timeout or error: the last card we had, else null.
   */
  async card(p: PassportMaterial, department: string | null = null): Promise<string | null> {
    const key = `${p.internalUrl}|${p.passportId}|${department ?? ''}`
    const cached = this.cards.get(key) ?? null
    try {
      const head = await this.call(`${base(p)}?format=json`, { headers: headers(p, { accept: 'application/json' }) })
      if (!head.ok) throw new Error(`passport host answered ${head.status}`)
      const summary = (await head.json()) as { revision?: unknown }
      const revision = typeof summary.revision === 'number' ? summary.revision : null
      if (cached && revision !== null && cached.revision === revision) return cached.text
      const q = department ? `?department=${encodeURIComponent(department)}` : ''
      const res = await this.call(`${base(p)}${q}`, { headers: headers(p, { accept: 'text/markdown' }) })
      if (!res.ok) throw new Error(`passport host answered ${res.status}`)
      const text = (await res.text()).trim()
      if (!text) return cached?.text ?? null
      this.cards.set(key, { revision, text })
      return text
    } catch (e) {
      this.o.log?.warn('passport: card unavailable; the run continues without a fresh one', { passportId: p.passportId, error: e instanceof Error ? e.message : String(e) })
      return cached?.text ?? null
    }
  }

  /** Last fetched card without a network call (EngineContext.passportContext is synchronous). */
  cached(p: PassportMaterial, department: string | null = null): string | null {
    return this.cards.get(`${p.internalUrl}|${p.passportId}|${department ?? ''}`)?.text ?? null
  }

  /** One `POST /notes` per harvested note (SPEC §11.2: the passport_write input). Returns the outcomes' statuses. */
  async writeNotes(p: PassportMaterial, notes: HarvestNote[]): Promise<string[]> {
    const out: string[] = []
    for (const n of notes) {
      const body = notesBody(n)
      try {
        const res = await this.call(`${base(p)}/notes`, { method: 'POST', headers: headers(p, { 'content-type': 'application/json' }), body: JSON.stringify(body) })
        const json = (await res.json().catch(() => ({}))) as { status?: string; error?: string }
        out.push(res.ok ? (json.status ?? 'ok') : `error ${res.status}`)
      } catch (e) {
        out.push(`error ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return out
  }
}

/** The passport_write input for one harvested note. Pure. */
export function notesBody(n: HarvestNote): { note: string; type?: string; facts: { category: string; text: string }[]; relations: { rel: string; to: string; context?: string }[] } {
  return {
    note: n.title,
    ...(n.type ? { type: n.type } : {}),
    facts: n.facts.map((f) => ({ category: f.category, text: f.text })),
    relations: n.relations.map((r) => ({ rel: r.rel, to: r.to, ...(r.context ? { context: r.context } : {}) }))
  }
}

/**
 * The notes a finished step leaves for the passport. Pure. Cloud steps have no local memory bridge, so the desktop's
 * `transport` rule does not apply: a passed agent step whose memory mode is read-write and whose answer carries a
 * block is harvested; every line is screened (secrets, credential shapes, injected imperatives) first.
 */
export function harvestNotes(e: Pick<StepOutputEvent, 'adapter' | 'memory' | 'status' | 'output'>): HarvestNote[] {
  if (e.adapter === 'shell' || e.status !== 'passed' || e.memory !== 'read-write') return []
  const block = extractHarvestBlock(e.output)
  if (!block) return []
  return screenHarvest(parseHarvestBlock(block), null).notes
}
