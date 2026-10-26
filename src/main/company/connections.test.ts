import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectionsReport, type ConnectionsInput } from './connectionsReport'
import { AuthorBroker, type BrokerDeps } from '../author/broker'
import { buildAuthorHandlers, listedHiveTools } from '../author/server/tools'
import { buildHandlers } from '../memory/server/build'
import { callTaskTool, CONNECTIONS_TOOL } from './taskToolDefs'
import { approxTokens } from './principiaOps'
import type { LiveOwner } from '../../shared/engine'

const CO = 'co_aaaaaaaaaaaaaaaaaaaa'
const base: ConnectionsInput = {
  companyId: CO,
  companyName: 'Northwind Coffee',
  accounts: { instagram: { handle: '@northwindcoffee', connectedAt: '2026-10-01T00:00:00Z' } } as ConnectionsInput['accounts'],
  gateway: [
    { id: 'c1', name: 'Notion', transport: 'http', url: 'https://mcp.notion.com/mcp', enabled: true, roots: [], scope: 'global', companyIds: [CO], authentication: 'oauth', authStatus: 'connected', hasCredentials: false },
    { id: 'c2', name: 'Stripe', transport: 'http', url: 'https://mcp.stripe.com', enabled: true, roots: [], scope: 'global', companyIds: [CO], authentication: 'oauth', authStatus: 'disconnected', hasCredentials: false },
    { id: 'c3', name: 'Their CRM', transport: 'http', url: 'https://crm.example.com/mcp', enabled: true, roots: [], scope: 'global', companyIds: [CO], authentication: 'none', hasCredentials: true },
    // another company's Sentry is never this company's
    { id: 'c4', name: 'Sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp', enabled: true, roots: [], scope: 'global', companyIds: ['co_other'], authentication: 'none', hasCredentials: true }
  ],
  slack: 'none',
  linear: false
}

