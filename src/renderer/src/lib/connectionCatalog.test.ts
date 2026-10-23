import { describe, expect, it } from 'vitest'
import { VIBIZ_DEFAULT_CONNECTION, VIBIZ_MCP_URL } from '@shared/gateway'
import { CONNECTION_CATALOG, presetForUrl, searchConnections } from './connectionCatalog'
describe('connection catalog', () => {
  it('finds business tools by name, purpose, and category', () => {
    expect(searchConnections(' GRAnola ').map(p => p.id)).toEqual(['granola'])
    expect(searchConnections('meeting notes').map(p => p.id)).toEqual(['granola'])
    expect(searchConnections('payments').map(p => p.id)).toEqual(['stripe'])
    expect(searchConnections('database', 'Data').map(p => p.id)).toEqual(['supabase', 'neon'])
    expect(searchConnections('nonsense')).toEqual([])
  })
  it('keeps access tokens separate from URLs and flags unsupported sign-ins', () => {
    expect(new Set(CONNECTION_CATALOG.map(p => p.id)).size).toBe(CONNECTION_CATALOG.length)
    for (const p of CONNECTION_CATALOG) {
      expect(new URL(p.url).protocol).toBe('https:')
      expect(new URL(p.url).username).toBe('')
      expect(p.url).not.toMatch(/YOUR_|apiKey|token=/i)
      if (p.setupRequired) expect(p.note).toBeTruthy()
    }
    expect(presetForUrl('https://api.githubcopilot.com/mcp')?.auth).toBe('token')
    expect(presetForUrl('https://mcp.supabase.com/mcp?project_ref=example')?.id).toBe('supabase')
    expect(presetForUrl('https://mcp.granola.ai.attacker.test/mcp')).toBeUndefined()
    expect(presetForUrl('invalid')).toBeUndefined()
    expect(presetForUrl('https://mcp.asana.com/v2/mcp')?.setupRequired).toBe(true)
  })
  it('features Vibiz first, with browser sign-in at the endpoint the default connection uses', () => {
    const [first] = CONNECTION_CATALOG
    expect(first.id).toBe('vibiz')
    expect(first.featured).toBe(true)
    expect(CONNECTION_CATALOG.filter(p => p.featured).map(p => p.id)).toEqual(['vibiz'])
    expect(first.auth).toBe('oauth')
    expect(first.url).toBe(VIBIZ_MCP_URL)
    expect(VIBIZ_DEFAULT_CONNECTION).toMatchObject({ url: VIBIZ_MCP_URL, authentication: 'oauth', transport: 'http', enabled: true, scope: 'global' })
    expect(presetForUrl('https://www.vibiz.ai/api/mcp/')?.id).toBe('vibiz')
    expect(searchConnections('ad creatives').map(p => p.id)).toEqual(['vibiz'])
    expect(searchConnections('', 'All')[0].id).toBe('vibiz')
  })
})
