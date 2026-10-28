/**
 * DASHBOARDS.md §9: the Dashboards card of a department page: the department's installed dashboards, "Recommended for
 * <Department>" cards, and the dashboard marketplace (every catalog dashboard, filtered by department, category and
 * search, with a sample-data preview). Adding one opens the key form: only the keys that dashboard needs, each with
 * where to get it, checked by main with a real read-only call before anything is saved.
 *
 * CONNECTIONS.md §4.3: a dashboard whose service the company already has (a key under any of its names, or a sign-in
 * that can read it, like PostHog's) shows "PostHog connected" and adds with no key form; one that isn't shows the shared
 * "Connect PostHog" slot. An installed PostHog dashboard also offers "See sessions" and "Ask about your data".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEPARTMENT_PRESETS, type Department, type DepartmentPresetKey } from '@shared/company'
import {
  DASHBOARD_CATEGORIES,
  dashboardDef,
  dashboardDepartmentKey,
  recommendedFor,
  searchDashboards,
  type DashboardCategory,
  type DashboardConfig,
  type DashboardDef,
  type DashboardKeyLookup,
  type DashboardSnapshot,
  type InstalledDashboard
} from '@shared/dashboards'
import { Button, IconButton, Pill, RelativeTime, Sheet } from '../ui'
import { Icon } from '../Icon'
import { confirmNative, errorMessage, hive, nativeMenu, useHiveEvent, type RendererHiveError } from '../../lib/hive'
import { installReadiness, keysReady, statusCopy } from '../../lib/dashboards'
import { serviceMonogram } from '../../lib/serviceActions'
import { ConnectionSlot, runServiceAction } from '../connections/ConnectionSlot'
import { openConnect, useConnection } from '../../state/connections'
import { serviceActions, viaWords } from '../../lib/serviceActions'
import { attempt, toast } from '../../state/store'
import { DashboardBody } from './DashboardBody'
import '../../styles/dashboards.css'

/** The company's dashboards for one department, kept fresh on data:changed (dashboards, and secrets for key state). */
function useDepartmentDashboards(dep: Department): { items: InstalledDashboard[] | null; reload: () => void } {
  const [items, setItems] = useState<InstalledDashboard[] | null>(null)
  const req = useRef(0)
  const reload = useCallback(() => {
    const id = ++req.current
    hive.dashboards.list({ companyId: dep.companyId, departmentId: dep.id }).then(
      (l) => id === req.current && setItems(l),
      () => id === req.current && setItems([])
    )
  }, [dep.companyId, dep.id])
  useEffect(() => {
    reload()
    return () => {
      req.current++
    }
  }, [reload])
  useHiveEvent('data:changed', ({ domain }) => {
    if (domain === 'dashboards' || domain === 'secrets') reload()
  })
  return { items, reload }
}

