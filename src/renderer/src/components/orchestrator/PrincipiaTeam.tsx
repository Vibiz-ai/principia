/**
 * ORCHESTRATOR.md §3, §5 in the renderer:
 * - `PrincipiaRunsTeam`: This company > Team & autonomy > "Principia runs the team" (on or off, "Let Principia decide
 *   next steps with AI", calls per day) and what it did lately (the chief of staff's Activity).
 * - `PrincipiaSuggestions`: Principia's suggestions in Needs you (a routine, a connection, a next step), each with
 *   its one button and Not now. Nothing happens before the founder's click.
 * Agent and model text is rendered as text (React escapes it), never as HTML.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Id } from '@shared/types'
import type { OrchDecisionRecord, OrchSuggestion } from '@shared/orchestrator'
import { Button, RelativeTime, Stepper, Switch } from '../ui'
import { hive, useHiveEvent } from '../../lib/hive'
import { batchLine, CHIEF, resultLine, suggestionAction, suggestionKind, teamPatch, teamSwitches } from '../../lib/orchestrator'
import { attempt, navigate, refreshTasks, toast, updateSettings, useStore } from '../../state/store'
import { DeepLinkButton } from '../DeepLinkButton'
import { followLink } from '../../lib/inAppLink'
import { AutopilotOffer } from '../autopilot/AutopilotOffer'

/** Open suggestions of a company, refreshed when tasks change. */
export function usePrincipiaSuggestions(companyId: Id): { items: OrchSuggestion[]; reload: () => void } {
  const [items, setItems] = useState<OrchSuggestion[]>([])
  const reload = useCallback(() => {
    hive.orchestrator.suggestions({ companyId }).then(setItems, () => setItems([]))
  }, [companyId])
  useEffect(reload, [reload])
  useHiveEvent('data:changed', (p) => {
    if (p.domain === 'tasks' || p.domain === 'schedules') reload()
  })
  return { items, reload }
}

export function PrincipiaSuggestions({ items, onChanged }: { items: OrchSuggestion[]; onChanged: () => void }): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <div className="group-list home5__list orch-sugs" aria-label="Suggestions from Principia">
      {items.map((s) => (s.kind === 'autopilot' ? <AutopilotOffer key={s.id} s={s} onChanged={onChanged} /> : <SuggestionRow key={s.id} s={s} onChanged={onChanged} />))}
    </div>
  )
}

function SuggestionRow({ s, onChanged }: { s: OrchSuggestion; onChanged: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const decide = async (decision: 'accept' | 'dismiss'): Promise<void> => {
    setBusy(true)
    const r = await attempt(() => hive.orchestrator.decideSuggestion({ id: s.id, decision }), decision === 'accept' ? suggestionAction(s) : 'Not now')
    setBusy(false)
    if (!r) return
    toast(r.detail)
    // the link opens the exact card (a connection, a ready-made routine); nothing is connected or turned on by it
    if (decision === 'accept' && s.link && (s.kind === 'connection' || s.routineId)) followLink(s.link)
    else if (decision === 'accept' && s.kind === 'connection') void navigate({ name: 'settings', section: 'connections', nonce: Date.now() })
    else if (decision === 'accept' && s.kind === 'routine') void navigate({ name: 'schedules' })
    void refreshTasks()
    onChanged()
  }
  return (
    <div className="home5-row home5-row--needs orch-sug">
      <span className="home5-row__face" aria-hidden>
        <span className="home5-row__glyph orch-sug__mark">P</span>
      </span>
      <div className="home5-row__body">
        <div className="home5-row__title">
          {CHIEF} <span className="home5-row__role">· {suggestionKind(s)}</span>
        </div>
        <div className="home5-row__desc selectable">
          {s.title}
          {s.detail && <span className="text-tertiary"> {s.detail}</span>}
        </div>
        {s.link && (
          <div className="home5-row__desc orch-sug__link">
            <DeepLinkButton href={s.link} />
          </div>
        )}
      </div>
      <div className="home5-row__acts">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide('accept')}>
          {suggestionAction(s)}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('dismiss')}>
          Not now
        </Button>
      </div>
    </div>
  )
}

