import { SERVICE_REGISTRY, mcpForm, serviceForUrl } from './services'

/**
 * The MCP presets (Settings › Connections cards with a sign-in), derived from the service registry (services.ts,
 * CONNECTIONS.md §2): every service with an MCP form, in registry order. Kept as its own shape so existing callers keep
 * working. Account/plan/admin policies still apply.
 */
export interface ConnectionPreset {
  id: string
  name: string
  category: string
  description: string
  keywords: string
  url: string
  auth: 'oauth' | 'token'
  docs: string
  note?: string
  setupRequired?: boolean
  /** Shown first and highlighted: Principia's own platform, added to every install by default. */
  featured?: boolean
}
export const CONNECTION_CATALOG: ConnectionPreset[] = SERVICE_REGISTRY.flatMap((s) => {
  const mcp = mcpForm(s)
  if (!mcp || s.soon) return []
  return [{
    id: s.id, name: s.name, category: s.category, description: s.blurb, keywords: s.keywords, url: mcp.url, auth: mcp.auth, docs: s.docs,
    ...(s.note ? { note: s.note } : {}), ...(mcp.setupRequired ? { setupRequired: true } : {}), ...(s.featured ? { featured: true } : {})
  }]
})
export function searchConnections(query: string, category = 'All'): ConnectionPreset[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return CONNECTION_CATALOG.filter(item => (category === 'All' || item.category === category) && terms.every(term => `${item.name} ${item.description} ${item.keywords} ${item.category}`.toLowerCase().includes(term)))
}
/** The preset of an MCP URL (origin and path match; a query string does not matter). */
export function presetForUrl(url: string): ConnectionPreset | undefined {
  const s = serviceForUrl(url)
  return s ? CONNECTION_CATALOG.find((p) => p.id === s.id) : undefined
}
