/**
 * Company rail (COMPANY.md §8.1-8.2): All tile, one avatar per company with live badges, Personal and "+" at the
 * bottom. Shown once there is more than Personal; stays visible when the sidebar is collapsed.
 */
import { AutopilotMark } from '../components/autopilot/AutopilotChip'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CompanyPassport } from '@shared/company'
import type { Id } from '@shared/types'
import { Icon } from '../components/Icon'
import { Sheet } from '../components/ui'
import { Medallion } from '../components/roman'
import { companiesHealth } from '../lib/agentHealth'
import { t } from '../lib/voice'
import { nativeMenu } from '../lib/hive'
import { useCompanyLogoUrl, useLogoFit } from '../lib/logo'
import { companyLabel, isCompanyPaused, isPersonal, railName, railText, useCompanyBadges, useLaneContext, useLiveItems, type CompanyBadge, type LiveItem } from '../lib/company'
import { needsYouTasks, REASON_LABEL } from '../lib/board'
import {
  activeCompany,
  closeNewCompany,
  companyContextMenu,
  createCompany,
  departmentsOn,
  dismissCompanyUndo,
  enterCompany,
  multiCompany,
  openLiveItem,
  openBoard,
  openNewCompany,
  pauseAllAgents,
  reorderCompanies,
  undoCompanySwitch,
  updateCompany,
  useStore
} from '../state/store'

const COMPANY_DRAG_TYPE = 'application/x-principia-company'

/**
 * The company's square chip (sidebar group header, chips, settings). With a logo (company:logos) the logo fills the
 * chip: cropped when it paints its own ground, inset on the dark surface when it is light, on white when it is dark.
 */
export function CompanyAvatar({ company, size = 32, className = '' }: { company: Pick<CompanyPassport, 'name' | 'color'> & { id?: Id; railLabel?: string }; size?: number; className?: string }): React.JSX.Element {
  const logo = useCompanyLogoUrl(company.id)
  const fit = useLogoFit(logo)
  if (logo)
    return (
      <span className={`co-avatar co-avatar--logo co-avatar--${fit ?? 'plain'} ${className}`} style={{ width: size, height: size }} aria-hidden>
        <img src={logo} alt="" draggable={false} />
      </span>
    )
  // E14: the company's own rail label ("HDG", "HDK") wherever its chip shows, so look-alike clients differ everywhere
  const text = railText(company)
  const wide = text.length > 2
  return (
    <span
      className={`co-avatar ${wide ? 'co-avatar--wide' : ''} ${className}`}
      style={{ width: wide ? undefined : size, minWidth: size, height: size, background: company.color || 'var(--series-other)', fontSize: Math.max(wide ? 7 : 9, Math.round(size * (wide ? 0.32 : 0.38))) }}
      aria-hidden
    >
      {text}
    </span>
  )
}

/** Row badge: accent needs-you count, else a blue working dot, plus a red square tessera for a failed run in 24 h (VOICE.md §5.6). */
export function CompanyBadgeMark({ badge }: { badge: CompanyBadge | undefined }): React.JSX.Element | null {
  if (!badge) return null
  return (
    <>
      {badge.needsYou > 0 ? (
        <span className="side-row__badge side-row__badge--needs" title={`${badge.needsYou} need${badge.needsYou === 1 ? 's' : ''} you`}>
          ◆ {badge.needsYou}
        </span>
      ) : (
        badge.working > 0 && (
          <span className="glyph glyph--running status-dot--running" title={`${badge.working} working`}>
            ●
          </span>
        )
      )}
      {badge.failed && <span className="co-failed-dot co-failed-tess" title="A run failed in the last 24 hours" />}
    </>
  )
}

/**
 * Tooltip and accessible name of a rail coin: "Sunday Bakery, all agents healthy" with the laurel (VOICE.md §5.6, the
 * plain copy in both tones), then the badges as today (DESIGN.md §10.2).
 */
export function badgeTitle(name: string, b: CompanyBadge | undefined, laurel = false): string {
  const bits = [laurel ? `${name}, ${t.sr('rail.laurel.sr').toLowerCase()}` : name]
  if (b?.needsYou) bits.push(`${b.needsYou} need${b.needsYou === 1 ? 's' : ''} you`)
  if (b?.working) bits.push(`${b.working} working`)
  if (b?.failed) bits.push('a run failed in the last 24 h')
  return bits.join(' · ')
}

