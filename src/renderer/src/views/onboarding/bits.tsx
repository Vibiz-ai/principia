/**
 * Onboarding building blocks (docs/ONBOARDING.md §9, VOICE.md §5.7): ChoiceCard, ChipGroup, VibeCard, ScanChip,
 * KeyField, PlanDepartmentCard (a charter section), PlanRow, NextSteps, the step title and kicker, and the team plinths.
 * Styles in styles/onboarding.css; the Roman line art (stroke tiers, corner lozenges) in styles/roman.css.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { autonomyPhrase } from '../../lib/desk'
import type { AdapterId } from '@shared/types'
import {
  KEY_PROVIDERS,
  WORKFLOW_KEYS,
  type KeyCheckResult,
  type KeyProvider,
  type OnboardingPlan,
  type PlanAgent,
  type PlanSchedule,
  type PlanTask,
  type RepoScanSummary
} from '@shared/onboarding'
import { siteHost } from '@shared/onboardingPlan'
import { Button, Segmented, Switch } from '../../components/ui'
import { Laurel, Plinth, meander } from '../../components/roman'
import { seatInitials } from '../../lib/departments'
import { errorMessage, hive } from '../../lib/hive'
import { t, useCopy, type CopyKey, type Vars } from '../../lib/voice'
import { openLink } from './actions'
import { cadenceSentence, dependencyHint, gridMove, planCostLine, presetFor, rowKey, type PlanGroup, type PlanRowId, type TeamMember } from './model'

// ---------- chip ----------

export type ChipTone = 'neutral' | 'ok' | 'warn' | 'accent' | 'sched' | 'fail'
export function Chip({ tone = 'neutral', children, title }: { tone?: ChipTone; children: ReactNode; title?: string }): React.JSX.Element {
  return (
    <span className={`ob-chip ob-chip--${tone}`} title={title}>
      {children}
    </span>
  )
}

// ---------- ChoiceCard (radio group, roving tabindex) ----------

export interface Choice<T extends string> {
  value: T
  title: string
  desc: string
  /** a key hint on the card (five doors step 5 shows none on Start: arrows and ↵ still work) */
  kbd?: string
}

