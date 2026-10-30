/**
 * CONNECTIONS.md §4.3: a PostHog dashboard with no key reads through the company's PostHog sign-in (its MCP
 * connection), whichever shape the server's SQL tool has; a saved key always wins; nothing is saved.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardFetchError, type HttpFn } from '../http'
import { mcpRows, signInSql } from '../providers/analytics'
import type { McpReader } from '../providers/types'
import { DashboardService, type DashboardKeyStore } from '../service'

const NOW = new Date('2026-10-23T12:00:00Z')
let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
})
afterEach(() => db.close())

const text = (v: unknown): { content: { type: string; text: string }[] } => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })
const raw = (t: string): { content: { type: string; text: string }[] } => ({ content: [{ type: 'text', text: t }] })
const busy = { isError: true, content: [{ type: 'text', text: 'Error: [execute-sql]: Tool failed: MaxToolTransientError: Queries are a little too busy right now.' }] }

/** The table text the live server answers with: a header, `|` between cells, all text, nulls as `(null)`. */
const table = (cols: string[], rows: unknown[][]): string => [cols, ...rows].map((r) => r.map((c) => (c === null ? '(null)' : String(c))).join('|')).join('\n')

/**
 * A fake PostHog MCP in the live server's formats (checked 2026-10-30): `call --json` gives JSON whose `results` is the
 * table text, and `execute-sql` on its own gives that text bare, like `call` without `--json`.
 */
function fakePosthog(shape: 'execute-sql' | 'exec'): McpReader & { calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const answer = (q: string): unknown[][] => {
    if (q === 'SELECT 1') return [[1]]
    if (q.includes('prev_views')) return [[900, 300, 600, 250]]
    if (q.includes('toDate(timestamp)')) return [['2026-10-20', 40, 120], ['2026-10-21', 45, 130]]
    if (q.includes('$pathname')) return [['/pricing', 200]]
    return [['google.com', 150]]
  }
  const columnsOf = (q: string): string[] => (q === 'SELECT 1' ? ['1'] : [...q.split(' FROM ')[0]!.matchAll(/ AS (\w+)/g)].map((m) => m[1]!))
  return {
    calls,
    tools: async () => (shape === 'exec' ? ['exec'] : ['execute-sql', 'insight-get']),
    call: async (tool, args) => {
      calls.push({ tool, args })
      if (tool === 'execute-sql') return raw(table(columnsOf(String(args.query)), answer(String(args.query))))
      const m = /^call --json execute-sql (.*)$/s.exec(String(args.command))
      if (!m) throw new Error('bad command')
      const { query } = JSON.parse(m[1]!) as { query: string }
      const results = table(columnsOf(query), answer(query))
      return text({ query: { kind: 'HogQLQuery', query }, results, __formatted_results_override: results })
    }
  }
}

const noKeys: DashboardKeyStore = { resolve: () => ({}), lookup: (names) => names.map((name) => ({ name, source: null, masked: null })), save: () => { throw new Error('nothing is saved') } }
const noHttp: HttpFn = async () => {
  throw new Error('no REST call through a sign-in')
}
const make = (mcp: McpReader | null, keys: DashboardKeyStore = noKeys, http: HttpFn = noHttp): DashboardService =>
  new DashboardService({ db, keys, enabled: () => true, companyExists: () => true, departmentCompany: () => 'co_acme', http, now: () => NOW, mcp: (_c, s) => (s === 'posthog' ? mcp : null) })

describe('PostHog dashboard through a sign-in', () => {
  for (const shape of ['execute-sql', 'exec'] as const)
    it(`installs with no key and no project id, and fetches (${shape})`, async () => {
      const mcp = fakePosthog(shape)
      const svc = make(mcp)
      const d = await svc.install({ companyId: 'co_acme', departmentId: null, kind: 'posthog', config: {}, keys: {} })
      expect(d.via).toBe('signIn')
      const after = await svc.refresh(d.id)
      expect(after.status.state).toBe('ok')
      expect(after.snapshot?.kpis.pageviews).toEqual({ value: 900, previous: 600 })
      expect(after.snapshot?.tables.pages?.[0]).toEqual({ page: '/pricing', views: 200 })
      expect(after.snapshot?.series.daily?.[1]?.points[1]).toEqual({ t: '2026-10-21', v: 130 })
      expect(mcp.calls[0]!.tool).toBe(shape)
    })

  it('without a key or a sign-in it still asks for the key, after the config check', async () => {
    const svc = make(null)
    await expect(svc.install({ companyId: 'co_acme', departmentId: null, kind: 'posthog', config: {}, keys: {} })).rejects.toThrow(/Project ID is required/)
    await expect(svc.install({ companyId: 'co_acme', departmentId: null, kind: 'posthog', config: { projectId: '1' }, keys: {} })).rejects.toThrow(/Add your Personal API key/)
  })

  it('a saved key wins over the sign-in (REST, not MCP)', async () => {
    const mcp = fakePosthog('execute-sql')
    const keyStore: DashboardKeyStore = { ...noKeys, resolve: () => ({ POSTHOG_PERSONAL_API_KEY: 'phx_test' }), lookup: (names) => names.map((name) => ({ name, source: 'company', masked: '••••' })) }
    let rest = 0
    const http: HttpFn = async () => {
      rest++
      return { status: 200, headers: {}, text: '{}' } as never
    }
    const svc = make(mcp, keyStore, http)
    expect(svc.viaSignIn('posthog', 'co_acme')).toBe(false)
    await svc.install({ companyId: 'co_acme', departmentId: null, kind: 'posthog', config: { projectId: '12' }, keys: {} }).catch(() => undefined)
    expect(rest).toBeGreaterThan(0)
    expect(mcp.calls).toHaveLength(0)
  })
})