/**
 * VOICE.md §5.6: a company on the rail as an engraved coin. The laurel shows only when the company is healthy (§5.10),
 * nothing needs you and no run failed; the working tiles sit inside the rim and give way to the needs-you pill, as the
 * old avatar ring did; a failed run is the red square tessera at the bottom right. Personal is the same coin with "P"
 * and no tessera, and never wears the laurel. Decorative: the tile button carries the name.
 */
export function RailCoin({ company, badge, healthy, size = 32 }: { company: Pick<CompanyPassport, 'id' | 'name' | 'color' | 'system'>; badge: CompanyBadge | undefined; healthy: boolean; size?: number }): React.JSX.Element {
  const personal = isPersonal(company)
  const logo = useCompanyLogoUrl(personal ? null : company.id)
  const fit = useLogoFit(logo)
  return (
    <span className="rail__coin" aria-hidden>
      <Medallion
        name={company.name}
        logo={logo}
        logoFit={fit}
        color={company.color || undefined}
        size={size}
        initial={personal ? 'P' : undefined}
        laurel={railLaurel(company, badge, healthy)}
        working={!!badge?.working && !badge.needsYou}
        failed={!!badge?.failed}
        // a hook for the failed state; the mark itself is the Medallion's red square tessera (no rail dot any more)
        className={badge?.failed ? 'rail__failed' : undefined}
      />
    </span>
  )
}

/**
 * Five doors E14 (design §2.5): a company on the rail as a monogram tile, so five clients that share initials can be
 * told apart: its own short label (or its initials) in Geist on its colour at a 34% tint, inside a white line ring.
 * A logo fills the tile instead. Personal is the person glyph. Working: a thin blue arc; a failed run: the red square.
 */
export function RailMark({ company, badge, size = 32 }: { company: Pick<CompanyPassport, 'id' | 'name' | 'color' | 'system' | 'railLabel'>; badge?: CompanyBadge; size?: number }): React.JSX.Element {
  const personal = isPersonal(company)
  const logo = useCompanyLogoUrl(personal ? null : company.id)
  const fit = useLogoFit(logo)
  const text = personal ? '' : railText(company)
  const working = !!badge?.working && !badge.needsYou
  return (
    <span className={`rail-mark ${working ? 'is-working' : ''} ${personal ? 'rail-mark--personal' : ''} ${logo ? `rail-mark--logo rail-mark--${fit ?? 'plain'}` : ''}`} style={{ width: size, height: size, '--co': company.color || 'var(--series-other)', fontSize: Math.max(9, Math.round(size * (text.length > 2 ? 0.3 : 0.36))) } as React.CSSProperties} aria-hidden>
      {logo ? <img src={logo} alt="" draggable={false} /> : personal ? <Icon name="user" size={Math.round(size * 0.5)} /> : text}
      {badge?.failed && <i className="rail-mark__failed" />}
    </span>
  )
}

/** The laurel rule of the rail: healthy, nothing needs you, no failed run, and never on Personal. */
export function railLaurel(company: Pick<CompanyPassport, 'id' | 'system'>, badge: CompanyBadge | undefined, healthy: boolean): boolean {
  return healthy && !isPersonal(company) && !badge?.needsYou && !badge?.failed
}

/** Health per company (VOICE.md §5.10) from the slices the rail already reads; all false while departments are off. */
function useCompanyHealth(byCompany: Record<Id, CompanyBadge>): Record<Id, boolean> {
  const on = useStore((s) => departmentsOn(s))
  const companies = useStore((s) => s.companies)
  const companyAgents = useStore((s) => s.companyAgents)
  const tasks = useStore((s) => s.tasks)
  const asks = useStore((s) => s.asks)
  return useMemo(
    () => (on ? companiesHealth(companies.map((c) => c.id), { companyAgents, tasks, asks, badges: byCompany }) : {}),
    [on, companies, companyAgents, tasks, asks, byCompany]
  )
}