/** This company > Team & autonomy > "Principia runs the team". */
export function PrincipiaRunsTeam({ companyId, companyName }: { companyId: Id; companyName: string }): React.JSX.Element {
  const raw = useStore((s) => s.settings?.orchestrator)
  const sw = teamSwitches(raw, companyId)
  const [calls, setCalls] = useState(sw.callsPerDay)
  useEffect(() => setCalls(sw.callsPerDay), [sw.callsPerDay])
  const [lately, setLately] = useState<OrchDecisionRecord[]>([])
  const reload = useCallback(() => {
    hive.orchestrator.decisions({ companyId, limit: 5 }).then(setLately, () => setLately([]))
  }, [companyId])
  useEffect(reload, [reload])
  useHiveEvent('data:changed', (p) => {
    if (p.domain === 'tasks') reload()
  })
  const set = (change: Parameters<typeof teamPatch>[1]): void => void updateSettings(teamPatch(companyId, change) as Parameters<typeof updateSettings>[0])
  return (
    <div className="sgroup">
      <div className="sgroup__title">Principia runs the team</div>
      <div className="srow">
        <div className="srow__text">
          <div>Principia runs the team</div>
          <div className="srow__desc">
            {sw.on
              ? `After each run, Principia posts the update for the team, files the next steps, passes questions between agents and tells you what needs you. It works the same whether an agent uses Claude or Codex.${sw.shadow ? ' Right now it only writes down what it would do (test mode).' : ''}`
              : `Off: agents only do what they choose to do with their own tools, and ${companyName}'s team works less together.`}
          </div>
        </div>
        <div className="srow__ctl">
          <Switch checked={sw.on} onChange={(v) => set({ on: v })} label="Principia runs the team" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__text">
          <div>Let Principia decide next steps with AI</div>
          <div className="srow__desc">
            {sw.ai
              ? 'When its fixed rules can’t tell what comes next, Principia asks a small, low-cost AI model, on your own Claude or Codex sign-in. It can start ready work, nudge a task, ask a teammate, add a task or suggest something to you. It never spends, publishes, sends anything outside the company, deletes or approves.'
              : 'Off: Principia follows fixed rules only (start what is ready, suggest next steps, a daily digest). No AI calls.'}
          </div>
        </div>
        <div className="srow__ctl">
          <Switch checked={sw.ai} disabled={!sw.on} onChange={(v) => set({ ai: v })} label="Let Principia decide next steps with AI" />
        </div>
      </div>
      <div className="srow">
        <div className="srow__text">
          <div>AI calls per day</div>
          <div className="srow__desc">The most times a day Principia may ask the AI about {companyName}. Reading a run that ended without a report counts too. 0 turns AI calls off.</div>
        </div>
        <div className="srow__ctl">
          <Stepper
            value={calls}
            min={0}
            max={200}
            onChange={(v) => {
              setCalls(v)
              set({ callsPerDay: v })
            }}
            label="AI calls per day"
          />
        </div>
      </div>
      {sw.on && (
        <div className="srow orch-lately">
          <div className="srow__text">
            <div>What Principia did lately</div>
            {lately.length === 0 ? (
              <div className="srow__desc">Nothing yet. It acts after runs end and once a day.</div>
            ) : (
              <ul className="orch-lately__list">
                {lately.map((d) => (
                  <li key={d.id} className="orch-lately__item">
                    <div className="srow__desc">
                      {batchLine(d)} · <RelativeTime iso={d.createdAt} />
                    </div>
                    {d.results.map((r, i) => (
                      <div key={i} className={`orch-lately__line orch-lately__line--${r.status} selectable`}>
                        {resultLine(r)}
                      </div>
                    ))}
                    {d.note && <div className="orch-lately__line text-tertiary">{d.note}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
