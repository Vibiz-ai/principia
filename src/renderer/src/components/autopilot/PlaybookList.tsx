/**
 * AUTOPILOT.md §6: Automations › Autopilot, "On autopilot". The playbooks on in this company, each with its level,
 * limits, last run, the calls Principia refused lately ("Ads watch tried to change a budget to $900; refused.") and a
 * pause switch; under it, the playbooks that are not on yet, each with Turn on.
 *
 * Every change is the founder's click. Raising a money playbook (the ads watch) to Level 3 asks first, names the
 * budget cap, and is refused in main without that explicit raise.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Id } from '@shared/types'
import { LEVEL_INFO, levelLabel, limitsLine, maxLevel, parseTargets, playbookDef, PLAYBOOK_LEVELS, type PlaybookDef, type PlaybookLevel, type PlaybookView } from '@shared/autopilotPlaybooks'
import { connectLink } from '@shared/deepLink'
import { serviceById } from '@shared/services'
import { ConnectionSlot } from '../connections/ConnectionSlot'
import { followLink } from '../../lib/inAppLink'
import { Button, RelativeTime, Stepper, Switch } from '../ui'
import { confirmNative, hive, useHiveEvent } from '../../lib/hive'
import { attempt, toast } from '../../state/store'
import '../../styles/autopilot.css'

export function PlaybookList({ companyId, companyName, focus, nonce }: { companyId: Id; companyName: string; focus?: string; nonce?: number }): React.JSX.Element {
  const [items, setItems] = useState<PlaybookView[] | null>(null)
  const reload = useCallback(() => {
    hive.playbooks.list({ companyId }).then(setItems, () => setItems([]))
  }, [companyId])
  useEffect(reload, [reload])
  useHiveEvent('data:changed', (p) => {
    if (p.domain === 'schedules' || p.domain === 'tasks') reload()
  })
  const focusRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (focus && items) focusRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focus, nonce, items])
  if (!items) return <div className="ap-list" aria-busy />
  const on = items.filter((v) => v.on)
  const off = items.filter((v) => !v.on)
  const ref = (v: PlaybookView) => (v.id === focus ? focusRef : undefined)
  return (
    <section aria-label="On autopilot">
      <div className="ap-section-title">On autopilot</div>
      {on.length ? (
        <div className="ap-list">
          {on.map((v) => (
            <div key={v.id} ref={ref(v)}>
              <OnItem v={v} companyName={companyName} focused={v.id === focus} onChanged={reload} />
            </div>
          ))}
        </div>
      ) : (
        <p className="auto-tab__lede">No playbook yet. When your team launches ads, publishes posts or deploys a site, Principia offers to keep it on autopilot. You can also turn one on below.</p>
      )}
      {off.length > 0 && (
        <>
          <div className="ap-section-title">More playbooks</div>
          <div className="ap-list">
            {off.map((v) => (
              <div key={v.id} ref={ref(v)}>
                <OffItem v={v} focused={v.id === focus} onChanged={reload} />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function LevelPicker({ value, top, money, disabled, onPick }: { value: PlaybookLevel; top: PlaybookLevel; money: boolean; disabled?: boolean; onPick: (l: PlaybookLevel) => void }): React.JSX.Element {
  return (
    <div className="ap-offer__levels" role="radiogroup" aria-label="Level">
      {PLAYBOOK_LEVELS.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={l === value}
          className={`ap-level ${l === value ? 'is-on' : ''}`}
          disabled={disabled || (l > top && !money)}
          title={l > top ? 'Moves money: you will be asked to raise it to Level 3 yourself' : LEVEL_INFO[l].line}
          onClick={() => onPick(l)}
        >
          Level {l} · {LEVEL_INFO[l].name}
        </button>
      ))}
    </div>
  )
}

/**
 * Level 3 of a playbook that does not move money (it publishes, sends or files work on its own): the founder's yes,
 * with its count limits named.
 */
async function confirmActs(def: PlaybookDef): Promise<boolean> {
  return confirmNative({
    message: `Let ${def.name} act on its own?`,
    detail: `At Level 3: ${def.plan[3]} ${def.limits.join('. ')}. Principia checks every call against these limits and refuses the rest. You can lower it any time.`,
    confirmLabel: 'Use Level 3'
  }).catch(() => false)
}

/**
 * QA-09: a playbook whose connection is there says so ("Stripe · key"), the same chip as every other surface; a
 * service it only works better with (release notes and GitHub) shows its slot either way.
 */
function UsesChip({ def, companyId }: { def: PlaybookDef; companyId: Id }): React.JSX.Element | null {
  const id = def.needs?.connectId ?? def.uses
  if (!id || !serviceById(id) || serviceById(id)!.soon) return null
  return (
    <div className="ap-item__needs ap-item__uses">
      <span className="ap-item__meta">Uses</span>
      <ConnectionSlot companyId={companyId} service={id} purpose={def.needs ? 'playbook' : 'agentTools'} variant="chip" />
    </div>
  )
}

