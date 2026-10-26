/**
 * AUTOPILOT.md §7-§8: "is Autopilot on?" always in view, and "what is it doing?" one click away. A small chip next to
 * Running / Paused in the company header; clicking it opens the Autopilot panel for this company, in plain words: who
 * starts work on their own, what they start next and why it waits, which schedules run and when, what is on autopilot
 * (playbooks with level and limits), the limits, what it did lately, and the Auto-start switch. The chip's words come
 * from shared/autopilotState (the same truth Home, the rail, the All companies cards and the phone read); the panel
 * from playbooks:overview (shared/autopilotOverview).
 */
import { useEffect, useMemo, useState } from 'react'
import type { CompanyPassport } from '@shared/company'
import { AUTO_START, AUTOPILOT_WHAT, autopilotLimits, autopilotState, chipLabel, chipShort, type AutopilotState } from '@shared/autopilotState'
import { whenShort, type AutopilotOverview } from '@shared/autopilotOverview'
import { isPlaybookId, playbookDef } from '@shared/autopilotPlaybooks'
import { Popover, Switch } from '../ui'
import { hive } from '../../lib/hive'
import { enterCompany, setCompanyAutopilot, useStore } from '../../state/store'
import '../../styles/autopilot.css'

type Row = Pick<CompanyPassport, 'id' | 'autopilot' | 'pausedAt' | 'maxInFlight' | 'monthlyCap' | 'archivedAt'>

/** The company's Autopilot state: its switch and the playbooks on (one truth for every surface). */
export function useAutopilotState(company: Row | null | undefined): AutopilotState {
  const list = useStore((s) => (company ? s.playbooksOn[company.id] : undefined))
  return useMemo(
    () => autopilotState(company, (list ?? []).filter((p) => isPlaybookId(p.id)).map((p) => ({ name: playbookDef(p.id).short, running: p.running, waiting: p.waiting }))),
    [company, list]
  )
}

/** "2 h ago", "yesterday", "Mon" */
function ago(iso: string, now = Date.now()): string {
  const m = Math.round((now - new Date(iso).getTime()) / 60_000)
  if (!Number.isFinite(m)) return ''
  if (m < 60) return `${Math.max(1, m)} min ago`
  if (m < 24 * 60) return `${Math.round(m / 60)} h ago`
  if (m < 48 * 60) return 'yesterday'
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short' })
}