export function CompanyRail(): React.JSX.Element | null {
  const multi = useStore((s) => multiCompany(s))
  const companies = useStore((s) => s.companies)
  const active = useStore((s) => activeCompany(s))
  const { byCompany, total } = useCompanyBadges()
  const health = useCompanyHealth(byCompany)
  const [hover, setHover] = useState<{ id: Id; top: number } | null>(null)
  const [renaming, setRenaming] = useState<{ id: Id; top: number } | null>(null)
  const [dragged, setDragged] = useState<Id | null>(null)
  const [dropAt, setDropAt] = useState<{ id: Id; placement: 'before' | 'after' } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const railRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const onRename = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail
      const el = railRef.current?.querySelector<HTMLElement>(`[data-company="${id}"]`)
      setRenaming({ id, top: el?.getBoundingClientRect().top ?? 80 })
    }
    window.addEventListener('hive:renameCompany', onRename)
    return () => window.removeEventListener('hive:renameCompany', onRename)
  }, [])
  useEffect(() => () => void (hoverTimer.current && clearTimeout(hoverTimer.current)), [])

  if (!multi) return null
  const regular = companies.filter((c) => !isPersonal(c))
  const personal = companies.find(isPersonal)

  const armHover = (id: Id, el: HTMLElement): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    const top = el.getBoundingClientRect().top
    hoverTimer.current = setTimeout(() => setHover({ id, top }), 120)
  }
  const disarmHover = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHover(null), 200)
  }
  // PR-47: closing it is final until the pointer comes back (a pending open from the same hover or focus is dropped)
  const closeHover = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    setHover(null)
  }

  const tile = (c: CompanyPassport): React.JSX.Element => {
    const b = byCompany[c.id]
    const draggable = !isPersonal(c)
    const healthy = !!health[c.id]
    const paused = isCompanyPaused(c)
    // E14: the accessible name carries the state; the visible name is the styled hover label (never a native tooltip)
    const title = `${badgeTitle(railName(c), b, railLaurel(c, b, healthy))}${paused ? ' · paused' : ''}`
    return (
      <button
        key={c.id}
        type="button"
        data-company={c.id}
        className={`rail__tile ${active === c.id ? 'is-active' : ''} ${paused ? 'is-paused' : ''} ${b?.working && !b.needsYou ? 'is-working' : ''} ${dragged === c.id ? 'is-dragging' : ''} ${dropAt?.id === c.id ? `rail-drop--${dropAt.placement}` : ''}`}
        aria-label={title}
        aria-current={active === c.id ? 'true' : undefined}
        draggable={draggable}
        onClick={() => {
          closeHover()
          void enterCompany(c.id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          closeHover()
          void companyContextMenu(c)
        }}
        onMouseEnter={(e) => armHover(c.id, e.currentTarget)}
        onMouseLeave={disarmHover}
        // keyboard focus only: a click focuses the tile too, and that must not bring the popover back over the sidebar
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && armHover(c.id, e.currentTarget)}
        onBlur={disarmHover}
        onDragStart={(e) => {
          e.dataTransfer.setData(COMPANY_DRAG_TYPE, c.id)
          e.dataTransfer.effectAllowed = 'move'
          setDragged(c.id)
          closeHover()
        }}
        onDragEnd={() => {
          setDragged(null)
          setDropAt(null)
        }}
        onDragOver={(e) => {
          if (!draggable || !e.dataTransfer.types.includes(COMPANY_DRAG_TYPE)) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          setDropAt({ id: c.id, placement: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
        }}
        onDragLeave={() => setDropAt(null)}
        onDrop={(e) => {
          if (!draggable || !e.dataTransfer.types.includes(COMPANY_DRAG_TYPE)) return
          e.preventDefault()
          const id = e.dataTransfer.getData(COMPANY_DRAG_TYPE)
          const r = e.currentTarget.getBoundingClientRect()
          setDropAt(null)
          setDragged(null)
          if (id && id !== c.id) void reorderCompanies(id, c.id, e.clientY < r.top + r.height / 2 ? 'before' : 'after')
        }}
      >
        <RailMark company={c} badge={b} />
        {b && b.needsYou > 0 && <span className="rail__count">{b.needsYou > 99 ? '99+' : b.needsYou}</span>}
        {/* A4: the paused mark, grey line art; needs-you items raised before the pause still count */}
        {paused && <span className="rail__paused" aria-hidden>‖</span>}
        {/* AUTOPILOT.md §7: a thin ring when Autopilot is on (the same truth as the header chip) */}
        {!paused && <AutopilotMark company={c} />}
      </button>
    )
  }

  return (
    <nav className="rail" ref={railRef} aria-label="Companies">
      <div className="rail__drag drag" />
      <button
        type="button"
        className={`rail__tile rail__tile--all ${active === 'all' ? 'is-active' : ''}`}
        title={`All companies (⌃0)${total.needsYou ? ` · ${total.needsYou} need you` : ''}${total.working ? ` · ${total.working} working` : ''}`}
        aria-label="All companies"
        aria-current={active === 'all' ? 'true' : undefined}
        onClick={() => void enterCompany('all')}
        onContextMenu={(e) => {
          e.preventDefault()
          void allTileMenu()
        }}
      >
        <span className="rail__all">
          <Icon name="grid" size={16} />
        </span>
        {total.needsYou > 0 && <span className="rail__count">{total.needsYou > 99 ? '99+' : total.needsYou}</span>}
        {total.working > 0 && <span className="rail__working-dot" />}
      </button>
      <div className="rail__sep" />
      <div className="rail__list">{regular.map(tile)}</div>
      <div className="rail__bottom">
        {personal && tile(personal)}
        <button type="button" className="rail__tile rail__tile--add" title="New company…" aria-label="New company" onClick={openNewCompany}>
          <span className="rail__all">
            <Icon name="plus" size={14} />
          </span>
        </button>
      </div>
      {hover && (
        <RailPopover
          company={companies.find((c) => c.id === hover.id)}
          top={hover.top}
          onEnter={() => hoverTimer.current && clearTimeout(hoverTimer.current)}
          onLeave={disarmHover}
          onClose={closeHover}
        />
      )}
      {renaming && <RailRename company={companies.find((c) => c.id === renaming.id)} top={renaming.top} onDone={() => setRenaming(null)} />}
    </nav>
  )
}

/** All tile right-click. DEPARTMENTS.md §12: "Pause all agents" turns autopilot off in every company. */
async function allTileMenu(): Promise<void> {
  const id = await nativeMenu([
    { id: 'enter', label: 'Show All Companies' },
    { id: 'new', label: 'New Company…' },
    ...(departmentsOn() ? ([{ type: 'separator' }, { id: 'pauseAgents', label: 'Pause all agents' }] as const) : [])
  ])
  if (id === 'enter') void enterCompany('all')
  if (id === 'new') openNewCompany()
  if (id === 'pauseAgents') void pauseAllAgents()
}

/** Hover: that company's needs-you and working sessions and runs; a click opens the row and enters the company. */
export function RailPopover({ company, top, onEnter, onLeave, onClose }: { company: CompanyPassport | undefined; top: number; onEnter: () => void; onLeave: () => void; onClose: () => void }): React.JSX.Element | null {
  const items = useLiveItems({ working: true, companyId: company?.id })
  // A2: the badge counts the Board's tasks that wait on you too, so the label lists them (live asks are items already)
  const tasks = useStore((s) => s.tasks)
  const ctx = useLaneContext()
  const taskRows = useMemo(() => (company ? needsYouTasks(tasks, ctx, company.id, { skipLiveAsks: true }) : []), [tasks, ctx, company])
  const paused = isCompanyPaused(company)
  // PR-47: Esc closes it, wherever the focus is
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  if (!company) return null
  const shown = items.slice(0, 8)
  const shownTasks = taskRows.slice(0, Math.max(0, 8 - shown.length))
  const more = items.length - shown.length + taskRows.length - shownTasks.length
  const open = (it: LiveItem): void => {
    onClose()
    void openLiveItem(it, { enter: true })
  }
  return (
    <div className="rail-pop" style={{ top: Math.min(top, window.innerHeight - 260) }} onMouseEnter={onEnter} onMouseLeave={onLeave} role="dialog" aria-label={company.name}>
      <div className="rail-pop__head">
        <RailMark company={company} size={20} />
        <span className="rail-pop__name">{companyLabel(company, true)}</span>
        {company.client && <span className="rail-pop__tag">client</span>}
        {paused && <span className="rail-pop__state" title="Nothing in this company starts until you resume it">‖ Paused</span>}
        {!paused && <AutopilotMark company={company} label />}
        <button type="button" className="rail-pop__close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="close" size={12} />
        </button>
      </div>
      {shown.length + shownTasks.length === 0 ? (
        <div className="rail-pop__empty">{paused ? 'Paused. Click to enter and resume.' : 'Nothing running. Click to enter.'}</div>
      ) : (
        <>
          {shownTasks.map(({ task, reason }) => (
            <button
              key={task.id}
              type="button"
              className="rail-pop__row"
              onClick={() => {
                onClose()
                openBoard(company.id, { taskId: task.id })
              }}
            >
              <span className="rail-pop__glyph rail-pop__glyph--needs">◆</span>
              <span className="rail-pop__label">{task.title}</span>
              <span className="rail-pop__detail">{REASON_LABEL[reason]}</span>
            </button>
          ))}
          {shown.map((it) => (
            <button key={it.key} type="button" className="rail-pop__row" onClick={() => open(it)}>
              <span className={`rail-pop__glyph rail-pop__glyph--${it.kind === 'working' ? 'working' : 'needs'}`}>{it.kind === 'working' ? '●' : '◆'}</span>
              <span className="rail-pop__label">{it.title}</span>
              {it.detail && <span className="rail-pop__detail">{it.detail}</span>}
            </button>
          ))}
        </>
      )}
      {more > 0 && <div className="rail-pop__more">{more} more</div>}
    </div>
  )
}

/** A company's coin with its logo (popover head, Portfolio cards); Personal keeps its "P". */
export function CompanyCoin({ company, size = 18, laurel = false }: { company: Pick<CompanyPassport, 'id' | 'name' | 'color' | 'system'>; size?: number; laurel?: boolean }): React.JSX.Element {
  const personal = isPersonal(company)
  const logo = useCompanyLogoUrl(personal ? null : company.id)
  const fit = useLogoFit(logo)
  return <Medallion name={company.name} color={company.color || undefined} size={size} laurel={laurel} initial={personal ? 'P' : undefined} logo={logo} logoFit={fit} />
}

function RailRename({ company, top, onDone }: { company: CompanyPassport | undefined; top: number; onDone: () => void }): React.JSX.Element | null {
  const [v, setV] = useState(company?.name ?? '')
  if (!company) return null
  const commit = (): void => {
    const name = v.trim()
    onDone()
    if (name && name !== company.name) void updateCompany(company.id, { name })
  }
  return (
    <div className="rail-pop rail-pop--rename" style={{ top }}>
      <input
        className="input input--sm"
        autoFocus
        aria-label={`Rename ${company.name}`}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') onDone()
          e.stopPropagation()
        }}
      />
    </div>
  )
}