/** ←/→ or 1/2 move the choice, the card's letter picks it; ↵ is left to the flow (continue). */
export function ChoiceGroup<T extends string>({ choices, value, onChange, label, className }: { choices: Choice<T>[]; value: T | null; onChange: (v: T) => void; label: string; className?: string }): React.JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const at = Math.max(
    0,
    choices.findIndex((c) => c.value === value)
  )
  const onKey = (e: React.KeyboardEvent, i: number): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    let to: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = Math.min(choices.length - 1, i + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = Math.max(0, i - 1)
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= choices.length) to = Number(e.key) - 1
    else if (e.key === ' ') to = i
    if (to === null) return
    e.preventDefault()
    onChange(choices[to]!.value)
    refs.current[to]?.focus()
  }
  return (
    <div className={`ob-choices ${className ?? ''}`} role="radiogroup" aria-label={label}>
      {choices.map((c, i) => {
        const sel = c.value === value
        return (
          <button
            key={c.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={sel}
            tabIndex={i === at ? 0 : -1}
            data-autofocus={i === at ? '' : undefined}
            className={`ob-choice ${sel ? 'is-sel' : ''}`}
            data-enter-primary=""
            onClick={() => onChange(c.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {c.kbd && <span className="ob-kbd ob-choice__kbd">{c.kbd}</span>}
            <span className="ob-choice__title">{c.title}</span>
            <span className="ob-choice__desc">{c.desc}</span>
          </button>
        )
      })}
    </div>
  )
}

// ---------- ChipGroup (multi-select, number keys, aria-pressed) ----------

export interface ChipItem<T extends string> {
  value: T
  label: string
  disabled?: boolean
  title?: string
}

export function ChipGroup<T extends string>({ items, selected, onToggle, label }: { items: ChipItem<T>[]; selected: readonly T[]; onToggle: (v: T) => void; label: string }): React.JSX.Element {
  return (
    <div className="ob-chips" role="group" aria-label={label}>
      {items.map((it, i) => {
        const on = selected.includes(it.value)
        return (
          <button
            key={it.value}
            type="button"
            className={`ob-gchip ${on ? 'is-sel' : ''}`}
            data-enter-primary=""
            aria-pressed={on}
            disabled={it.disabled}
            title={it.title}
            data-autofocus={i === 0 ? '' : undefined}
            onClick={() => onToggle(it.value)}
          >
            <span className="ob-kbd">{i + 1}</span>
            {it.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------- VibeCard grid (3×2, arrows, 1–6) ----------

export interface VibeItem<T extends string> {
  value: T
  label: string
  sample: string
}

export function VibeGrid<T extends string>({ items, value, onChange }: { items: VibeItem<T>[]; value: T | null; onChange: (v: T) => void }): React.JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const at = Math.max(
    0,
    items.findIndex((v) => v.value === value)
  )
  const onKey = (e: React.KeyboardEvent, i: number): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const to = gridMove(i, e.key, items.length, 3)
    if (to === null) return
    e.preventDefault()
    onChange(items[to]!.value)
    refs.current[to]?.focus()
  }
  return (
    <div className="ob-vibes" role="radiogroup" aria-label="Voice">
      {items.map((v, i) => (
        <VibeCard
          key={v.value}
          item={v}
          index={i}
          selected={v.value === value}
          tabbable={i === at}
          onPick={() => onChange(v.value)}
          onKeyDown={(e) => onKey(e, i)}
          btnRef={(el) => {
            refs.current[i] = el
          }}
        />
      ))}
    </div>
  )
}

export function VibeCard<T extends string>({
  item,
  index,
  selected,
  tabbable,
  onPick,
  onKeyDown,
  btnRef
}: {
  item: VibeItem<T>
  index: number
  selected: boolean
  tabbable: boolean
  onPick: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  btnRef: (el: HTMLButtonElement | null) => void
}): React.JSX.Element {
  return (
    <button
      ref={btnRef}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabbable ? 0 : -1}
      data-autofocus={tabbable ? '' : undefined}
      className={`ob-vibe ${selected ? 'is-sel' : ''}`}
      data-enter-primary=""
      onClick={onPick}
      onKeyDown={onKeyDown}
    >
      <span className="ob-vibe__head">
        {item.label} <span className="ob-kbd">{index + 1}</span>
      </span>
      <span className="ob-vibe__sample">“{item.sample}”</span>
    </button>
  )
}

// ---------- ScanChip ----------

/** "Reading acme-web…" → "Next.js · Stripe · acme.com ✓". */
export function scanChipText(r: RepoScanSummary | undefined, pending: boolean, label: string): { text: string; tone: ChipTone } {
  if (!r) return pending ? { text: `Reading ${label}…`, tone: 'neutral' } : { text: 'Not read', tone: 'neutral' }
  const host = siteHost(r.homepage) ?? (r.cname ? siteHost(r.cname) : null)
  const facts = [...r.stack.slice(0, 2), ...(host ? [host] : [])]
  if (!facts.length && r.primaryLanguage) facts.push(r.primaryLanguage)
  return { text: facts.length ? `${facts.join(' · ')} ✓` : 'Read ✓', tone: 'ok' }
}

export function ScanChip({ repo, pending, label }: { repo: RepoScanSummary | undefined; pending: boolean; label: string }): React.JSX.Element {
  const { text, tone } = scanChipText(repo, pending, label)
  return <Chip tone={tone}>{text}</Chip>
}

// ---------- KeyField (password input; the value lives only here) ----------

export interface KeyFieldProps {
  provider: KeyProvider
  onProvider: (p: KeyProvider) => void
  /** The check came back; the value is already cleared from the field. Only the result leaves this component. */
  onChecked: (provider: KeyProvider, result: KeyCheckResult) => void
  /** What the draft remembers about a checked key (no value). */
  kept: { last4?: string; inUse: boolean; pendingUnknown: boolean; restarted: boolean }
  onUseAnyway: () => void
  onDismiss: () => void
}

const KEY_LINKS: Record<KeyProvider, { label: string; url: string }> = {
  fal: { label: 'Get a fal key ↗', url: 'https://fal.ai/dashboard/keys' },
  openai: { label: 'Get an OpenAI key ↗', url: 'https://platform.openai.com/api-keys' }
}

/**
 * §2 S5 "Use my own key". The typed value is component state only: it goes to `onboarding:key` once and the field
 * clears right after, whatever the result. It is never put in the store, the draft or localStorage.
 */
export function KeyField({ provider, onProvider, onChecked, kept, onUseAnyway, onDismiss }: KeyFieldProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ status: KeyCheckResult['status']; detail?: string; last4?: string; provider: KeyProvider } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )
  const check = async (): Promise<void> => {
    const v = value.trim()
    if (!v || busy) return
    setBusy(true)
    setError(null)
    // the value leaves component state here, once; the field clears whatever happens
    setValue('')
    try {
      const res = await hive.onboarding.key({ op: 'check', name: KEY_PROVIDERS[provider], value: v })
      if (!alive.current) {
        // the step was left (Esc, Continue) mid-check: nothing holds this handle, so the key must not linger in main
        if (res.stashId) void hive.onboarding.key({ op: 'forget', stashIds: [res.stashId] }).catch(() => undefined)
        return
      }
      setResult({ status: res.status, detail: res.detail, last4: res.last4, provider })
      onChecked(provider, res)
    } catch (e) {
      if (alive.current) setError(errorMessage(e))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const label = provider === 'fal' ? 'fal' : 'OpenAI'
  const status = result?.provider === provider ? result.status : kept.inUse ? 'valid' : kept.pendingUnknown ? 'unknown' : null
  const last4 = result?.provider === provider ? result.last4 : kept.last4
  return (
    <div className="ob-keyfield">
      <Segmented<KeyProvider>
        size="sm"
        items={[
          { value: 'fal', label: 'fal (recommended · 9 workflows)' },
          { value: 'openai', label: 'OpenAI (1 workflow)' }
        ]}
        value={provider}
        onChange={(p) => {
          setResult(null)
          onProvider(p)
        }}
      />
      <div className="ob-keyfield__row">
        <input
          className="input ob-keyfield__input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={`${label} key`}
          placeholder={kept.restarted ? 'Paste the key again' : `Paste your ${label} key`}
          value={value}
          data-enter-local=""
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // ↵ checks a typed key; on an empty field it continues (the flow's primary)
            if (e.key === 'Enter' && !e.metaKey && value.trim()) {
              e.preventDefault()
              void check()
            }
          }}
        />
        <Button onClick={() => void check()} disabled={!value.trim() || busy}>
          {busy ? 'Checking…' : 'Check & save'}
        </Button>
      </div>
      <div className="ob-keyfield__result" role="status" aria-live="polite">
        {error ? (
          <Chip tone="fail">{error}</Chip>
        ) : status === 'valid' ? (
          <Chip tone="ok">✓ Works{last4 ? ` · ends in ${last4}` : ''}</Chip>
        ) : status === 'invalid' ? (
          <Chip tone="fail">{result?.provider === provider && result.detail === 'format' ? `That doesn’t look like a ${label} key` : `${label} rejected this key`}</Chip>
        ) : status === 'unknown' ? (
          <>
            <Chip tone="warn">{result?.provider === provider && result.detail === 'offline' ? 'Couldn’t check (offline).' : 'Couldn’t check this key automatically.'}</Chip>
            {kept.inUse ? null : (
              <>
                <Button size="sm" onClick={onUseAnyway}>
                  Use anyway
                </Button>
                <Button size="sm" variant="ghost" onClick={onDismiss}>
                  Dismiss
                </Button>
              </>
            )}
          </>
        ) : kept.restarted ? (
          <span className="ob-hint">Paste the key again. For your safety we don't keep keys until launch.</span>
        ) : null}
      </div>
      <div className="ob-hint">
        Saved encrypted for this business only when you launch. We don't keep it in the draft.{' '}
        <button type="button" className="link-btn" onClick={() => openLink(KEY_LINKS[provider].url)}>
          {KEY_LINKS[provider].label}
        </button>
      </div>
    </div>
  )
}

// ---------- plan cards ----------

export interface PlanRowHandlers {
  focused: string | null
  editing: string | null
  onFocus: (row: PlanRowId) => void
  onToggle: (row: PlanRowId) => void
  onRemove: (row: PlanRowId) => void
  onStartRename: (row: PlanRowId) => void
  onRename: (row: PlanRowId, name: string) => void
  onCancelRename: () => void
  onKeyDown: (e: React.KeyboardEvent, row: PlanRowId) => void
}

function RenameInput({ initial, onDone, onCancel, label, maxLength }: { initial: string; onDone: (v: string) => void; onCancel: () => void; label: string; maxLength?: number }): React.JSX.Element {
  const [v, setV] = useState(initial)
  const done = useRef(false)
  return (
    <input
      className="input input--sm ob-rename"
      aria-label={label}
      autoFocus
      maxLength={maxLength}
      value={v}
      data-enter-local=""
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && !e.metaKey) {
          e.preventDefault()
          done.current = true
          onDone(v)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          done.current = true
          onCancel()
        }
      }}
      onBlur={() => {
        if (!done.current) onDone(v)
      }}
    />
  )
}

export function PlanRow({
  row,
  label,
  name,
  include,
  lead,
  end,
  sub,
  h,
  canToggle = true,
  removable = false
}: {
  row: PlanRowId
  label: string
  name: string
  include: boolean
  lead?: ReactNode
  end?: ReactNode
  sub?: ReactNode
  h: PlanRowHandlers
  canToggle?: boolean
  removable?: boolean
}): React.JSX.Element {
  const key = rowKey(row)
  const editing = h.editing === key
  return (
    <div
      className={`ob-prow ${h.focused === key ? 'is-focus' : ''} ${include ? '' : 'is-off'}`}
      role="row"
      tabIndex={h.focused === key ? 0 : -1}
      data-row={key}
      aria-label={`${label}: ${name}${include ? '' : ' (off)'}`}
      onFocus={(e) => e.target === e.currentTarget && h.onFocus(row)}
      onKeyDown={(e) => !editing && h.onKeyDown(e, row)}
      onDoubleClick={() => h.onStartRename(row)}
    >
      <span className="ob-prow__lab">{label}</span>
      {canToggle && row.kind === 'task' && (
        <input type="checkbox" className="ob-cb" checked={include} aria-label={`Include ${name}`} tabIndex={-1} onChange={() => h.onToggle(row)} />
      )}
      {lead}
      <span className="ob-prow__main">
        {editing ? (
          <RenameInput initial={name} label={`Rename ${name}`} onDone={(v) => h.onRename(row, v)} onCancel={h.onCancelRename} />
        ) : (
          <span className="ob-prow__name">{name}</span>
        )}
        {sub && !editing && <span className="ob-prow__sub">{sub}</span>}
      </span>
      <span className="ob-prow__end">
        {end}
        {canToggle && row.kind === 'agent' && <Switch checked={include} onChange={() => h.onToggle(row)} label={`Include ${name}`} />}
        {canToggle && row.kind === 'schedule' && (
          <input type="checkbox" className="ob-cb" checked={include} aria-label={`Include ${name}`} tabIndex={-1} onChange={() => h.onToggle(row)} />
        )}
        {removable && (
          <button type="button" className="ob-x" tabIndex={-1} aria-label={`Remove ${name}`} onClick={() => h.onRemove(row)}>
            ×
          </button>
        )}
      </span>
    </div>
  )
}

const ROLE_LINE: Record<PlanAgent['role'], string> = {
  developer: 'Audits the code and proposes fixes. No pushes.',
  builder: 'Drafts pages and files in the business folder.',
  content: 'Writes drafts in your voice. Never publishes.',
  researcher: 'Researches and drafts. Asks before acting.',
  support: 'Drafts replies and help docs. Asks before acting.',
  generalist: 'Plans and drafts. Asks before acting.'
}

function scheduleSentence(s: PlanSchedule): string {
  return `${s.name} · ${cadenceSentence(s.cadence)}`
}

export function PlanDepartmentCard({ group, plan, h }: { group: PlanGroup; plan: OnboardingPlan; h: PlanRowHandlers }): React.JSX.Element {
  const dept = group.key ? plan.departments.find((d) => d.key === group.key) : undefined
  const preset = group.key ? presetFor(group.key) : undefined
  const off = !!dept && !dept.include
  const charter = dept?.charter?.does ?? preset?.data.charter?.does ?? ''
  const deptRow: PlanRowId | null = group.key ? { kind: 'department', ref: group.key } : null
  const deptKey = deptRow ? rowKey(deptRow) : null
  return (
    <section className={`ob-dept ob-dept--charter ${off ? 'is-off' : ''}`} aria-label={dept?.name ?? 'Company'}>
      <div
        className={`ob-dept__head ${deptKey && h.focused === deptKey ? 'is-focus' : ''}`}
        role={deptRow ? 'row' : undefined}
        tabIndex={deptRow ? (h.focused === deptKey ? 0 : -1) : undefined}
        data-row={deptKey ?? undefined}
        onFocus={(e) => deptRow && e.target === e.currentTarget && h.onFocus(deptRow)}
        onKeyDown={(e) => deptRow && h.editing !== deptKey && h.onKeyDown(e, deptRow)}
        onDoubleClick={() => deptRow && h.onStartRename(deptRow)}
      >
        <span className="ob-dept__ico" aria-hidden>
          <Laurel variant="sprig" size={18} />
        </span>
        {deptRow && h.editing === deptKey ? (
          <RenameInput initial={dept!.name} label={`Rename ${dept!.name}`} onDone={(v) => h.onRename(deptRow, v)} onCancel={h.onCancelRename} />
        ) : (
          <span className="ob-dept__name rm-display">{dept?.name ?? 'Company'}</span>
        )}
        <span className="ob-dept__charter" title={charter}>
          {group.key ? charter : 'No department'}
        </span>
        {deptRow && dept && <Switch checked={dept.include} onChange={() => h.onToggle(deptRow)} label={`Include ${dept.name}`} />}
      </div>
      {group.agents.map((a) => (
        <PlanRow
          key={a.ref}
          row={{ kind: 'agent', ref: a.ref }}
          label="Agent"
          name={a.name}
          include={a.include}
          lead={<span className="provider-dot" style={{ background: `var(--provider-${a.adapter as AdapterId})` }} />}
          sub={ROLE_LINE[a.role]}
          // five doors §2.7: the same phrase the Team card and the agent page show for this agent
          end={<Chip tone={a.auto ? 'ok' : 'neutral'}>{autonomyPhrase({ auto: a.auto, role: `${a.name} ${a.role}`, department: dept?.name ?? null })}</Chip>}
          h={h}
        />
      ))}
      {group.tasks.map((t: PlanTask) => {
        const dep = dependencyHint(plan, t)
        return (
          <PlanRow
            key={t.ref}
            row={{ kind: 'task', ref: t.ref }}
            label="Task"
            name={t.title}
            include={t.include}
            end={dep ? <Chip>{dep}</Chip> : t.where === 'repo' ? <Chip>repo</Chip> : null}
            removable
            h={h}
          />
        )
      })}
      {group.schedules.map((s) => {
        const cost = planCostLine(s)
        const free = s.target.kind === 'workflow' && !WORKFLOW_KEYS[s.target.workflow].costly
        return (
          <PlanRow
            key={s.ref}
            row={{ kind: 'schedule', ref: s.ref }}
            label="Schedule"
            name={scheduleSentence(s)}
            include={s.include}
            end={
              <>
                {cost ? <Chip tone="warn">{cost}</Chip> : free ? <Chip>On your Claude plan</Chip> : null}
                <Chip tone="sched">Off until you start</Chip>
              </>
            }
            removable
            h={h}
          />
        )
      })}
    </section>
  )
}

// ---------- NextSteps ----------

export function NextSteps({ items }: { items: string[] }): React.JSX.Element {
  return (
    <div className="ob-next">
      <div className="ob-next__title">What happens next</div>
      <ol>
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ol>
    </div>
  )
}

// ---------- stage bits (VOICE.md §5.7) ----------

/**
 * A copy entry as the founder sees it, read plain (VOICE.md §2, §9: screen readers always get t.sr, also in playful).
 * When the tone changes the words, the visible form is aria-hidden and a visually hidden plain twin carries the meaning.
 */
export function Voiced({ k, vars }: { k: CopyKey; vars?: Vars }): React.JSX.Element {
  const copy = useCopy()
  const shown = copy(k, vars)
  const plain = t.sr(k, vars)
  if (shown === plain) return <>{shown}</>
  return (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className="ob-sr">{plain}</span>
    </>
  )
}

/** A Cinzel kicker above a title, with a stroked sprig ("The founding charter"). Decorative sprig, readable text. */
export function Kicker({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="ob-kicker">
      <Laurel variant="sprig" size={22} />
      <span>{children}</span>
    </div>
  )
}

/**
 * The step's h1 (focused on every step change; the polite live region reads the plain twin). Cinzel 26 px, 34 px for
 * the first-run welcome; body, inputs and buttons stay Geist.
 */
export function StepTitle({ children, kicker, welcome, className }: { children: ReactNode; kicker?: ReactNode; welcome?: boolean; className?: string }): React.JSX.Element {
  return (
    <>
      {kicker ? <Kicker>{kicker}</Kicker> : null}
      <h1 className={['ob-title', 'rm-display', welcome ? 'ob-title--welcome' : '', className ?? ''].filter(Boolean).join(' ')} data-ob-title tabIndex={-1}>
        {children}
      </h1>
    </>
  )
}

/** True once `active` has held for `ms` (Latin on long waits only appears after about 2 s, VOICE.md §3.9). */
export function useAfter(ms: number, active: boolean): boolean {
  const [past, setPast] = useState(false)
  useEffect(() => {
    if (!active) {
      setPast(false)
      return
    }
    const id = setTimeout(() => setPast(true), ms)
    return () => clearTimeout(id)
  }, [ms, active])
  return active && past
}

/** prefers-reduced-motion: reduce. Read once at mount (and on change), false where matchMedia is missing. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = (): void => setReduced(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

// ---------- charter ornaments (VOICE.md §5.2, §5.7) ----------

/** The four corner lozenges breaking a double-rule frame (roman.css `.rm-cn`); the parent is `position: relative`. */
export function Corners(): React.JSX.Element {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <i key={i} className={`rm-cn rm-cn${i}`} aria-hidden="true" />
      ))}
    </>
  )
}