export function AutopilotChip({ company }: { company: CompanyPassport }): React.JSX.Element {
  const st = useAutopilotState(company)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [busy, setBusy] = useState(false)
  const [ov, setOv] = useState<AutopilotOverview | null>(null)
  const stamp = useStore((s) => s.playbooksOn)
  const tasks = useStore((s) => s.tasks)
  // the panel reads the company's rows when it opens, and again when what it shows changes underneath it
  useEffect(() => {
    if (!anchor) return
    let live = true
    hive.playbooks.overview({ companyId: company.id }).then(
      (o) => live && setOv(o),
      () => live && setOv(null)
    )
    return () => {
      live = false
    }
  }, [anchor, company.id, company.autopilot, company.pausedAt, stamp, tasks])
  const flip = (on: boolean): void => {
    setBusy(true)
    void setCompanyAutopilot(company.id, on).finally(() => setBusy(false))
  }
  const held = st.mode === 'held'
  const label = chipLabel(st)
  const manage = (): void => {
    setAnchor(null)
    void enterCompany(company.id, { view: { name: 'schedules', tab: 'autopilots', nonce: Date.now() } })
  }
  return (
    <>
      <button
        type="button"
        className={`ap-chip is-${st.mode}`}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        title={`${label}. What is Autopilot doing? Click to see.`}
        aria-label={`${label}. What is Autopilot doing?`}
        onClick={(e) => {
          e.stopPropagation()
          setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())
        }}
      >
        <span className="ap-chip__mark" aria-hidden />
        {/* the full words where the header has room; the short, still true, words in the narrow sidebar */}
        <span className="ap-chip__text ap-chip__text--full">{label}</span>
        <span className="ap-chip__text ap-chip__text--short" aria-hidden>
          {chipShort(st)}
        </span>
      </button>
      <Popover anchor={anchor} onClose={() => setAnchor(null)} width={360}>
        <div className="ap-pop" role="dialog" aria-label={`What Autopilot is doing in ${company.name}`} style={anchor ? { maxHeight: `calc(100vh - ${Math.round(anchor.bottom) + 20}px)` } : undefined}>
          <div className="ap-pop__title">{held ? 'Autopilot is off while paused' : st.mode === 'on' ? 'Autopilot is on' : 'Autopilot is off'}</div>
          <p className="ap-pop__what">{ov ? ov.headline : held ? `${company.name} is paused, so nothing starts. Resume it to turn Autopilot on.` : 'Reading what runs by itself…'}</p>

          {ov && (
            <>
              <div className="ap-pop__sec">Starts work on their own</div>
              {ov.starters.length ? (
                <p className="ap-pop__what">{ov.starters.join(', ')}</p>
              ) : (
                <p className="ap-pop__what">{st.switchOn ? 'Nobody yet: set an agent to work on its own on its page.' : `Nobody: ${AUTO_START} is off.`}</p>
              )}
              {ov.manual.length > 0 && <p className="ap-pop__limits">Wait for your Start: {ov.manual.join(', ')}</p>}

              {ov.next.length > 0 && (
                <>
                  <div className="ap-pop__sec">Next</div>
                  <ul className="ap-pop__list ap-pop__list--rows">
                    {ov.next.map((n) => (
                      <li key={n.ref}>
                        <span className="ap-pop__name">
                          <b>{n.ref}</b> {n.title}
                        </span>
                        <span className="ap-pop__meta">{n.why}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="ap-pop__sec">Schedules</div>
              {ov.schedules.length ? (
                <ul className="ap-pop__list ap-pop__list--rows">
                  {ov.schedules.map((s) => (
                    <li key={s.name}>
                      <span className="ap-pop__name">{s.name}</span>
                      <span className="ap-pop__meta">
                        {s.when}
                        {whenShort(s.next) ? ` · next ${whenShort(s.next)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ap-pop__limits">No schedule runs.</p>
              )}

              <div className="ap-pop__sec">On autopilot</div>
              {ov.onAutopilot.length ? (
                <ul className="ap-pop__list ap-pop__list--rows">
                  {ov.onAutopilot.map((p) => (
                    <li key={p.name}>
                      <span className="ap-pop__name">
                        {p.name} · {p.level}
                      </span>
                      <span className="ap-pop__meta">
                        {p.state} · {p.cadence}. {p.limits}.
                      </span>
                      {p.lastLine && <span className="ap-pop__miss">{p.lastLine}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ap-pop__limits">No playbook yet. Principia offers one after work that should keep running, like ads you launch.</p>
              )}
            </>
          )}

          <div className="ap-pop__row">
            <span className="ap-pop__label">{AUTO_START}</span>
            <Switch checked={st.switchOn && !held} disabled={busy || held} onChange={flip} label={`${AUTO_START} in ${company.name}`} />
          </div>
          <p className="ap-pop__what">{AUTOPILOT_WHAT}</p>
          <p className="ap-pop__limits">{ov ? ov.limits : autopilotLimits(st)}</p>

          {ov && ov.lately.length > 0 && (
            <>
              <div className="ap-pop__sec">Lately</div>
              <ul className="ap-pop__list ap-pop__list--rows">
                {ov.lately.map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    <span className="ap-pop__meta">
                      {e.line} · {ago(e.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="link-btn ap-pop__link" onClick={manage}>
            Manage Autopilot →
          </button>
        </div>
      </Popover>
    </>
  )
}

/** The rail tile's subtle mark and the All companies card's line: the same state, read-only. */
export function AutopilotMark({ company, label = false }: { company: Row; label?: boolean }): React.JSX.Element | null {
  const st = useAutopilotState(company)
  if (!label) return st.mode === 'on' ? <span className="ap-mark" aria-hidden title={st.label} /> : null
  return <span className={`ap-line is-${st.mode}`} title={st.label}>{st.label}</span>
}
