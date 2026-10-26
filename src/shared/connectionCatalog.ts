import { VIBIZ_CONNECTION_ID, VIBIZ_MCP_URL } from './gateway'

/** Official server presets. Checked 2026-10-19; account/plan/admin policies still apply. */
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
export const CONNECTION_CATALOG: ConnectionPreset[] = [
  { id: VIBIZ_CONNECTION_ID, name: 'Vibiz', category: 'Marketing', description: 'Brand kit, ad creatives, campaigns, and analytics for your companies.', keywords: 'ads creatives marketing brand growth social campaigns analytics content', url: VIBIZ_MCP_URL, auth: 'oauth', docs: 'https://www.vibiz.ai/docs/mcp', featured: true, note: 'Sign in with your Vibiz account. Agents get the workspace you choose during sign-in.' },
  { id: 'granola', name: 'Granola', category: 'Knowledge', description: 'Meeting notes, decisions, and follow-ups.', keywords: 'meetings transcripts calls notes', url: 'https://mcp.granola.ai/mcp', auth: 'oauth', docs: 'https://docs.granola.ai/help-center/sharing/integrations/mcp', note: 'Sign in to Granola. Enterprise workspaces may require an admin to enable MCP.' },
  { id: 'notion', name: 'Notion', category: 'Knowledge', description: 'Company docs, wikis, and project knowledge.', keywords: 'documents wiki pages databases', url: 'https://mcp.notion.com/mcp', auth: 'oauth', docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp', note: 'Your workspace admin may restrict which MCP clients can connect.' },
  { id: 'linear', name: 'Linear', category: 'Projects', description: 'Issues, projects, roadmaps, and team updates.', keywords: 'tasks tickets engineering planning', url: 'https://mcp.linear.app/mcp', auth: 'oauth', docs: 'https://linear.app/docs/mcp' },
  { id: 'github', name: 'GitHub', category: 'Development', description: 'Repositories, pull requests, and issues.', keywords: 'code git engineering review', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', docs: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md', note: 'Use a GitHub personal access token with access to the repositories you need. This connects MCP tools; it does not sign in the git or gh commands.' },
  { id: 'stripe', name: 'Stripe', category: 'Finance', description: 'Payments, customers, and subscriptions.', keywords: 'billing invoices revenue money', url: 'https://mcp.stripe.com', auth: 'oauth', docs: 'https://docs.stripe.com/mcp' },
  { id: 'mobbin', name: 'Mobbin', category: 'Design', description: 'Design references and product inspiration.', keywords: 'screenshots ui ux patterns', url: 'https://api.mobbin.com/mcp', auth: 'oauth', docs: 'https://docs.mobbin.com/mcp/clients/overview' },
  { id: 'supabase', name: 'Supabase', category: 'Data', description: 'Postgres databases and app infrastructure.', keywords: 'sql storage backend database', url: 'https://mcp.supabase.com/mcp?read_only=true', auth: 'oauth', docs: 'https://supabase.com/docs/guides/ai-tools/mcp', note: 'Starts in read-only mode. You can add project_ref to the server URL to restrict it to one Supabase project.' },
  { id: 'neon', name: 'Neon', category: 'Data', description: 'Serverless Postgres projects and branches.', keywords: 'database sql backend', url: 'https://mcp.neon.tech/mcp', auth: 'oauth', docs: 'https://neon.com/docs/ai/connect-mcp-clients-to-neon' },
  { id: 'sentry', name: 'Sentry', category: 'Development', description: 'Errors, performance, and production issues.', keywords: 'monitoring bugs observability incidents', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth', docs: 'https://mcp.sentry.dev/' },
  { id: 'firecrawl', name: 'Firecrawl', category: 'Research', description: 'Turn websites into usable research and data.', keywords: 'scraping crawling web search extraction', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth', auth: 'oauth', docs: 'https://docs.firecrawl.dev/mcp-server/oauth' },
  { id: 'tavily', name: 'Tavily', category: 'Research', description: 'Search the web and extract source material.', keywords: 'research search scraping browsing', url: 'https://mcp.tavily.com/mcp/', auth: 'oauth', docs: 'https://docs.tavily.com/documentation/mcp' },
  { id: 'figma', name: 'Figma', category: 'Design', description: 'Design files, components, and UI context.', keywords: 'design ui ux mockups', url: 'https://mcp.figma.com/mcp', auth: 'oauth', docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/', setupRequired: true, note: 'Figma requires approval for new MCP clients. Principia is not yet an approved client. See Figma’s setup guide for supported clients and the local desktop server.' },
  { id: 'hubspot', name: 'HubSpot', category: 'Sales', description: 'CRM contacts, companies, and sales context.', keywords: 'crm pipeline marketing deals customers', url: 'https://mcp.hubspot.com', auth: 'oauth', docs: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server', setupRequired: true, note: 'HubSpot requires registered OAuth app credentials. Principia’s gateway currently supports automatic registration, so direct HubSpot sign-in is not available yet.' },
  { id: 'asana', name: 'Asana', category: 'Projects', description: 'Team tasks, projects, and work tracking.', keywords: 'tasks planning operations', url: 'https://mcp.asana.com/v2/mcp', auth: 'oauth', docs: 'https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server', setupRequired: true, note: 'Asana V2 requires a registered client ID and secret. Direct Asana sign-in needs registered-client support in Principia first.' },
]
export function searchConnections(query: string, category = 'All'): ConnectionPreset[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return CONNECTION_CATALOG.filter(item => (category === 'All' || item.category === category) && terms.every(term => `${item.name} ${item.description} ${item.keywords} ${item.category}`.toLowerCase().includes(term)))
}
export function presetForUrl(url: string): ConnectionPreset | undefined {
  try { const parsed = new URL(url); return CONNECTION_CATALOG.find(item => { const candidate = new URL(item.url); return parsed.origin === candidate.origin && parsed.pathname.replace(/\/$/, '') === candidate.pathname.replace(/\/$/, '') }) } catch { return undefined }
}
