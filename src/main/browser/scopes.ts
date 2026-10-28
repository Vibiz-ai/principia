/**
 * BROWSER.md §2: which chat or task owns each tab of a company's browser (pure, tested). An agent only sees, picks and
 * closes the tabs of its own scope; the panel shows the tabs of the chat or task on screen. Each scope keeps its own
 * active tab. No Electron import.
 */
import type { BrowserScope } from '../../shared/browser'

export interface ScopedTab {
  id: string
  scope: BrowserScope
  /** last time an agent or the founder used it (for evicting old tabs of finished chats) */
  used: number
  dead?: boolean
}

/** At most this many tabs per chat or task. */
export const MAX_SCOPE_TABS = 12
/** At most this many tabs in one company, all chats together: past it the oldest tab of a chat not on screen closes. */
export const MAX_COMPANY_TABS = 30

export class ScopedTabs<T extends ScopedTab> {
  private all: T[] = []
  private active = new Map<BrowserScope, string>()

  list(scope: BrowserScope): T[] {
    return this.all.filter((t) => t.scope === scope && !t.dead)
  }

  everything(): T[] {
    return [...this.all]
  }

  scopes(): BrowserScope[] {
    return [...new Set(this.all.map((t) => t.scope))]
  }

  /** The scope's tab with this id (never another scope's). */
  get(scope: BrowserScope, id: string): T | null {
    return this.all.find((t) => t.id === id && t.scope === scope && !t.dead) ?? null
  }

  /** The scope's active tab, else its newest. */
  activeOf(scope: BrowserScope): T | null {
    const id = this.active.get(scope)
    const mine = this.list(scope)
    return mine.find((t) => t.id === id) ?? mine[mine.length - 1] ?? null
  }

  activeId(scope: BrowserScope): string | null {
    return this.activeOf(scope)?.id ?? null
  }

  isActive(t: T): boolean {
    return this.activeId(t.scope) === t.id
  }

  /**
   * Room for one more tab in `scope`. Returns the tabs to close first (the oldest of other chats, never one of
   * `protect`), or throws when the scope is full.
   */
  makeRoom(scope: BrowserScope, protect: ReadonlySet<BrowserScope>, full: (max: number) => Error): T[] {
    if (this.list(scope).length >= MAX_SCOPE_TABS) throw full(MAX_SCOPE_TABS)
    const live = this.all.filter((t) => !t.dead)
    const over = live.length + 1 - MAX_COMPANY_TABS
    if (over <= 0) return []
    const evictable = live.filter((t) => t.scope !== scope && !protect.has(t.scope)).sort((a, b) => a.used - b.used)
    if (evictable.length < over) throw full(MAX_COMPANY_TABS)
    return evictable.slice(0, over)
  }

  add(t: T): void {
    this.all.push(t)
    this.active.set(t.scope, t.id)
  }

  select(t: T): void {
    this.active.set(t.scope, t.id)
  }

  remove(t: T): void {
    this.all = this.all.filter((x) => x !== t)
    if (this.active.get(t.scope) === t.id) {
      const next = this.list(t.scope)
      if (next.length) this.active.set(t.scope, next[next.length - 1]!.id)
      else this.active.delete(t.scope)
    }
  }

  clear(): void {
    this.all = []
    this.active.clear()
  }
}
