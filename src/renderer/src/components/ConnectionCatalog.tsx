import notionLogo from '../assets/connections/notion.svg'
import linearLogo from '../assets/connections/linear.svg'
import githubLogo from '../assets/connections/github.svg'
import stripeLogo from '../assets/connections/stripe.svg'
import supabaseLogo from '../assets/connections/supabase.svg'
import sentryLogo from '../assets/connections/sentry.svg'
import figmaLogo from '../assets/connections/figma.svg'
import hubspotLogo from '../assets/connections/hubspot.svg'
import asanaLogo from '../assets/connections/asana.svg'
import { useState } from 'react'
import { CONNECTION_CATALOG, searchConnections, type ConnectionPreset } from '../lib/connectionCatalog'
import { Icon } from './Icon'
import { Button } from './ui'
import { hive } from '../lib/hive'

const logos: Record<string, string> = { notion: notionLogo, linear: linearLogo, github: githubLogo, stripe: stripeLogo, supabase: supabaseLogo, sentry: sentryLogo, figma: figmaLogo, hubspot: hubspotLogo, asana: asanaLogo }
const categories = ['All', ...new Set(CONNECTION_CATALOG.map(item => item.category))]
export function ConnectionCatalog({ busy, onSelect, onCustom, savedUrls }: { busy: boolean; onSelect: (preset: ConnectionPreset) => void; onCustom: () => void; savedUrls: string[] }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [detail, setDetail] = useState<ConnectionPreset | null>(null)
  const [error, setError] = useState('')
  const matches = searchConnections(query, category)
  return <section className="connection-catalog" aria-label="Connection catalog">
    <div className="gateway__editor-heading"><div><h3>Find your tools</h3><p className="gateway__hint">Choose a service. We’ll fill in the setup for you.</p></div><Button size="sm" variant="ghost" disabled={busy} onClick={onCustom}>Custom connection</Button></div>
    <label className="connection-catalog__search"><Icon name="search" size={18}/><input className="input" type="search" aria-label="Search connections" placeholder="Search tools or what you need — Granola, CRM, payments…" value={query} onChange={e => setQuery(e.target.value)}/></label>
    <div className="connection-catalog__filters" aria-label="Connection categories">{categories.map(value => <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)}>{value}</button>)}</div>
    <div className="connection-catalog__grid">{matches.map(item => {
      const saved = savedUrls.some(url => url.split('?')[0].replace(/\/$/, '') === item.url.split('?')[0].replace(/\/$/, ''))
      return <button key={item.id} type="button" className="connection-catalog__item" disabled={busy} onClick={() => { setDetail(null); setError(''); if (item.setupRequired) setDetail(item); else onSelect(item) }} aria-label={`${item.setupRequired ? 'Setup details for' : 'Connect'} ${item.name}`}>
        <span className={`connection-catalog__brand connection-catalog__brand--${item.id}`} aria-hidden="true">{logos[item.id] ? <img src={logos[item.id]} alt="" width={22} height={22}/> : item.name === 'Mobbin' ? 'm' : item.name.slice(0, 1)}</span>
        <span className="connection-catalog__copy"><strong>{item.name}</strong><span>{item.description}</span><small>{saved ? 'Already added · add another account' : item.setupRequired ? 'Setup required' : item.auth === 'token' ? 'Access token' : 'Browser sign-in'}</small></span><Icon name="chevronRight" size={14}/>
      </button>
    })}</div>
    {matches.length === 0 && <p className="connection-catalog__empty">No matches. Try another search, or add a custom connection.</p>}
    {detail && <div className="connection-catalog__detail" role="status"><strong>{detail.name}</strong><p>{detail.note}</p><Button size="sm" onClick={() => { void hive.app.openExternal({ url: detail.docs }).catch(() => setError('Could not open the setup guide. Try again.')) }}>Open setup guide <Icon name="external" size={12}/></Button></div>}
    {error && <p role="alert">{error}</p>}
  </section>
}
