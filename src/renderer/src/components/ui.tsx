/** Desktop primitives: 28px controls, 13px text, default cursor, no hand pointers. */
import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AdapterId } from '@shared/types'
import { Icon } from './Icon'
import { relative, tooltipTime } from '../lib/time'
import type { VisualStatus } from '../lib/graph'

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  size?: 'sm' | 'md' | 'lg'
  icon?: string
  kbd?: string
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, kbd, children, className, ...rest },
  ref
) {
  return (
    <button ref={ref} type="button" className={`btn btn--${variant} btn--${size} ${className ?? ''}`} {...rest}>
      {icon && <Icon name={icon} size={14} />}
      {children && <span>{children}</span>}
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  )
})

export function IconButton({ icon, label, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }): React.JSX.Element {
  return (
    <button type="button" className={`icon-btn ${className ?? ''}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={14} />
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return <kbd className="kbd">{children}</kbd>
}

export interface SegItem<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
  title?: string
}
export function Segmented<T extends string>({ items, value, onChange, size = 'md', className }: { items: SegItem<T>[]; value: T; onChange: (v: T) => void; size?: 'sm' | 'md'; className?: string }): React.JSX.Element {
  return (
    <div className={`seg seg--${size} ${className ?? ''}`} role="radiogroup">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="radio"
          aria-checked={it.value === value}
          className={`seg__item ${it.value === value ? 'is-on' : ''}`}
          disabled={it.disabled}
          title={it.title}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }): React.JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch__knob" />
    </button>
  )
}

/** Mac-style numeric field: value + an inside ⌃⌄ pair. ↑/↓ step (⇧ = ×10). No browser spin buttons. */
export function Stepper({ value, min, max, onChange, width = 64, label }: { value: number; min: number; max: number; onChange: (v: number) => void; width?: number; label?: string }): React.JSX.Element {
  const clamp = (v: number): number => Math.min(max, Math.max(min, Math.round(v)))
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const n = Number(draft)
    if (draft.trim() !== '' && !Number.isNaN(n)) onChange(clamp(n))
    setDraft(null)
  }
  return (
    <span className="stepper" style={{ width }}>
      <input
        className="stepper__input"
        type="text"
        inputMode="numeric"
        aria-label={label}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9-]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            setDraft(null)
            onChange(clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)))
          } else if (e.key === 'Enter') commit()
          else if (e.key === 'Escape' && draft !== null) {
            e.stopPropagation()
            setDraft(null)
          }
        }}
      />
      <span className="stepper__btns">
        <button type="button" tabIndex={-1} disabled={value >= max} onMouseDown={(e) => e.preventDefault()} onClick={() => onChange(clamp(value + 1))} aria-label="Increase">
          <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden><path d="M1 4 4 1l3 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button type="button" tabIndex={-1} disabled={value <= min} onMouseDown={(e) => e.preventDefault()} onClick={() => onChange(clamp(value - 1))} aria-label="Decrease">
          <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden><path d="M1 1l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </span>
    </span>
  )
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 24-hour HH:MM field with two segments (the same format as every time Principia prints, DESIGN §9.7).
 * Click or Tab into a segment; ↑/↓ step it, digits type over it, ←/→ or ":" switch segments.
 */
export function TimeField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }): React.JSX.Element {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value)
  const h = m ? Number(m[1]) : 9
  const mi = m ? Number(m[2]) : 0
  const refs = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)]
  const typed = useRef<{ seg: number; text: string }>({ seg: -1, text: '' })
  const set = (nh: number, nm: number): void => onChange(`${pad2(nh)}:${pad2(nm)}`)
  const onKey = (seg: 0 | 1) => (e: React.KeyboardEvent) => {
    const max = seg === 0 ? 23 : 59
    const cur = seg === 0 ? h : mi
    const put = (v: number): void => (seg === 0 ? set(v, mi) : set(h, v))
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      typed.current = { seg: -1, text: '' }
      const step = seg === 1 && e.shiftKey ? 5 : 1
      put((cur + (e.key === 'ArrowUp' ? step : -step) + max + 1) % (max + 1))
    } else if (/^\d$/.test(e.key)) {
      e.preventDefault()
      const t = typed.current.seg === seg ? typed.current.text + e.key : e.key
      const n = Math.min(max, Number(t))
      put(n)
      if (t.length >= 2 || n * 10 > max) {
        typed.current = { seg: -1, text: '' }
        if (seg === 0) refs[1]!.current?.focus()
      } else typed.current = { seg, text: t }
    } else if ((e.key === 'ArrowRight' || e.key === ':') && seg === 0) {
      e.preventDefault()
      refs[1]!.current?.focus()
    } else if (e.key === 'ArrowLeft' && seg === 1) {
      e.preventDefault()
      refs[0]!.current?.focus()
    } else if (e.key === 'Backspace') {
      e.preventDefault()
      typed.current = { seg: -1, text: '' }
      put(0)
    }
  }
  return (
    <span className="timefield" role="group" aria-label={label ?? 'Time'} onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), refs[0]!.current?.focus())}>
      <span ref={refs[0]} className="timefield__seg" tabIndex={0} role="spinbutton" aria-label="Hour" aria-valuenow={h} aria-valuemin={0} aria-valuemax={23} onKeyDown={onKey(0)} onBlur={() => (typed.current = { seg: -1, text: '' })}>
        {pad2(h)}
      </span>
      <span className="timefield__sep">:</span>
      <span ref={refs[1]} className="timefield__seg" tabIndex={0} role="spinbutton" aria-label="Minute" aria-valuenow={mi} aria-valuemin={0} aria-valuemax={59} onKeyDown={onKey(1)} onBlur={() => (typed.current = { seg: -1, text: '' })}>
        {pad2(mi)}
      </span>
    </span>
  )
}

/** Textarea that grows with its content (no resize grip), capped at maxRows then scrolls. */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxRows?: number }>(function AutoTextarea(
  { minRows = 3, maxRows = 14, className, value, ...rest },
  fwd
) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 19
    const padY = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom) + 2
    el.style.height = 'auto'
    const h = Math.min(maxRows * lh + padY, Math.max(minRows * lh + padY, el.scrollHeight + 2))
    el.style.height = `${h}px`
    el.style.overflowY = el.scrollHeight + 2 > h ? 'auto' : 'hidden'
  }, [value, minRows, maxRows])
  return (
    <textarea
      ref={(el) => {
        ref.current = el
        if (typeof fwd === 'function') fwd(el)
        else if (fwd) fwd.current = el
      }}
      className={`input textarea textarea--auto ${className ?? ''}`}
      value={value}
      {...rest}
    />
  )
})

export function StatusDot({ status, title }: { status: VisualStatus; title?: string }): React.JSX.Element {
  return <span className={`status-dot status-dot--${status}`} title={title ?? status} />
}

const GLYPH: Record<VisualStatus, string> = {
  idle: '○',
  queued: '○',
  running: '●',
  passed: '✓',
  failed: '✕',
  canceled: '⊘',
  scheduled: '◷',
  exited: '○'
}
export function StatusGlyph({ status }: { status: VisualStatus }): React.JSX.Element {
  return <span className={`glyph glyph--${status} ${status === 'running' ? 'status-dot--running' : ''}`}>{GLYPH[status]}</span>
}

export function Pill({ tone = 'idle', children, title }: { tone?: VisualStatus | 'warning' | 'accent'; children: ReactNode; title?: string }): React.JSX.Element {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      {children}
    </span>
  )
}

export function ProviderDot({ adapter }: { adapter: AdapterId | null }): React.JSX.Element | null {
  if (!adapter) return null
  return <span className="provider-dot" style={{ background: `var(--provider-${adapter})` }} />
}

export function EmptyState({ icon = 'file', text, children, compact }: { icon?: string; text: ReactNode; children?: ReactNode; compact?: boolean }): React.JSX.Element {
  return (
    <div className={`empty ${compact ? 'empty--compact' : ''}`}>
      {!compact && <Icon name={icon} size={32} className="empty__icon" />}
      <div className="empty__text">{text}</div>
      {children && <div className="empty__actions">{children}</div>}
    </div>
  )
}

/** Shows nothing for 150 ms, then a 1-line spinner (DESIGN §9.3). */
export function Loading({ label = 'Loading…' }: { label?: string }): React.JSX.Element | null {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 150)
    return () => clearTimeout(t)
  }, [])
  if (!show) return null
  return (
    <div className="loading">
      <span className="spinner" /> {label}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <EmptyState icon="warning" text={<span className="text-failed selectable">{error}</span>}>
      {onRetry && <Button onClick={onRetry}>Try Again</Button>}
    </EmptyState>
  )
}

/** Shared 15 s tick for relative times (the only renderer interval, DESIGN §9.2). */
const tickListeners = new Set<() => void>()
let tickTimer: ReturnType<typeof setInterval> | null = null
export function useTick(ms = 15_000): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const l = (): void => setN((x) => x + 1)
    tickListeners.add(l)
    if (!tickTimer) tickTimer = setInterval(() => tickListeners.forEach((f) => f()), ms)
    return () => {
      tickListeners.delete(l)
      if (tickListeners.size === 0 && tickTimer) {
        clearInterval(tickTimer)
        tickTimer = null
      }
    }
  }, [ms])
  return n
}

export function RelativeTime({ iso }: { iso: string | null | undefined }): React.JSX.Element {
  useTick()
  return <span title={tooltipTime(iso)}>{relative(iso)}</span>
}

export function SectionHeader({ title, count, children }: { title: string; count?: ReactNode; children?: ReactNode }): React.JSX.Element {
  return (
    <div className="section-header">
      <span className="section-header__title">{title}</span>
      {count !== undefined && <span className="section-header__count">{count}</span>}
      <span className="flex1" />
      {children}
    </div>
  )
}

/** Mac-style sheet: slides down from the toolbar edge of the main area. Esc = cancel, ⌘↵ = primary. */
export function Sheet({
  title,
  children,
  onCancel,
  onPrimary,
  primaryLabel = 'Save',
  primaryDisabled,
  primaryTitle,
  footerLeft,
  width,
  destructive,
  cancelLabel = 'Cancel'
}: {
  title: string
  children: ReactNode
  onCancel: () => void
  onPrimary?: () => void
  primaryLabel?: string
  primaryDisabled?: boolean
  primaryTitle?: string
  footerLeft?: ReactNode
  width?: number
  destructive?: boolean
  /** the secondary footer button ("Done" when there is nothing to cancel) */
  cancelLabel?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      } else if (e.key === 'Enter' && e.metaKey && onPrimary && !primaryDisabled) {
        e.preventDefault()
        e.stopPropagation()
        onPrimary()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel, onPrimary, primaryDisabled])
  // E13: a sheet takes focus when it opens, so Enter confirms and focus never stays on the button behind it. The
  // first field when there is one; else the primary button (Enter = it), or Cancel for a destructive sheet; else the
  // sheet itself, so keys go to the sheet and not to the page
  useEffect(() => {
    const box = ref.current
    if (!box) return
    const field = box.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]):not([disabled]), textarea, select')
    const primary = box.querySelector<HTMLButtonElement>('.sheet__footer [data-sheet-primary]:not(:disabled)')
    const cancel = box.querySelector<HTMLButtonElement>('.sheet__footer [data-sheet-cancel]')
    const el = field ?? (destructive ? cancel : (primary ?? cancel)) ?? box
    el.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="sheet-layer" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="sheet" ref={ref} tabIndex={-1} style={width ? { width } : undefined} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet__title">{title}</div>
        <div className="sheet__body">{children}</div>
        <div className="sheet__footer">
          <div className="sheet__footer-left">{footerLeft}</div>
          <Button onClick={onCancel} data-sheet-cancel="">
            {cancelLabel}
          </Button>
          {onPrimary && (
            <Button variant={destructive ? 'destructive' : 'primary'} onClick={onPrimary} disabled={primaryDisabled} title={primaryTitle} kbd="⌘↵" data-sheet-primary="">
              {primaryLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export function Field({ label, children, hint, error, align = 'center' }: { label: ReactNode; children: ReactNode; hint?: ReactNode; error?: ReactNode; align?: 'center' | 'start' }): React.JSX.Element {
  return (
    <div className={`field field--${align}`}>
      <label className="field__label">{label}</label>
      <div className="field__control">
        {children}
        {error ? <div className="field__error">{error}</div> : hint ? <div className="field__hint">{hint}</div> : null}
      </div>
    </div>
  )
}

export function Toolbar({ title, left, children, sub }: { title?: ReactNode; left?: ReactNode; children?: ReactNode; sub?: ReactNode }): React.JSX.Element {
  return (
    <header className="toolbar drag">
      {left}
      {title !== undefined && <div className="toolbar__title">{title}</div>}
      {sub}
      <div className="flex1" />
      <div className="toolbar__actions">{children}</div>
    </header>
  )
}

export function Disclosure({ label, children, defaultOpen = false }: { label: string; children: ReactNode; defaultOpen?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="disclosure">
      <button type="button" className="disclosure__btn" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /> {label}
      </button>
      {open && <div className="disclosure__body">{children}</div>}
    </div>
  )
}

/** Small anchored popover (autocomplete, After picker). Closes on outside click / Esc. */
export function Popover({ anchor, onClose, children, width = 240 }: { anchor: DOMRect | null; onClose: () => void; children: ReactNode; width?: number }): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  if (!anchor) return null
  const left = Math.min(anchor.left, window.innerWidth - width - 8)
  const top = anchor.bottom + 4
  return (
    <div className="popover" ref={ref} style={{ left, top, width }}>
      {children}
    </div>
  )
}