describe('reading an MCP answer', () => {
  it('rows from structured content, JSON text, nested results or objects', () => {
    expect(mcpRows({ structuredContent: { results: [[1, 2]] } })).toEqual([[1, 2]])
    expect(mcpRows(text({ data: { results: [{ a: 1, b: 2 }] } }))).toEqual([[1, 2]])
    expect(mcpRows({ content: [{ type: 'text', text: 'Query result:\n{"results":[["x",3]]}' }] })).toEqual([['x', 3]])
  })
  it('rows from the table text, as JSON `results` or bare', () => {
    expect(mcpRows(text({ results: '1\n1' }))).toEqual([['1']])
    expect(mcpRows(raw('1\n1'))).toEqual([['1']])
    expect(mcpRows(text({ results: 'day|users\n2026-10-27|34527\n2026-10-28|52404' }))).toEqual([['2026-10-27', '34527'], ['2026-10-28', '52404']])
    expect(mcpRows(raw('page|views\n/pricing|200'))).toEqual([['/pricing', '200']])
  })
  it('a query with no rows is empty, not unreadable', () => {
    expect(mcpRows(text({ results: 'a|b' }))).toEqual([])
    expect(mcpRows(raw('a|b'))).toEqual([])
  })
  it('table text: nulls, empty cells, and a `|` or a line break inside a value', () => {
    expect(mcpRows(raw('page|views\n(null)|5\n|4'))).toEqual([[null, '5'], ['', '4']])
    expect(mcpRows(raw('page|views\n/a|b|c|5'))).toEqual([['/a|b|c', '5']])
    expect(mcpRows(raw('page|views|n\nline1\nline2|5|6\n/x|1|2'))).toEqual([['line1\nline2', '5', '6'], ['/x', '1', '2']])
  })
  it('a sentence or a table with a short last row is unreadable, not an empty result', () => {
    expect(() => mcpRows(raw('Something went wrong'))).toThrow(/can’t read/)
    expect(() => mcpRows(raw('Sorry about this\nplease try again'))).toThrow(/can’t read/)
    expect(() => mcpRows(text({ results: 'a|b\n1' }))).toThrow(/can’t read/)
  })
  it('a refused or unreadable answer is a plain error, never the vendor text', () => {
    expect(() => mcpRows({ isError: true, content: [{ type: 'text', text: 'secret stack trace' }] })).toThrow(DashboardFetchError)
    expect(() => mcpRows({ isError: true })).toThrow(/turned down the query/)
    expect(() => mcpRows(text({ nope: true }))).toThrow(/can’t read/)
  })
  it('a busy server is retried once, and says so if it stays busy', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const once: McpReader = { tools: async () => ['execute-sql'], call: async () => (++calls === 1 ? busy : raw('a\n1')) }
      const retried = signInSql(once, 'SELECT 1')
      await vi.runAllTimersAsync()
      await expect(retried).resolves.toEqual([['1']])
      expect(calls).toBe(2)
      const always: McpReader = { tools: async () => ['execute-sql'], call: async () => busy }
      const refused = expect(signInSql(always, 'SELECT 1')).rejects.toThrow(/busy right now/)
      await vi.runAllTimersAsync()
      await refused
    } finally {
      vi.useRealTimers()
    }
  })
  it('a server with no SQL tool says to add a key', async () => {
    await expect(signInSql({ tools: async () => ['insight-get'], call: async () => ({}) }, 'SELECT 1')).rejects.toThrow(/personal API key/)
  })
})
