import { describe, expect, it } from 'vitest'
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
})