describe('connections_list: what is connected, and the link for the rest', () => {
  it('lists connected tools and gives a principia://connect link for each missing one', () => {
    const r = connectionsReport(base)
    expect(r.where).toBe('Settings › Connections')
    expect(r.connected.map((c) => c.tool).sort()).toEqual(['instagram', 'mcp', 'notion'])
    expect(r.connected.find((c) => c.tool === 'mcp')?.name).toBe('Their CRM')
    const stripe = r.missing.find((c) => c.tool === 'stripe')!
    expect(stripe).toMatchObject({ status: 'needs_sign_in', link: `principia://connect/stripe?company=${CO}` })
    expect(r.missing.find((c) => c.tool === 'github')?.link).toBe(`principia://connect/github?company=${CO}`)
    expect(r.missing.find((c) => c.tool === 'sentry')?.status).toBe('not_connected')
    expect(r.missing.find((c) => c.tool === 'shopify')).toMatchObject({ status: 'coming_soon' })
    expect(r.missing.find((c) => c.tool === 'shopify')?.link).toBeUndefined()
    expect(r.addYourOwn.link).toBe(`principia://connect/mcp?company=${CO}`)
    expect(r.keys.link).toBe(`principia://settings/keys?company=${CO}`)
    expect(JSON.stringify(r)).not.toContain('co_other')
    // fits a tool result (8000 chars)
    expect(JSON.stringify(r).length).toBeLessThan(8000)
    expect(approxTokens(r.howToHelp)).toBeLessThan(80)
  })

  it('a business without code is not offered developer tools; the install-time Vibiz card is "not signed in yet", not "sign in again"', () => {
    const vibiz = { id: 'vibiz', name: 'Vibiz', transport: 'http' as const, url: 'https://www.vibiz.ai/api/mcp', enabled: true, roots: [], scope: 'global' as const, authentication: 'oauth' as const, authStatus: 'disconnected' as const, hasCredentials: false }
    const r = connectionsReport({ ...base, gateway: [...base.gateway, vibiz], code: false })
    const tools = [...r.connected, ...r.missing].map((c) => c.tool)
    for (const dev of ['github', 'sentry', 'supabase', 'neon', 'linear']) expect(tools).not.toContain(dev)
    expect(r.missing.find((c) => c.tool === 'vibiz')).toMatchObject({ status: 'not_connected', note: expect.stringMatching(/Not signed in yet/) })
    // asked by name, a developer tool still answers
    expect(connectionsReport({ ...base, code: false }, { tool: 'sentry' }).missing.map((c) => c.tool)).toEqual(['sentry'])
    expect(connectionsReport({ ...base, code: true }).missing.some((c) => c.tool === 'github')).toBe(true)
  })

  it('answers about one tool by id or name', () => {
    expect(connectionsReport(base, { tool: 'Stripe' }).missing.map((c) => c.tool)).toEqual(['stripe'])
    expect(connectionsReport(base, { tool: 'notion' }).connected.map((c) => c.tool)).toEqual(['notion'])
    expect(connectionsReport({ ...base, personal: true }).missing.find((c) => c.tool === 'instagram')).toBeUndefined()
  })

  it('the broker answers from the caller’s own company and refuses a line naming another', async () => {
    const seen: unknown[] = []
    const deps = {
      connections: {
        list: (owner: LiveOwner, args: Record<string, unknown>, hints: { companyId: string | null }) => {
          seen.push({ owner, args })
          if (hints.companyId && hints.companyId !== CO) throw new Error('This tool server belongs to another company. Restart the session.')
          return connectionsReport(base, typeof args.tool === 'string' ? { tool: args.tool } : {}) as unknown as Record<string, unknown>
        }
      }
    } as unknown as BrokerDeps
    const b = new AuthorBroker(deps)
    const ask = (owner: LiveOwner, line: Record<string, unknown>) => new Promise<{ ok: boolean; result?: { missing: { tool: string }[] }; error?: string }>((resolve) => b.handleCall(owner, { hive: 'author_call', call_id: 'hac_0000000001', tool: CONNECTIONS_TOOL, ...line }, (_id, p) => resolve(p as never)))
    const ok = await ask({ runId: 'r_1', stepId: 'st_1' }, { args: { tool: 'stripe' }, company_id: CO })
    expect(ok.ok).toBe(true)
    expect(ok.result?.missing.map((m) => m.tool)).toEqual(['stripe'])
    expect((await ask({ sessionId: 's_1' }, { args: {}, company_id: 'co_other' })).error).toContain('another company')
    // without the dependency the tool is unknown
    const none = new AuthorBroker({} as BrokerDeps)
    expect(await new Promise((r) => none.handleCall({ sessionId: 's_1' }, { hive: 'author_call', call_id: 'hac_0000000002', tool: CONNECTIONS_TOOL }, (_id, p) => r(p)))).toEqual({ ok: false, error: 'Unknown tool: connections_list' })
  })

  it('is listed on company sessions (hive) and task runs (hivemem), and the call goes through the mailbox', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-conn-'))
    try {
      expect(listedHiveTools({ HIVE_TOOLSETS: 'author', HIVE_COMPANY_ID: CO })).toContain(CONNECTIONS_TOOL)
      expect(listedHiveTools({ HIVE_TOOLSETS: 'author' })).not.toContain(CONNECTIONS_TOOL)
      const hive = buildAuthorHandlers({ HIVE_LIVE_DIR: dir, HIVE_TOOLSETS: 'author', HIVE_COMPANY_ID: CO })
      expect(hive.listTools().map((t) => t.name)).toContain(CONNECTIONS_TOOL)
      const text = typeof hive.instructions === 'function' ? hive.instructions() : hive.instructions
      expect(text).toContain('principia://connect/')
      const mem = buildHandlers({ HIVE_TASK_ID: 'task_x', HIVE_LIVE_DIR: dir }).handlers
      expect(mem.listTools().map((t) => t.name)).toContain(CONNECTIONS_TOOL)
      expect(buildHandlers({}).handlers.listTools().map((t) => t.name)).not.toContain(CONNECTIONS_TOOL)
      fs.writeFileSync(path.join(dir, 'events.jsonl'), '')
      const res = await callTaskTool(dir, CONNECTIONS_TOOL, { tool: 'stripe' }, {}, { companyId: CO }, async () => ({ ok: true, result: connectionsReport(base, { tool: 'stripe' }) }))
      expect(res.isError).toBeFalsy()
      expect(JSON.stringify(res.content)).toContain('principia://connect/stripe')
      const line = JSON.parse(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim())
      expect(line).toMatchObject({ hive: 'author_call', tool: CONNECTIONS_TOOL, company_id: CO })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