/**
 * "Connect your ads account first": for a registry service (Stripe, Vibiz…) the shared slot (connect in place, with a
 * key or a sign-in, CONNECTIONS.md §4.3 S7); otherwise a link to Settings › Connections.
 */
function NeedsLine({ needs, companyId, waiting }: { needs: { label: string; connectId: string }; companyId: Id; waiting: boolean }): React.JSX.Element {
  if (serviceById(needs.connectId))
    return (
      <div className="ap-item__needs">
        <ConnectionSlot companyId={companyId} service={needs.connectId} purpose="playbook" label={waiting ? `Waiting for ${needs.label}: it starts by itself once you connect it.` : `Needs ${needs.label} connected. Turned on now, it waits until then.`} actions={false} />
      </div>
    )
  return (
    <div className="ap-item__warn">
      {waiting ? `Waiting for ${needs.label}: it starts by itself once you connect it.` : `Needs ${needs.label} connected. Turned on now, it waits until then.`}{' '}
      <button type="button" className="link-btn" onClick={() => followLink(connectLink(needs.connectId, companyId))}>
        Connect →
      </button>
    </div>
  )
}

/** A money playbook to Level 3: the founder's explicit yes, with the cap named. */
async function confirmRaise(name: string, cap: number | null | undefined): Promise<boolean> {
  return confirmNative({
    message: `Let ${name} act with money?`,
    detail: `At Level 3 it may pause losing ads and move budget between the ad sets it watches, never above $${cap ?? 50} a day in total. It still never creates campaigns, changes a goal or touches other campaigns. You can lower it any time.`,
    confirmLabel: 'Raise to Level 3'
  }).catch(() => false)
}

function OnItem({ v, companyName, focused, onChanged }: { v: PlaybookView; companyName: string; focused: boolean; onChanged: () => void }): React.JSX.Element {
  const def = playbookDef(v.id)
  const [busy, setBusy] = useState(false)
  const run = async <T,>(fn: () => Promise<T>, label: string, done?: (r: T) => string): Promise<void> => {
    setBusy(true)
    const r = await attempt(fn, label)
    setBusy(false)
    if (r !== null && r !== undefined && done) toast(done(r))
    onChanged()
  }
  const pick = async (level: PlaybookLevel): Promise<void> => {
    if (level === v.level) return
    const raise = level === 3 && def.money
    if (raise && !(await confirmRaise(def.name, v.limits.budgetCapUsd))) return
    if (level === 3 && !def.money && !(await confirmActs(def))) return
    void run(() => hive.playbooks.configure({ companyId: v.companyId, playbookId: v.id, level, ...(raise ? { raise: true } : {}) }), 'Level', (r) => `${def.name}: ${levelLabel(r.level)}`)
  }
  return (
    <div className={`ap-item ${focused ? 'is-focus' : ''}`}>
      <div className="ap-item__body">
        <div className="ap-item__name">{def.name}</div>
        <div className="ap-item__sum">{def.plan[v.level]}</div>
        <div className="ap-item__meta">
          {levelLabel(v.level)} · {def.cadence}
          {v.agentName ? ` · ${v.agentName}` : ''} · {v.lastRunAt ? <>last run <RelativeTime iso={v.lastRunAt} /></> : 'not run yet'}
        </div>
        <div className="ap-item__meta">{limitsLine(def, v.limits, v.level)}</div>
        <ul className="ap-item__limits">
          {def.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {v.waiting ? <NeedsLine needs={v.waiting} companyId={v.companyId} waiting /> : v.pausedWhy && <div className="ap-item__warn">{v.pausedWhy}</div>}
        {!v.waiting && <UsesChip def={def} companyId={v.companyId} />}
        {(v.nearMisses ?? []).length > 0 && (
          <ul className="ap-item__misses" aria-label="Refused lately">
            {v.nearMisses!.map((m, i) => (
              <li key={`${m.at}-${i}`} className="ap-item__miss">
                {m.line} <RelativeTime iso={m.at} />
              </li>
            ))}
          </ul>
        )}
        <LevelPicker value={v.level} top={maxLevel(def, v.raised)} money={def.money} disabled={busy} onPick={(l) => void pick(l)} />
        {def.money && (
          <div className="ap-item__meta" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            Total budget cap, $ a day
            <Stepper value={v.limits.budgetCapUsd ?? 50} min={1} max={100000} width={80} label="Total budget cap in dollars a day" onChange={(n) => void run(() => hive.playbooks.configure({ companyId: v.companyId, playbookId: v.id, limits: { budgetCapUsd: n } }), 'Budget cap')} />
          </div>
        )}
        {def.money && (
          <TargetsField
            value={v.limits.targets ?? []}
            disabled={busy}
            onSave={(targets) => void run(() => hive.playbooks.configure({ companyId: v.companyId, playbookId: v.id, limits: { targets } }), 'Campaigns it may change', (r) => `${def.short} may change ${r.limits.targets?.length ? `${r.limits.targets.length} campaign${r.limits.targets.length === 1 ? '' : 's'} or ad set${r.limits.targets.length === 1 ? '' : 's'}` : 'nothing (none listed)'}`)}
          />
        )}
        {def.money && <div className="ap-item__meta">Its runs have no terminal, no file writing and no web requests, and never get your ads keys: they reach the ads account only through Principia’s connections, where every call is checked first.</div>}
      </div>
      <div className="ap-item__acts">
        <Switch
          checked={v.running}
          disabled={busy}
          label={`${def.name} for ${companyName}: ${v.running ? 'running' : 'paused'}`}
          onChange={(next) => void run(() => hive.playbooks.setPaused({ companyId: v.companyId, playbookId: v.id, paused: !next }), next ? 'Resume' : 'Pause', () => (next ? `${def.name} runs again` : `${def.name} is paused`))}
        />
        <span className="ap-item__meta">{v.running ? 'Running' : v.waiting ? 'Waiting' : 'Paused'}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            const ok = await confirmNative({ message: `Turn off ${def.name}?`, detail: 'Its schedule is removed. Tasks and runs it already made stay.', confirmLabel: 'Turn off' }).catch(() => false)
            if (ok) void run(() => hive.playbooks.turnOff({ companyId: v.companyId, playbookId: v.id }), 'Turn off', () => `${def.name} is off`)
          }}
        >
          Turn off
        </Button>
      </div>
    </div>
  )
}

