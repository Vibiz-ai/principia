import { useEffect, useRef, useState } from 'react'
import type { MarketItem, MarketList } from '@shared/marketplace'
import { Icon } from '../components/Icon'
import { InstallSheet } from '../components/MarketplaceSheet'
import { Button, EmptyState, ErrorState, Loading, Pill, Toolbar } from '../components/ui'
import { errorMessage, hive } from '../lib/hive'
import { filterMarketItems, MARKET_CATEGORIES, MARKET_FILTERS, MARKET_LABELS, marketIcon, marketRuntime } from '../lib/marketplace'
import { attempt, navigate } from '../state/store'
import { useScope } from '../components/CompanyChip'
import { keysForCompany } from '../lib/scope'
import { PERSONAL_COMPANY_ID } from '@shared/company'

const REPO = 'https://github.com/Vibiz-ai/principia'

export function MarketplaceView(): React.JSX.Element {
  const [list, setList] = useState<MarketList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [category, setCategory] = useState('all')
  const [installed, setInstalled] = useState(false)
  const [keys, setKeys] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<MarketItem | null>(null)
  const request = useRef(0)
  // COMPANY.md §4: "keys to connect" counts what the focused company's agents would get (Shared + its own)
  const { scope, nonce } = useScope()

  async function load(refresh = false): Promise<void> {
    const id = ++request.current
    setLoading(true)
    setError(null)
    try {
      const [catalog, secrets] = await Promise.all([hive.marketplace.list({ refresh }), hive.secrets.list(scope ? { companyId: scope } : undefined).catch(() => [])])
      if (id !== request.current) return
      setList(catalog)
      setKeys(new Set(keysForCompany(secrets, scope ?? PERSONAL_COMPANY_ID).map(secret => secret.name)))
    } catch (e) {
      if (id === request.current) setError(errorMessage(e))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    return () => { request.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])

  const shown = filterMarketItems(list?.items ?? [], query, kind, category, installed)
  const openLink = (url: string): void => { void attempt(() => hive.app.openExternal({ url }), 'Open link') }

  return <div className="view">
    <Toolbar title="Marketplace">
      <Button icon="refresh" disabled={loading} onClick={() => void load(true)}>Refresh</Button>
      <Button icon="plus" onClick={() => openLink(`${REPO}/issues/new?template=marketplace.yml`)}>Contribute</Button>
    </Toolbar>
    <div className="marketplace scroll">
      <header className="marketplace__intro">
        <div><span className="marketplace__eyebrow">THE PRINCIPIA LIBRARY</span>
          <h1>Give your company a new capability.</h1>
          <p>Reusable workflows, skills and agents for the work you do every day. Browse, inspect, then add them to your workspace.</p>
        </div>
        <div className="marketplace__guide"><Icon name="marketplace" size={26} /><span><strong>Built to be shared</strong><span>Use the starter catalog or connect a community library.</span></span></div>
      </header>
      <div className="marketplace__controls">
        <label className="marketplace__search"><Icon name="search" /><input type="search" aria-label="Search marketplace" placeholder="Try meeting notes, research, images…" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <label className="marketplace__category"><span className="text-secondary">Use case</span><select className="input" aria-label="Marketplace use case" value={category} onChange={e => setCategory(e.target.value)}>{MARKET_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
      </div>
      <div className="marketplace__filters">
        <div role="group" aria-label="Item type">{MARKET_FILTERS.map(f => <button type="button" key={f.value} aria-pressed={kind === f.value} onClick={() => setKind(f.value)}>{f.label}</button>)}</div>
        <label className="marketplace__installed"><input type="checkbox" checked={installed} onChange={e => setInstalled(e.target.checked)} /> Installed only</label>
      </div>
      {list?.remoteError && <div className="market__warn" role="status">Couldn’t load your community catalog: {list.remoteError}. The built-in library is still available.</div>}
      {error ? <ErrorState error={error} onRetry={() => void load(true)} /> : !list ? <Loading /> : <>
        <p className="marketplace__count" role="status">{shown.length} {shown.length === 1 ? 'capability' : 'capabilities'}{loading ? ' · Refreshing…' : ''} · Preview before adding</p>
        {!shown.length ? <EmptyState compact icon="search" text={installed ? 'No installed items match these filters.' : 'No capabilities match these filters.'}><Button onClick={() => { setQuery(''); setKind('all'); setCategory('all'); setInstalled(false) }}>Clear filters</Button></EmptyState> :
          <div className="marketplace__grid">{shown.map(item => <MarketCard key={`${item.source}/${item.id}`} item={item} keys={keys} onOpen={() => setOpen(item)} />)}</div>}
      </>}
      <aside className="marketplace__contribute">
        <div><h2>What does your company know how to do?</h2><p>Share a workflow or skill with the community. Contributions are reviewed through GitHub before joining the built-in library.</p></div>
        <div className="marketplace__links"><Button icon="external" onClick={() => openLink(`${REPO}/blob/main/resources/marketplace/README.md`)}>Contribution guide</Button><Button onClick={() => void navigate({ name: 'settings', section: 'data' })}>Add a catalog URL</Button></div>
      </aside>
      <p className="marketplace__footnote">{list?.remoteUrl ? 'Built-in + community catalog' : 'Built-in catalog'} · Workflows are added to your editor. Skills and subagents currently install for Claude Code.</p>
    </div>
    {open && <InstallSheet key={`${open.source}/${open.id}`} item={open} keys={keys} onBack={() => setOpen(null)} onClose={() => setOpen(null)} onInstalled={() => void load()} />}
  </div>
}

function MarketCard({ item, keys, onOpen }: { item: MarketItem; keys: Set<string>; onOpen: () => void }): React.JSX.Element {
  const missing = (item.keys ?? []).filter(key => !keys.has(key))
  return <button type="button" className="marketplace__card" onClick={onOpen} aria-label={`Preview ${item.name}`}>
    <span className="marketplace__card-top"><span className={`marketplace__icon marketplace__icon--${item.kind}`}><Icon name={marketIcon(item)} size={22} /></span><span className="marketplace__kind">{MARKET_LABELS[item.kind]}</span>{item.installed && <Pill tone="passed">Installed</Pill>}</span>
    <strong className="marketplace__name">{item.name}</strong>
    <span className="marketplace__description">{item.description}</span>
    <span className="marketplace__tags">{(item.tags ?? []).slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</span>
    <span className="marketplace__requirements">{marketRuntime(item)}{missing.length > 0 && <span className="text-warning" title={missing.join(', ')}> · {missing.length} {missing.length === 1 ? 'key to connect' : 'keys to connect'}</span>}</span>
    <span className="marketplace__card-bottom"><span>{item.author || (item.source === 'builtin' ? 'Principia' : 'Community')}{item.source === 'remote' ? ' · Community catalog' : ''}</span><span>Preview <Icon name="chevronRight" size={12} /></span></span>
  </button>
}
