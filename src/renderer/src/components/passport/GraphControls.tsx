/** The global graph's controls drawer (PASSPORT.md §10), mirroring Obsidian's: Filters, Groups, Display, Forces. */
import { useState } from 'react'
import type { GlobalGraphFilters } from '@shared/passport'
import { Button, IconButton, Switch } from '../ui'
import { Icon } from '../Icon'
import { DEFAULT_DISPLAY, DEFAULT_FORCES, DEFAULT_GROUPS, parseGroupQuery, type Display, type Forces, type GraphGroup } from '../../lib/forceGraph'

export interface GraphSettings {
  filters: GlobalGraphFilters
  groups: GraphGroup[]
  display: Display
  forces: Forces
}
export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  filters: { search: '', existingOnly: false, orphans: true, includeArchived: false, includeTags: false },
  groups: DEFAULT_GROUPS,
  display: DEFAULT_DISPLAY,
  forces: DEFAULT_FORCES
}

type Section = 'filters' | 'groups' | 'display' | 'forces'

export function GraphControls({
  settings,
  onChange,
  onClose,
  animating,
  onAnimate,
  huge
}: {
  settings: GraphSettings
  onChange: (s: GraphSettings) => void
  onClose: () => void
  animating: boolean
  onAnimate: () => void
  /** above 5k nodes ghosts and orphans are hidden by default */
  huge: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState<Record<Section, boolean>>({ filters: true, groups: false, display: false, forces: false })
  const f = settings.filters
  const setF = (p: Partial<GlobalGraphFilters>): void => onChange({ ...settings, filters: { ...f, ...p } })
  const setD = (p: Partial<Display>): void => onChange({ ...settings, display: { ...settings.display, ...p } })
  const setFo = (p: Partial<Forces>): void => onChange({ ...settings, forces: { ...settings.forces, ...p } })
  const setGroups = (groups: GraphGroup[]): void => onChange({ ...settings, groups })
  const head = (key: Section, label: string, reset?: () => void): React.JSX.Element => (
    <div className="pgc__head">
      <button type="button" className="pgc__toggle" onClick={() => setOpen({ ...open, [key]: !open[key] })}>
        <Icon name={open[key] ? 'chevronDown' : 'chevronRight'} size={12} /> {label}
      </button>
      {open[key] && reset && (
        <button type="button" className="pgc__reset" onClick={reset} title="Restore defaults">
          Reset
        </button>
      )}
    </div>
  )

  return (
    <aside className="pgc" aria-label="Graph settings">
      <div className="pgc__top">
        <span className="pgc__title">Graph settings</span>
        <IconButton icon="close" label="Close settings" onClick={onClose} />
      </div>

      {head('filters', 'Filters', () => onChange({ ...settings, filters: { ...DEFAULT_GRAPH_SETTINGS.filters, existingOnly: huge, orphans: !huge } }))}
      {open.filters && (
        <div className="pgc__body">
          <input className="input input--sm" placeholder="Search files…" value={f.search ?? ''} onChange={(e) => setF({ search: e.target.value })} spellCheck={false} />
          <input
            className="input input--sm"
            placeholder="Tags, comma separated (#a, #b/c)"
            value={(f.tags ?? []).join(', ')}
            onChange={(e) => setF({ tags: e.target.value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean) })}
            spellCheck={false}
          />
          <Row label="Tags as nodes">
            <Switch checked={!!f.includeTags} onChange={(v) => setF({ includeTags: v })} label="Tags as nodes" />
          </Row>
          <Row label="Existing files only" hint="Hides ghost notes (links to notes that don’t exist yet).">
            <Switch checked={!!f.existingOnly} onChange={(v) => setF({ existingOnly: v })} label="Existing files only" />
          </Row>
          <Row label="Orphans">
            <Switch checked={f.orphans !== false} onChange={(v) => setF({ orphans: v })} label="Orphans" />
          </Row>
          <Row label="Include archived">
            <Switch checked={!!f.includeArchived} onChange={(v) => setF({ includeArchived: v })} label="Include archived" />
          </Row>
        </div>
      )}

      {head('groups', 'Groups', () => setGroups(DEFAULT_GROUPS))}
      {open.groups && (
        <div className="pgc__body">
          {settings.groups.map((g, i) => {
            const bad = g.query.trim() !== '' && !parseGroupQuery(g.query)
            return (
              <div key={i} className="pgc__group">
                <input
                  type="color"
                  className="pgc__swatch"
                  value={g.color}
                  aria-label="Group colour"
                  onChange={(e) => setGroups(settings.groups.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))}
                />
                <input
                  className={`input input--sm ${bad ? 'is-invalid' : ''}`}
                  value={g.query}
                  placeholder='path:"People", tag:#x, type:person'
                  spellCheck={false}
                  onChange={(e) => setGroups(settings.groups.map((x, j) => (j === i ? { ...x, query: e.target.value } : x)))}
                />
                <IconButton icon="close" label="Remove group" onClick={() => setGroups(settings.groups.filter((_, j) => j !== i))} />
              </div>
            )
          })}
          <Button size="sm" icon="plus" onClick={() => setGroups([...settings.groups, { query: '', color: '#6e8cff' }])}>
            New group
          </Button>
        </div>
      )}

      {head('display', 'Display', () => onChange({ ...settings, display: DEFAULT_DISPLAY }))}
      {open.display && (
        <div className="pgc__body">
          <Row label="Arrows">
            <Switch checked={settings.display.arrows} onChange={(v) => setD({ arrows: v })} label="Arrows" />
          </Row>
          <Slider label="Text fade threshold" min={-3} max={3} step={0.1} value={settings.display.textFade} onChange={(v) => setD({ textFade: v })} />
          <Slider label="Node size" min={0.5} max={3} step={0.05} value={settings.display.nodeSize} onChange={(v) => setD({ nodeSize: v })} />
          <Slider label="Link thickness" min={0.5} max={3} step={0.05} value={settings.display.linkThickness} onChange={(v) => setD({ linkThickness: v })} />
          <Button size="sm" icon={animating ? 'stop' : 'play'} onClick={onAnimate} title="Replays the graph growing note by note, oldest first">
            {animating ? 'Stop' : 'Animate'}
          </Button>
        </div>
      )}

      {head('forces', 'Forces', () => onChange({ ...settings, forces: DEFAULT_FORCES }))}
      {open.forces && (
        <div className="pgc__body">
          <Slider label="Center force" min={0} max={1} step={0.01} value={settings.forces.center} onChange={(v) => setFo({ center: v })} />
          <Slider label="Repel force" min={0} max={20} step={0.1} value={settings.forces.repel} onChange={(v) => setFo({ repel: v })} />
          <Slider label="Link force" min={0} max={1} step={0.01} value={settings.forces.linkStrength} onChange={(v) => setFo({ linkStrength: v })} />
          <Slider label="Link distance" min={30} max={500} step={1} value={settings.forces.linkDistance} onChange={(v) => setFo({ linkDistance: v })} />
        </div>
      )}
    </aside>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="pgc__row" title={hint}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }): React.JSX.Element {
  return (
    <label className="pgc__slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}