/** The ids of the campaigns, ad sets and ads a money playbook may change at Level 3 (none = it changes nothing). */
function TargetsField({ value, disabled, onSave }: { value: string[]; disabled: boolean; onSave: (targets: string[]) => void }): React.JSX.Element {
  const joined = value.join(', ')
  const [text, setText] = useState(joined)
  useEffect(() => setText(joined), [joined])
  const save = (): void => {
    const next = parseTargets(text)
    if (next.join(', ') !== joined) onSave(next)
  }
  return (
    <label className="ap-item__meta" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
      Campaigns, ad sets and ads it may change at Level 3 (ids, separated by commas)
      <input
        className="input input--sm"
        value={text}
        disabled={disabled}
        placeholder="None yet: at Level 3 it changes nothing"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
        }}
      />
    </label>
  )
}

function OffItem({ v, focused, onChanged }: { v: PlaybookView; focused: boolean; onChanged: () => void }): React.JSX.Element {
  const def = playbookDef(v.id)
  const top = maxLevel(def, false)
  const [level, setLevel] = useState<PlaybookLevel>(Math.min(def.defaultLevel, top) as PlaybookLevel)
  const [busy, setBusy] = useState(false)
  const turnOn = async (): Promise<void> => {
    const raise = level === 3 && def.money
    if (raise && !(await confirmRaise(def.name, v.limits.budgetCapUsd))) return
    if (level === 3 && !def.money && !(await confirmActs(def))) return
    setBusy(true)
    const r = await attempt(() => hive.playbooks.turnOn({ companyId: v.companyId, playbookId: v.id, level, ...(raise ? { raise: true } : {}) }), `Turn on ${def.name}`)
    setBusy(false)
    if (r) toast(r.waiting ? `${def.name} is on. It waits for ${r.waiting.label}, then starts by itself.` : `${def.name} is on at ${levelLabel(r.level)}${r.agentName ? `, run by ${r.agentName}` : ''}`)
    onChanged()
  }
  return (
    <div className={`ap-item ${focused ? 'is-focus' : ''}`}>
      <div className="ap-item__body">
        <div className="ap-item__name">{def.name}</div>
        <div className="ap-item__sum">{def.summary}</div>
        <div className="ap-item__meta">
          {def.cadence} · {def.cost}
        </div>
        {v.needs ? <NeedsLine needs={v.needs} companyId={v.companyId} waiting={false} /> : <UsesChip def={def} companyId={v.companyId} />}
        {focused && (
          <>
            <div className="ap-offer__plan">
              {levelLabel(level)}: {def.plan[level]}
            </div>
            <LevelPicker value={level} top={top} money={def.money} disabled={busy} onPick={setLevel} />
            <ul className="ap-item__limits">
              {def.limits.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="ap-item__acts">
        <Button size="sm" variant={focused ? 'primary' : 'secondary'} disabled={busy} onClick={() => void turnOn()}>
          Turn on
        </Button>
        {!focused && <span className="ap-item__meta">{levelLabel(level)}</span>}
      </div>
    </div>
  )
}
