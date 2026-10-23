/**
 * DASHBOARDS.md §9: the Dashboards card of a department page: the department's installed dashboards, "Recommended for
 * <Department>" cards, and the dashboard marketplace (every catalog dashboard, filtered by department, category and
 * search, with a sample-data preview). Adding one opens the key form: only the keys that dashboard needs, each with
 * where to get it, checked by main with a real read-only call before anything is saved.
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
import { installReadiness, keysReady, monogram, statusCopy } from '../../lib/dashboards'
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

const presetName = (key: DepartmentPresetKey | null): string | null => (key ? (DEPARTMENT_PRESETS.find((p) => p.key === key)?.name ?? null) : null)

export function DepartmentDashboards({ dep }: { dep: Department }): React.JSX.Element {
  const { items, reload } = useDepartmentDashboards(dep)
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
        <DashboardPanel key={d.id} item={d} defaultOpen={i === 0} onEdit={() => setInstalling({ def: dashboardDef(d.kind)!, existing: d })} onChanged={reload} />
      ))}
      {recs.length > 0 && !readonly && (
        <div className="dsh-recs">
          <div className="dsh-eyebrow">Recommended for {dep.name}</div>
          <div className="dsh-recs__grid">
            {recs.map((def) => (
              <RecommendedCard key={def.id} def={def} lookups={lookups[def.id] ?? []} onAdd={() => setInstalling({ def })} onPreview={() => setMarket({ open: def })} />
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
      <span className="dsh-roundel__text">{monogram(def.provider)}</span>
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

function RecommendedCard({ def, lookups, onAdd, onPreview }: { def: DashboardDef; lookups: DashboardKeyLookup[]; onAdd: () => void; onPreview: () => void }): React.JSX.Element {
  const ready = keysReady(def, lookups)
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
      <KeyChips def={def} lookups={lookups} />
      <div className="dsh-rec__actions">
        <Button size="sm" variant="primary" icon="plus" onClick={onAdd}>
          {ready ? 'Add' : 'Add your keys'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onPreview}>
          Preview
        </Button>
      </div>
    </div>
  )
}

// ---------- an installed dashboard ----------

function DashboardPanel({ item, defaultOpen, onEdit, onChanged }: { item: InstalledDashboard; defaultOpen: boolean; onEdit: () => void; onChanged: () => void }): React.JSX.Element | null {
  const def = dashboardDef(item.kind)
  const [open, setOpen] = useState(defaultOpen)
  const [busy, setBusy] = useState(false)
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
    <article className={`dsh-panel ${open ? 'is-open' : ''}`} aria-label={def.name}>
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
        <p className="dsh-market__intro">Add your keys and the numbers fill in. Each dashboard asks only for the keys it needs, checks them with one read-only request, and refreshes on its own.</p>
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
                  {def.keys.filter((k) => k.required).length ? `Needs ${def.keys.filter((k) => k.required).map((k) => k.label).join(', ')}` : 'No key required'}
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
  const [error, setError] = useState<{ message: string; path: string | null } | null>(null)
  useEffect(() => {
    hive.dashboards.keys({ companyId: dep.companyId, kind: def.id }).then(setLookups, () => setLookups([]))
  }, [dep.companyId, def.id])
  const ready = installReadiness(def, lookups, pasted, config)
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
      footerLeft={<span className="dsh-install__safe"><Icon name="lock" size={11} /> Checked with one read-only request, stored encrypted in this company’s Keys, never shown again.</span>}
    >
      <div className="dsh-install">
        {error && (
          <div className="company-error" role="alert">
            {error.message}
          </div>
        )}
        {def.keylessNote && <p className="dsh-install__note">{def.keylessNote}</p>}
        {def.keys.map((k) => {
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
                  {f.hint && <span className="dep-field__hint">{f.hint}{f.required ? '' : ' Optional.'}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}