const MEANDER = meander(240)

/** A Greek-key divider (12-unit repeat, `--rm-ln-2` over a `--rm-ln-3` base), centred: a section break, never a border. */
export function MeanderRule({ className }: { className?: string }): React.JSX.Element {
  return (
    <div className={['ob-meander', className].filter(Boolean).join(' ')} aria-hidden="true">
      <svg
        className="rm-la"
        viewBox={`0 0 ${MEANDER.w} ${MEANDER.h}`}
        width={MEANDER.w}
        height={MEANDER.h}
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {MEANDER.paths.map((p) => (
          <path key={p.d} d={p.d} strokeOpacity={p.o} />
        ))}
      </svg>
    </div>
  )
}

// ---------- team plinths (VOICE.md §4.4, §5.7) ----------

/** Personas off: the old department-colour initials in place of the bust (SeatAvatar style). */
export function InitialsAvatar({ name, color, size }: { name: string; color: string | null; size: number }): React.JSX.Element {
  return (
    <span className="seat-avatar ob-initials" style={{ width: size, height: size, background: color ?? 'var(--series-other)', fontSize: Math.max(8, Math.round(size * 0.4)) }} aria-hidden>
      {seatInitials(name)}
    </span>
  )
}

/**
 * One team member on a drawn plinth: the line bust and lettered name with personas on; with them off, initials and the
 * role label (nothing else changes). `children` go under the role line (personality, first task, switches). The plinth is
 * the same line drawing on every dark surface (charter and ceremony), so there is no surface variant.
 */
