/**
 * CONNECTIONS.md §4.3: a PostHog dashboard with no key reads through the company's PostHog sign-in (its MCP
 * connection), whichever shape the server's SQL tool has; a saved key always wins; nothing is saved.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

/** A fake PostHog MCP: answers each HogQL query by its shape, as `execute-sql` or as the single `exec` tool. */
function fakePosthog(shape: 'execute-sql' | 'exec'): McpReader & { calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const answer = (q: string): unknown[][] => {
    if (q === 'SELECT 1') return [[1]]
    if (q.includes('prev_views')) return [[900, 300, 600, 250]]
    if (q.includes('toDate(timestamp)')) return [['2026-10-20', 40, 120], ['2026-10-21', 45, 130]]
    if (q.includes('$pathname')) return [['/pricing', 200]]
    return [['google.com', 150]]
  }
  return {
    calls,
    tools: async () => (shape === 'exec' ? ['exec'] : ['execute-sql', 'insight-get']),
    call: async (tool, args) => {
      calls.push({ tool, args })
      if (tool === 'execute-sql') return text({ columns: ['a', 'b'], results: answer(String(args.query)) })
      const m = /^call --json execute-sql (.*)$/s.exec(String(args.command))
      if (!m) throw new Error('bad command')
      return text({ result: { results: answer(JSON.parse(m[1]!).query) } })
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
  it('a refused or unreadable answer is a plain error, never the vendor text', () => {
    expect(() => mcpRows({ isError: true, content: [{ type: 'text', text: 'secret stack trace' }] })).toThrow(DashboardFetchError)
    expect(() => mcpRows({ isError: true })).toThrow(/turned down the query/)
    expect(() => mcpRows(text({ nope: true }))).toThrow(/can’t read/)
  })
  it('a server with no SQL tool says to add a key', async () => {
    await expect(signInSql({ tools: async () => ['insight-get'], call: async () => ({}) }, 'SELECT 1')).rejects.toThrow(/personal API key/)
  })
})
