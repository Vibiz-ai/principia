import type { MarketItem, MarketKind } from '@shared/marketplace'

export const MARKET_LABELS: Record<MarketKind, string> = { workflow: 'Workflow', skill: 'Skill', agent: 'Agent', script: 'Script' }
export const MARKET_FILTERS = [
  { value: 'all', label: 'Everything' }, { value: 'workflow', label: 'Workflows' },
  { value: 'skill', label: 'Skills' }, { value: 'agent', label: 'Agents' }, { value: 'script', label: 'Scripts' }
] as const
export const MARKET_CATEGORIES = [
  { value: 'all', label: 'All uses', tags: [] },
  { value: 'operations', label: 'Operations', tags: ['operations', 'meetings', 'planning'] },
  { value: 'marketing', label: 'Sales & marketing', tags: ['marketing', 'sales', 'customers'] },
  { value: 'research', label: 'Research & data', tags: ['research', 'data', 'scraping', 'api'] },
  { value: 'design', label: 'Design & content', tags: ['design', 'image', 'content'] },
  { value: 'coding', label: 'Engineering', tags: ['coding', 'tests', 'review'] }
] as const

export function matchesQuery(item: MarketItem, query: string): boolean {
  const haystack = [item.name, item.description, item.kind, item.author ?? '', ...(item.tags ?? []), ...(item.keys ?? [])].join(' ').toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word))
}

export function filterMarketItems(items: MarketItem[], query: string, kind: string, category: string, installed: boolean): MarketItem[] {
  const tags: readonly string[] = MARKET_CATEGORIES.find(c => c.value === category)?.tags ?? []
  return items.filter(item => (kind === 'all' || item.kind === kind) && (!installed || item.installed)
    && (!tags.length || item.tags?.some(tag => tags.includes(tag))) && matchesQuery(item, query))
}

export function marketIcon(item: MarketItem): string {
  if (item.kind === 'skill') return 'book'
  if (item.kind === 'agent') return 'agents'
  if (item.kind === 'script') return 'terminal'
  if (item.tags?.includes('image')) return 'artifacts'
  if (item.tags?.includes('coding')) return 'code'
  if (item.tags?.includes('meetings')) return 'chat'
  if (item.tags?.includes('research') || item.tags?.includes('scraping')) return 'search'
  return 'workflows'
}

export function marketRuntime(item: MarketItem): string {
  if (item.kind === 'skill' || item.kind === 'agent') return 'Claude Code'
  if (item.kind === 'script') return 'No agent needed'
  return item.adapters?.length ? `Agent workflow · also uses ${item.adapters.join(', ')}` : 'Your workspace agent'
}