export function TeamPlinth({
  member,
  color,
  size,
  className,
  style,
  role,
  children
}: {
  member: TeamMember
  /** the line under the name; defaults to "Copywriter · Marketing" */
  role?: string
  color: string | null
  size: number
  className?: string
  style?: CSSProperties
  children?: ReactNode
}): React.JSX.Element {
  if (member.persona) {
    return (
      <div className={['ob-plinth', className].filter(Boolean).join(' ')} style={style}>
        <Plinth persona={member.persona} role={role ?? member.roleLine} size={size}>
          {children}
        </Plinth>
      </div>
    )
  }
  return (
    <div className={['ob-plinth', className].filter(Boolean).join(' ')} style={style}>
      <div className="rm-plinth ob-plinth--plain">
        <InitialsAvatar name={member.role} color={color} size={size} />
        <div className="ob-plinth__name" title={member.role}>{member.role}</div>
        {member.department && <div className="rm-plinth__role">{member.department}</div>}
        {children}
      </div>
    </div>
  )
}

/** A plinth's name renamed in place (↵ saves, Esc cancels, blur saves): the persona (24) or, personas off, the role (40). */
export function PersonaRename({ initial, label, onDone, onCancel, maxLength }: { initial: string; label: string; onDone: (v: string) => void; onCancel: () => void; maxLength: number }): React.JSX.Element {
  return <RenameInput initial={initial} label={label} onDone={onDone} onCancel={onCancel} maxLength={maxLength} />
}