/** Which keys each recommended dashboard would find in this company (company or Shared). */
function useKeyLookups(companyId: string, defs: readonly DashboardDef[]): Record<string, DashboardKeyLookup[]> {
  const [map, setMap] = useState<Record<string, DashboardKeyLookup[]>>({})
  const ids = defs.map((d) => d.id).join()
  const load = useCallback(() => {
    void Promise.all(defs.map((d) => hive.dashboards.keys({ companyId, kind: d.id }).then((l) => [d.id, l] as const, () => [d.id, []] as const))).then((pairs) => setMap(Object.fromEntries(pairs)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, ids])
  useEffect(load, [load])
  useHiveEvent('data:changed', ({ domain }) => {
    if (domain === 'secrets') load()
  })
  return map
}

/** The one registry service a dashboard needs a key for (null: GEO's optional engines, GitHub's gh login). */
export const dashboardService = (def: DashboardDef): string | null => (def.services.length === 1 && def.keys.some((k) => k.required) ? def.services[0]! : null)

/** How the company's connection serves a dashboard now: 'key', 'signIn' (no key, a sign-in that reads it), or null. */
function useDashboardRoute(companyId: string, def: DashboardDef): { route: 'key' | 'signIn' | null; service: string | null } {
  const service = dashboardService(def)
  const { status, ok } = useConnection(companyId, service ?? '', 'dashboard')
  if (!service || !ok || !status) return { route: null, service }
  return { route: status.purposes.dashboard?.via === 'mcp' ? 'signIn' : 'key', service }
}

const presetName = (key: DepartmentPresetKey | null): string | null => (key ? (DEPARTMENT_PRESETS.find((p) => p.key === key)?.name ?? null) : null)

export function DepartmentDashboards({ dep, target = null }: { dep: Department; /** opened from the sidebar: open this dashboard and scroll to it */ target?: { id: string; nonce: number } | null }): React.JSX.Element {
  const { items, reload } = useDepartmentDashboards(dep)
  // the sidebar's dashboard rows: once the list is here, bring the dashboard into view (the card itself if it is gone)
  const loaded = items !== null
  const targetId = target?.id ?? null
  const targetNonce = target?.nonce ?? 0
  useEffect(() => {
    if (!targetId || !loaded) return
    requestAnimationFrame(() => (document.getElementById(`dsh-${targetId}`) ?? document.getElementById('dep-dashboards'))?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }, [targetId, targetNonce, loaded])
  const preset = dashboardDepartmentKey(dep)
  const recommended = useMemo(() => recommendedFor(preset), [preset])
  const installedKinds = new Set((items ?? []).map((d) => d.kind))
  const recs = recommended.filter((d) => !installedKinds.has(d.id))
  const lookups = useKeyLookups(dep.companyId, recs)
  const [market, setMarket] = useState<{ open: DashboardDef | null } | null>(null)
  const [installing, setInstalling] = useState<{ def: DashboardDef; existing?: InstalledDashboard } | null>(null)
  const readonly = !!dep.archivedAt
  return (
    <section className="dep-card dsh-card" id="dep-dashboards" aria-label="Dashboards">
      <header className="dep-card__head">
        <h2>Dashboards</h2>
        {!!items?.length && <span className="dep-card__count">{items.length}</span>}
        <span className="dep-card__hint">The numbers {dep.name} watches. Agents here read the latest ones.</span>
        <span className="flex1" />
        <Button size="sm" icon="marketplace" onClick={() => setMarket({ open: null })}>
          Browse marketplace
        </Button>
      </header>
      {items?.map((d, i) => (
        <DashboardPanel key={d.id} item={d} departmentId={dep.id} defaultOpen={i === 0 || target?.id === d.id} focusNonce={target?.id === d.id ? target.nonce : 0} onEdit={() => setInstalling({ def: dashboardDef(d.kind)!, existing: d })} onChanged={reload} />
      ))}
      {recs.length > 0 && !readonly && (
        <div className="dsh-recs">
          <div className="dsh-eyebrow">Recommended for {dep.name}</div>
          <div className="dsh-recs__grid">
            {recs.map((def) => (
              <RecommendedCard key={def.id} def={def} companyId={dep.companyId} lookups={lookups[def.id] ?? []} onAdd={() => setInstalling({ def })} onPreview={() => setMarket({ open: def })} />
            ))}
          </div>
        </div>
      )}
      {items && !items.length && !recs.length && (
        <p className="dep-card__empty">
          {presetName(preset) ? `Nothing recommended for ${dep.name} yet.` : `${dep.name} has no recommended dashboards.`} The marketplace lists every dashboard: SEO, AI visibility, web analytics, revenue and engineering.
        </p>
      )}
      {market && (
        <DashboardMarketplace
          dep={dep}
          installed={installedKinds}
          initial={market.open}
          onClose={() => setMarket(null)}
          onAdd={(def) => {
            setMarket(null)
            setInstalling({ def })
          }}
        />
      )}
      {installing && (
        <InstallDashboardSheet
          dep={dep}
          def={installing.def}
          existing={installing.existing}
          onClose={() => setInstalling(null)}
          onDone={() => {
            setInstalling(null)
            reload()
          }}
        />
      )}
    </section>
  )
}

/** The roundel every dashboard wears: the provider's two letters, white line art. */
function Roundel({ def, size = 30 }: { def: DashboardDef; size?: number }): React.JSX.Element {
  return (
    <span className="dsh-roundel" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <circle cx="16" cy="16" r="15" className="dsh-roundel__outer" />
        <circle cx="16" cy="16" r="12.5" className="dsh-roundel__inner" />
      </svg>
      <span className="dsh-roundel__text">{serviceMonogram(def.provider)}</span>
    </span>
  )
}

function KeyChips({ def, lookups }: { def: DashboardDef; lookups: DashboardKeyLookup[] }): React.JSX.Element {
  const needed = def.keys.filter((k) => k.required)
  return (
    <span className="dsh-keychips">
      {needed.length === 0 && <span className="dsh-keychip is-ready">No key needed</span>}
      {needed.map((k) => {
        const l = lookups.find((x) => x.name === k.name)
        return (
          <span key={k.name} className={`dsh-keychip ${l?.source ? 'is-ready' : ''}`} title={k.name}>
            {l?.source ? <Icon name="check" size={10} /> : <Icon name="keys" size={10} />}
            {l?.source ? `${k.label} found (${l.source === 'shared' ? 'Shared' : 'this company'})` : k.label}
          </span>
        )
      })}
    </span>
  )
}

function RecommendedCard({ def, companyId, lookups, onAdd, onPreview }: { def: DashboardDef; companyId: string; lookups: DashboardKeyLookup[]; onAdd: () => void; onPreview: () => void }): React.JSX.Element {
  const { route, service } = useDashboardRoute(companyId, def)
  const ready = !!route || keysReady(def, lookups)
  return (
    <div className="dsh-rec">
      <div className="dsh-rec__top">
        <Roundel def={def} />
        <span className="dsh-rec__id">
          <strong>{def.name}</strong>
          <span>{def.category}</span>
        </span>
      </div>
      <p className="dsh-rec__tagline">{def.tagline}</p>
      {service ? <ConnectionSlot companyId={companyId} service={service} purpose="dashboard" variant="inline" actions={false} /> : <KeyChips def={def} lookups={lookups} />}
      <div className="dsh-rec__actions">
        {/* a service-backed dashboard that isn't connected yet has one button: the slot's "Connect PostHog" above */}
        {(!service || ready) && (
          <Button size="sm" variant="primary" icon="plus" onClick={onAdd}>
            {ready ? 'Add' : 'Add your keys'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onPreview}>
          Preview
        </Button>
      </div>
    </div>
  )
}

// ---------- an installed dashboard ----------

function DashboardPanel({ item, departmentId, defaultOpen, focusNonce = 0, onEdit, onChanged }: { item: InstalledDashboard; departmentId: string; defaultOpen: boolean; /** changes each time the sidebar opens this dashboard: it unfolds */ focusNonce?: number; onEdit: () => void; onChanged: () => void }): React.JSX.Element | null {
  const def = dashboardDef(item.kind)
  const service = def ? dashboardService(def) : null
  const { status: conn } = useConnection(item.companyId, service ?? '')
  const acts = service ? serviceActions(conn) : []
  const [open, setOpen] = useState(defaultOpen)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (focusNonce) setOpen(true)
  }, [focusNonce])
  if (!def) return null
  const snap = item.snapshot
  const loading = busy || item.status.state === 'loading'
  const banner = statusCopy(item.status, !!snap)
  const refresh = async (): Promise<void> => {
    setBusy(true)
    const r = await attempt(() => hive.dashboards.refresh({ id: item.id }), 'Refresh')
    setBusy(false)
    if (r?.status.state === 'error' && r.status.message) toast(r.status.message, 'error')
    onChanged()
  }
  const more = async (): Promise<void> => {
    const pick = await nativeMenu([
      { id: 'edit', label: 'Settings and keys…' },
      { id: 'refresh', label: 'Refresh now', enabled: !loading },
      { type: 'separator' },
      { id: 'remove', label: 'Remove dashboard…' }
    ])
    if (pick === 'edit') onEdit()
    else if (pick === 'refresh') void refresh()
    else if (pick === 'remove') {
      const ok = await confirmNative({ message: `Remove ${def.name}?`, detail: 'Its keys stay in this company’s Keys, where other dashboards and agents can still use them.', confirmLabel: 'Remove Dashboard', destructive: true })
      if (!ok) return
      if (await attempt(() => hive.dashboards.remove({ id: item.id }), 'Remove')) {
        toast(`${def.name} removed`)
        onChanged()
      }
    }
  }
  return (
    <article className={`dsh-panel ${open ? 'is-open' : ''}`} id={`dsh-${item.id}`} aria-label={def.name}>
      <header className="dsh-panel__head">
        <button type="button" className="dsh-panel__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          <Roundel def={def} size={26} />
          <span className="dsh-panel__id">
            <strong>{def.name}</strong>
            <span className="dsh-panel__meta">
              {snap ? snap.period : def.provider}
              {snap && (
                <>
                  {' · '}updated <RelativeTime iso={snap.fetchedAt} />
                </>
              )}
            </span>
          </span>
        </button>
        {snap?.sample && <Pill tone="accent" title="HIVE_DASHBOARD_FIXTURES is on: these numbers are sample data">sample data</Pill>}
        {item.via === 'signIn' && <Pill tone="idle" title={`Reads through ${def.provider}’s sign-in (no key saved)`}>via sign-in</Pill>}
        {acts.map((a) => (
          <Button key={a.id} size="sm" variant="ghost" onClick={() => runServiceAction(a, { companyId: item.companyId, departmentId, service: def.provider })}>
            {a.label}
          </Button>
        ))}
        {loading && <span className="dsh-panel__busy">Refreshing…</span>}
        <IconButton icon="refresh" label={`Refresh ${def.name}`} disabled={loading} onClick={() => void refresh()} />
        <IconButton icon="more" label="More" onClick={() => void more()} />
      </header>
      {banner && (
        <div className={`dsh-banner dsh-banner--${banner.tone}`} role={banner.tone === 'error' ? 'alert' : 'status'}>
          <Icon name={banner.tone === 'error' ? 'warning' : 'clock'} size={13} />
          <span className="dsh-banner__text">
            <strong>{banner.title}</strong>
            {item.status.message && <span>{item.status.message}</span>}
          </span>
          {banner.action === 'keys' && (
            <Button size="sm" onClick={onEdit}>
              Update key
            </Button>
          )}
          {banner.action === 'settings' && (
            <Button size="sm" onClick={onEdit}>
              Settings
            </Button>
          )}
          {banner.action === 'retry' && (
            <Button size="sm" disabled={loading} onClick={() => void refresh()}>
              Retry now
            </Button>
          )}
        </div>
      )}
      {snap ? <DashboardBody def={def} snapshot={snap} details={open} /> : !banner && <div className="dsh-skeleton" aria-hidden="true" />}
    </article>
  )
}

// ---------- the marketplace ----------

const DEPARTMENT_FILTERS: { value: DepartmentPresetKey | 'all'; label: string }[] = [{ value: 'all', label: 'All departments' }, ...DEPARTMENT_PRESETS.map((p) => ({ value: p.key, label: p.name }))]

function NeedsLine({ def, companyId }: { def: DashboardDef; companyId: string }): React.JSX.Element {
  const { route, service } = useDashboardRoute(companyId, def)
  const { status } = useConnection(companyId, service ?? '')
  if (route && status) return <>{`${status.name} connected · ${viaWords(status)}`}</>
  // QA-08: connected, but not in a form this dashboard can read: say which key it needs, never "Needs Stripe"
  if (status && (status.state === 'connected' || status.state === 'attention')) {
    const p = status.purposes.dashboard
    const k = p?.fixKey ? def.keys.find((x) => x.name === p.fixKey) : def.keys.find((x) => x.required)
    return <>{status.state === 'attention' ? `${status.name} needs attention` : `${status.name} connected · needs ${k ? `a ${k.label.replace(/\s*\(.*?\)/g, '').toLowerCase()}` : 'another key'} for this dashboard`}</>
  }
  return <>{def.keys.filter((k) => k.required).length ? `Needs ${service && status ? status.name : def.keys.filter((k) => k.required).map((k) => k.label).join(', ')}` : 'No key required'}</>
}

function DashboardMarketplace({ dep, installed, initial, onClose, onAdd }: { dep: Department; installed: Set<string>; initial: DashboardDef | null; onClose: () => void; onAdd: (def: DashboardDef) => void }): React.JSX.Element {
  const preset = dashboardDepartmentKey(dep)
  const [query, setQuery] = useState('')
  const [department, setDepartment] = useState<DepartmentPresetKey | 'all'>(preset ?? 'all')
  const [category, setCategory] = useState<DashboardCategory | 'all'>('all')
  const [open, setOpen] = useState<DashboardDef | null>(initial)
  const shown = searchDashboards(query, { department, category })
  if (open) return <MarketDetail dep={dep} def={open} installed={installed.has(open.id)} onBack={() => setOpen(null)} onClose={onClose} onAdd={() => onAdd(open)} />
  return (
    <Sheet title="Dashboard marketplace" onCancel={onClose} cancelLabel="Done" width={860}>
      <div className="dsh-market">
        <p className="dsh-market__intro">Dashboards use this company’s connections: a service connected anywhere in Principia fills its numbers here. One that isn’t connected yet asks for its key or sign-in once, checks it with one read-only request, and refreshes on its own.</p>
        <div className="dsh-market__controls">
          <label className="dsh-market__search">
            <Icon name="search" size={14} />
            <input className="input" type="search" placeholder="Search SEO, churn, pull requests…" aria-label="Search dashboards" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <select className="input input--sm" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as DashboardCategory | 'all')}>
            <option value="all">All categories</option>
            {DASHBOARD_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="dsh-market__filters" role="group" aria-label="Department">
          {DEPARTMENT_FILTERS.map((f) => (
            <button type="button" key={f.value} aria-pressed={department === f.value} onClick={() => setDepartment(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
        {shown.length ? (
          <div className="dsh-market__grid">
            {shown.map((def) => (
              <button type="button" key={def.id} className="dsh-market__card" onClick={() => setOpen(def)} aria-label={`Preview ${def.name}`}>
                <span className="dsh-rec__top">
                  <Roundel def={def} />
                  <span className="dsh-rec__id">
                    <strong>{def.name}</strong>
                    <span>{def.category}</span>
                  </span>
                  {installed.has(def.id) && <Pill tone="passed">Added</Pill>}
                </span>
                <span className="dsh-rec__tagline">{def.tagline}</span>
                <span className="dsh-market__for">
                  For {def.departments.map((k) => presetName(k)).filter(Boolean).join(', ')}
                  {preset && def.departments.includes(preset) ? ' · recommended here' : ''}
                </span>
                <span className="dsh-market__needs">
                  <NeedsLine def={def} companyId={dep.companyId} />
                  <span>
                    Preview <Icon name="chevronRight" size={11} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="dep-card__empty">No dashboards match. Try another word or “All departments”.</p>
        )}
      </div>
    </Sheet>
  )
}

function MarketDetail({ dep, def, installed, onBack, onClose, onAdd }: { dep: Department; def: DashboardDef; installed: boolean; onBack: () => void; onClose: () => void; onAdd: () => void }): React.JSX.Element {
  const [sample, setSample] = useState<DashboardSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    hive.dashboards.sample({ kind: def.id }).then(setSample, (e) => setError(errorMessage(e)))
  }, [def.id])
  return (
    <Sheet title={def.name} onCancel={onClose} onPrimary={onAdd} primaryLabel={installed ? `Add another to ${dep.name}` : `Add to ${dep.name}`} width={860} footerLeft={<Button variant="ghost" icon="chevronLeft" onClick={onBack}>All dashboards</Button>}>
      <div className="dsh-detail">
        <div className="dsh-detail__head">
          <Roundel def={def} size={40} />
          <div>
            <p className="dsh-detail__desc">{def.description}</p>
            <p className="dsh-detail__meta">
              {def.provider} · refreshes every {def.refreshMinutes >= 60 ? `${def.refreshMinutes / 60} h` : `${def.refreshMinutes} min`} · {def.keys.length ? def.keys.map((k) => `${k.label}${k.required ? '' : ' (optional)'}`).join(', ') : 'no keys'}
            </p>
            {def.keylessNote && <p className="dsh-detail__meta">{def.keylessNote}</p>}
          </div>
        </div>
        <div className="dsh-eyebrow">Preview · sample data</div>
        {sample ? <div className="dsh-panel is-open dsh-panel--preview"><DashboardBody def={def} snapshot={sample} /></div> : error ? <p className="dep-card__empty">{error}</p> : <div className="dsh-skeleton" aria-hidden="true" />}
      </div>
    </Sheet>
  )
}

// ---------- adding keys ----------

const configHas = (v: string | string[] | undefined): boolean => (Array.isArray(v) ? v.length > 0 : !!(v ?? '').trim())
/** The dashboard can read through a sign-in to its service (PostHog). */
const dashboardSignIn = (def: DashboardDef): boolean => !!def.viaSignIn

function InstallDashboardSheet({ dep, def, existing, onClose, onDone }: { dep: Department; def: DashboardDef; existing?: InstalledDashboard; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [lookups, setLookups] = useState<DashboardKeyLookup[]>([])
  const [pasted, setPasted] = useState<Record<string, string>>({})
  const [replace, setReplace] = useState<Record<string, boolean>>({})
  const [config, setConfig] = useState<DashboardConfig>(() => {
    const c: DashboardConfig = {}
    for (const f of def.config) {
      const v = existing?.config[f.key]
      c[f.key] = f.kind === 'list' ? (Array.isArray(v) ? v.join('\n') : (v ?? '')) : Array.isArray(v) ? v.join(' ') : (v ?? '')
    }
    return c
  })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    hive.dashboards.keys({ companyId: dep.companyId, kind: def.id }).then(setLookups, () => setLookups([]))
  }, [dep.companyId, def.id])
  // CONNECTIONS.md §4.3: the company's connection already serves this dashboard: no key form, settings prefilled
  const { route, service } = useDashboardRoute(dep.companyId, def)
  const { status: conn } = useConnection(dep.companyId, service ?? '')
  const [replacing, setReplacing] = useState(false)
  const [error, setError] = useState<{ message: string; path: string | null } | null>(null)
  // QP-7: a key the vendor just turned down is never "already connected, no key to add": the key fields come back
  const useConnectionRoute = !!route && !replacing && error?.path !== 'keys'
  // QA-08: connected, but not in a form this dashboard reads (Stripe with an agent key): why, and where the one key goes
  const notForThis = !route && conn && (conn.state === 'connected' || conn.state === 'attention') ? conn.purposes.dashboard : undefined
  useEffect(() => {
    if (!conn?.settings) return
    setConfig((c) => {
      const next = { ...c }
      for (const f of def.config) if (!configHas(next[f.key]) && conn.settings[f.key]) next[f.key] = conn.settings[f.key]!
      return next
    })
  }, [conn?.settings, def.config])
  const ready = installReadiness(def, lookups, pasted, config, useConnectionRoute ? route : null)
  const submit = async (): Promise<void> => {
    if (!ready.ok || busy) return
    setBusy(true)
    setError(null)
    const keys = Object.fromEntries(Object.entries(pasted).filter(([, v]) => v.trim()))
    try {
      if (existing) await hive.dashboards.update({ id: existing.id, config, keys })
      else await hive.dashboards.install({ companyId: dep.companyId, departmentId: dep.id, kind: def.id, config, keys })
      // the pasted values are dropped from memory here; main has them now and never sends them back
      setPasted({})
      toast(existing ? `${def.name} updated` : `${def.name} added to ${dep.name}. Fetching the first numbers…`)
      onDone()
    } catch (e) {
      const errs = (e as RendererHiveError).errors
      setError({ message: errorMessage(e), path: errs?.[0]?.path ?? null })
    } finally {
      setBusy(false)
    }
  }
  const open = (url: string): void => void attempt(() => hive.app.openExternal({ url }), 'Open link')
  return (
    <Sheet
      title={existing ? `${def.name} · settings and keys` : `Add ${def.name}`}
      onCancel={() => !busy && onClose()}
      onPrimary={() => void submit()}
      primaryLabel={busy ? 'Checking…' : existing ? 'Check and save' : 'Check and add'}
      primaryDisabled={!ready.ok || busy}
      primaryTitle={ready.ok ? undefined : `Still needed: ${ready.missing.join(', ')}`}
      width={620}
      footerLeft={<span className="dsh-install__safe"><Icon name="lock" size={11} /> {useConnectionRoute ? `Checked with one read-only request through ${def.provider}, already connected for this company.` : 'Checked with one read-only request, stored encrypted in this company’s Keys, never shown again.'}</span>}
    >
      <div className="dsh-install">
        {error && (
          <div className="company-error" role="alert">
            {error.message}
          </div>
        )}
        {def.keylessNote && <p className="dsh-install__note">{def.keylessNote}</p>}
        {notForThis && conn && (
          <p className="dsh-install__note">
            {conn.name} is connected for this company ({conn.chip.replace(/^Connected · /, '')}). {notForThis.why ?? `${def.name} needs its own key.`}{' '}
            {service && (
              <button type="button" className="dep-link" onClick={() => openConnect(dep.companyId, service, 'dashboard')}>
                Add it in {conn.name}’s connection
              </button>
            )}
          </p>
        )}
        {useConnectionRoute && conn && (
          <div className="dsh-key">
            <div className="dsh-key__saved">
              <Icon name="check" size={12} />
              <span>
                Uses {conn.name}, already connected for this company · {viaWords(conn)}. No key to add.
                {route === 'signIn' ? ' It reads through the sign-in, which already picked the project.' : ''}
              </span>
              <span className="flex1" />
              {route === 'key' && (
                <button type="button" className="dep-link" onClick={() => setReplacing(true)}>
                  Use another key
                </button>
              )}
            </div>
          </div>
        )}
        {!route && service && dashboardSignIn(def) && (
          <p className="dsh-install__note">
            Or skip the key:{' '}
            <button type="button" className="dep-link" onClick={() => openConnect(dep.companyId, service, 'dashboard')}>
              sign in to {def.provider}
            </button>{' '}
            and this dashboard reads through the sign-in.
          </p>
        )}
        {!useConnectionRoute && def.keys.map((k) => {
          const saved = lookups.find((l) => l.name === k.name)
          const showInput = !saved?.source || replace[k.name]
          return (
            <div key={k.name} className={`dsh-key ${error?.path === 'keys' ? 'is-error' : ''}`}>
              <div className="dsh-key__head">
                <span className="dsh-key__label">
                  {k.label}
                  {!k.required && <span className="dsh-key__opt"> · optional</span>}
                </span>
                <code className="dsh-key__name">{k.name}</code>
                <span className="flex1" />
                <button type="button" className="dep-link" onClick={() => open(k.link)}>
                  {k.linkLabel} <Icon name="external" size={10} />
                </button>
              </div>
              <p className="dsh-key__hint">{k.hint}</p>
              {saved?.source && !replace[k.name] ? (
                <div className="dsh-key__saved">
                  <Icon name="check" size={12} />
                  <span>
                    Using the saved key from {saved.source === 'shared' ? 'Shared' : `this company`} <span className="dsh-key__mask">{saved.masked}</span>
                  </span>
                  <span className="flex1" />
                  <button type="button" className="dep-link" onClick={() => setReplace({ ...replace, [k.name]: true })}>
                    Replace
                  </button>
                </div>
              ) : null}
              {showInput &&
                (k.multiline ? (
                  <textarea className="input dsh-key__input dsh-key__input--multi" rows={4} spellCheck={false} autoComplete="off" placeholder={k.placeholder} aria-label={k.label} value={pasted[k.name] ?? ''} onChange={(e) => setPasted({ ...pasted, [k.name]: e.target.value })} />
                ) : (
                  <input className="input dsh-key__input" type="password" spellCheck={false} autoComplete="off" placeholder={k.placeholder} aria-label={k.label} value={pasted[k.name] ?? ''} onChange={(e) => setPasted({ ...pasted, [k.name]: e.target.value })} />
                ))}
            </div>
          )
        })}
        {def.config.length > 0 && (
          <div className="dep-form dsh-install__config">
            {def.config.map((f) => (
              <label key={f.key} className={`dep-field ${f.kind === 'list' ? 'dep-field--top' : ''}`}>
                <span>{f.label}</span>
                <span className="dep-field__col">
                  {f.kind === 'list' ? (
                    <textarea className="input dep-textarea" rows={Math.min(5, f.max ?? 4)} placeholder={f.placeholder} value={config[f.key] as string} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
                  ) : (
                    <input className="input" placeholder={f.placeholder} value={config[f.key] as string} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
                  )}
                  {f.hint && <span className="dep-field__hint">{f.hint}{f.required && !(useConnectionRoute && route === 'signIn' && def.viaSignIn?.config.includes(f.key)) ? '' : ' Optional.'}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}
