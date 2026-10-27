/**
 * AUTOPILOT.md §6: "Put your ads on autopilot?" in Needs you. The plain plan, why now, a level picker (the offer's
 * level preselected; a money playbook stops at Level 2 here: raising it is its own step in Automations › Autopilot),
 * the hard limits and what it costs, then Turn on / Not now / Never for this. Nothing is turned on before Turn on.
 *
 * A paused autopilot (a run did something above its level) is a card too: Resume / Keep paused.
 */
import { useState } from 'react'
import type { OrchSuggestion } from '@shared/orchestrator'
import { isPlaybookId, LEVEL_INFO, levelLabel, limitsLine, maxLevel, OFFER_MAX_LEVEL, playbookDef, playbookLimits, PLAYBOOK_LEVELS, type PlaybookLevel } from '@shared/autopilotPlaybooks'
import { followLink } from '../../lib/inAppLink'
import { serviceById } from '@shared/services'
import { ConnectionSlot } from '../connections/ConnectionSlot'
import { Button } from '../ui'
import { hive } from '../../lib/hive'
import { attempt, refreshTasks, toast } from '../../state/store'
import '../../styles/autopilot.css'

export function AutopilotOffer({ s, onChanged }: { s: OrchSuggestion; onChanged: () => void }): React.JSX.Element | null {
  const def = isPlaybookId(s.playbookId) ? playbookDef(s.playbookId) : null
  // the card turns on at most Level 2: Level 3 is its own step, behind a confirm, in Automations › Autopilot
  const top = def ? Math.min(maxLevel(def, false), OFFER_MAX_LEVEL) : 1
  const [level, setLevel] = useState<PlaybookLevel>(Math.min(s.level ?? def?.defaultLevel ?? 1, top) as PlaybookLevel)
  const [busy, setBusy] = useState(false)
  if (!def) return null
  const decide = async (decision: 'accept' | 'dismiss' | 'never'): Promise<void> => {
    setBusy(true)
    const label = decision === 'accept' ? (s.breach ? 'Resume' : 'Turn on') : decision === 'never' ? 'Never for this' : s.breach ? 'Keep paused' : 'Not now'
    const r = await attempt(() => hive.orchestrator.decideSuggestion({ id: s.id, decision, ...(decision === 'accept' && !s.breach ? { level } : {}) }), label)
    setBusy(false)
    if (!r) return
    toast(r.detail)
    void refreshTasks()
    onChanged()
  }
  const limits = playbookLimits(def, s.budgetUsd ? { budgetCapUsd: s.budgetUsd } : null)
  return (
    <div className="home5-row home5-row--needs orch-sug ap-offer" data-playbook={def.id}>
      <span className="home5-row__face" aria-hidden>
        <span className="home5-row__glyph orch-sug__mark">P</span>
      </span>
      <div className="home5-row__body">
        <div className="home5-row__title">
          {s.title} <span className="home5-row__role">· {s.breach ? 'Autopilot paused' : 'Autopilot'}</span>
        </div>
        <div className="home5-row__desc selectable">{s.breach ? s.detail : def.summary}</div>
        {!s.breach && (
          <>
            <div className="ap-offer__plan selectable">
              {def.cadence}. {levelLabel(level)}: {def.plan[level]}
            </div>
            <div className="ap-offer__levels" role="radiogroup" aria-label="Level">
              {PLAYBOOK_LEVELS.map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={l === level}
                  className={`ap-level ${l === level ? 'is-on' : ''}`}
                  disabled={busy || l > top}
                  title={l > top ? (def.money ? `${def.name} moves money: raise it to Level 3 yourself in Automations › Autopilot` : 'Choose Level 3 in Automations › Autopilot once you have seen it run') : LEVEL_INFO[l].line}
                  onClick={() => setLevel(l)}
                >
                  Level {l} · {LEVEL_INFO[l].name}
                </button>
              ))}
            </div>
            <div className="ap-offer__limits">
              {limitsLine(def, limits, level)}. {def.limits.join('. ')}. {def.cost}
            </div>
            <div className="ap-offer__limits">Why now: {s.detail.split('. ')[0].replace(/\.$/, '')}.</div>
            {s.needs && serviceById(s.needs.connectId) && s.companyId ? (
              <div className="ap-offer__needs">
                <ConnectionSlot companyId={s.companyId} service={s.needs.connectId} purpose="playbook" label={`Needs ${s.needs.label} connected first. Turned on now, it waits and starts by itself once you connect it.`} actions={false} />
              </div>
            ) : s.needs && (
              <div className="ap-offer__limits ap-offer__needs">
                Needs {s.needs.label} connected first. Turned on now, it waits and starts by itself once you connect it.{' '}
                {s.link && (
                  <button type="button" className="link-btn" onClick={() => followLink(s.link!)}>
                    Connect →
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <div className="home5-row__acts">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide('accept')}>
          {s.breach ? 'Resume' : 'Turn on'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('dismiss')}>
          {s.breach ? 'Keep paused' : 'Not now'}
        </Button>
        {!s.breach && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('never')}>
            Never for this
          </Button>
        )}
      </div>
    </div>
  )
}