const NEW_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-other)']

/**
 * Quick create (ONBOARDING.md §1): a name and a colour, opened by `openQuickCompany` (the Start step link "Quick create
 * (just a name)" and the palette entry "New company (name only)"). "+ New company" opens the onboarding flow instead.
 * The slug and folders are made in main.
 */
export function NewCompanySheet(): React.JSX.Element | null {
  const open = useStore((s) => s.newCompanyOpen)
  if (!open) return null
  return <NewCompanyInner />
}
function NewCompanyInner(): React.JSX.Element {
  const [name, setName] = useState('')
  const [color, setColor] = useState(NEW_COLORS[0]!)
  const [busy, setBusy] = useState(false)
  const submit = (): void => {
    if (!name.trim() || busy) return
    setBusy(true)
    void createCompany(name, color).finally(() => setBusy(false))
  }
  return (
    <Sheet title="Quick create" onCancel={closeNewCompany} onPrimary={submit} primaryLabel="Create" primaryDisabled={!name.trim() || busy} width={420}>
      <div className="co-new">
        <CompanyAvatar company={{ name: name || '?', color }} size={40} />
        <div className="co-new__fields">
          <input
            className="input"
            placeholder="Company name"
            aria-label="Company name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <div className="co-new__colors" role="radiogroup" aria-label="Colour">
            {NEW_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={c === color} className={`co-new__swatch ${c === color ? 'is-sel' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
          <div className="text-tertiary co-new__hint">Its repositories, sessions, keys and Passport stay separate from your other companies.</div>
          <div className="text-tertiary co-new__hint">It starts with Auto-start on: agents you set to work on their own start what you assign them. Nothing is assigned yet, so nothing starts. Turn it off from the Autopilot chip.</div>
        </div>
      </div>
    </Sheet>
  )
}

/** "Switched to Acme · Undo" after a cross-company open (§8.4). */
export function CompanySwitchToast(): React.JSX.Element | null {
  const undo = useStore((s) => s.companyUndo)
  if (!undo) return null
  return (
    <div className="co-undo" role="status" aria-live="polite">
      <span>{undo.text}</span>
      <button type="button" className="co-undo__btn" onClick={undoCompanySwitch}>
        Undo
      </button>
      <button type="button" className="co-undo__close" aria-label="Dismiss" onClick={dismissCompanyUndo}>
        <Icon name="close" size={10} />
      </button>
    </div>
  )
}
