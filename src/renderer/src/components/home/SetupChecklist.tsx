/**
 * AUTOPILOT.md §2: "Get the most out of Principia", the setup checklist on a focused company's Home.
 * Every item is checked from real state (useCompanySetup), has one button that opens the right place, and the card
 * ends with the two autopilots the checklist leads to. Collapse and dismiss are per viewer (localStorage); a
 * dismissed card comes back from the palette ("Show Setup Checklist") or the Company menu.
 *
 * Line art only (VOICE.md §5): white hairline rings and checks on the dark surface, no warm colours.
 */
import { useMemo, useState } from 'react'
import { AUTOPILOTS, planAutopilot, type AutopilotId } from '@shared/autopilot'
import { SOCIAL_CHANNELS, type SocialStatus } from '@shared/socials'
import type { Id } from '@shared/types'
import { Button, Disclosure, IconButton, Sheet } from '../ui'
import { checklistProgress, nextItem, type ChecklistAction, type ChecklistItem } from '../../lib/checklist'
import { setChecklistPref, useChecklistPref } from '../../state/checklist'
import { confirmNative, errorMessage, hive } from '../../lib/hive'
import { addRepos, attempt, createDepartmentPresets, getState, navigate, openLogoPicker, toast, updateSettings, useStore } from '../../state/store'
import { getSlack, isConnected } from '../../state/slack'
import { useCompanySetup, type CompanySetup } from './useCompanySetup'
import { AutopilotSheet } from './AutopilotSheet'
import '../../styles/checklist.css'

// ---------- line art ----------

function CheckMark({ done, pending }: { done: boolean; pending?: boolean }): React.JSX.Element {
  return (
    <svg className={`ck-mark ${done ? 'is-done' : ''}`} viewBox="0 0 20 20" width={18} height={18} fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8.25" strokeDasharray={pending ? '2 2.6' : undefined} />
      {done && <path d="M6.2 10.4l2.5 2.5 5.2-5.6" />}
    </svg>
  )
}
function ProgressRing({ done, total }: { done: number; total: number }): React.JSX.Element {
  const r = 15
  const c = 2 * Math.PI * r
  const f = total ? done / total : 0
  return (
    <svg className="ck-ring" viewBox="0 0 36 36" width={36} height={36} fill="none" aria-hidden="true">
      <circle cx="18" cy="18" r={r} className="ck-ring__track" />
      <circle cx="18" cy="18" r={r} className="ck-ring__fill" strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 18 18)" />
      <text x="18" y="21.5" textAnchor="middle">{done}</text>
    </svg>
  )
}

// ---------- actions ----------

export async function runChecklistAction(a: ChecklistAction, companyId: Id, setup: Pick<CompanySetup, 'watchConnections' | 'reload'>, open: { socials: () => void; autopilot: (id: AutopilotId) => void }): Promise<void> {
  switch (a.kind) {
    case 'logo':
      return openLogoPicker(companyId)
    case 'passport':
      return void navigate({ name: 'company', companyId, nonce: Date.now() })
    case 'repo':
      return addRepos(companyId)
    case 'enableDepartments': {
      const ok = await confirmNative({ message: 'Turn on departments?', detail: 'Adds departments, agent seats, the company board and department dashboards. You can turn them off in Settings → Experimental.', confirmLabel: 'Turn On' })
      if (ok) await updateSettings({ experimental: { companies: true, departments: true } })
      return
    }
    case 'addDepartments':
      await createDepartmentPresets(companyId, a.keys)
      return
    case 'department':
      return void navigate({ name: 'department', id: a.departmentId, focus: a.focus, nonce: Date.now() })
    case 'socials':
      // five doors step 4: Instagram first, in plain words (Connections), never a developer key form; the per-network
      // keys sheet stays for the other networks once Instagram is connected
      if (!getState().companies.find((c) => c.id === companyId)?.accounts?.instagram) return void navigate({ name: 'settings', section: 'connections', connect: 'instagram', nonce: Date.now() })
      return open.socials()
    case 'vibiz':
      if (!a.present) return void navigate({ name: 'settings', section: 'connections' })
      try {
        await hive.gateway.connect({ id: 'vibiz' })
        toast('Finish signing in to Vibiz in your browser. This list updates by itself.')
        setup.watchConnections()
      } catch (e) {
        toast(`Vibiz: ${errorMessage(e)}`, 'error')
        void navigate({ name: 'settings', section: 'connections' })
      }
      return
    case 'slack':
      // the Slack page only helps once Slack is connected; until then the connection lives in Settings
      return void navigate(isConnected(getSlack().status) ? { name: 'slack', nonce: Date.now() } : { name: 'settings', section: 'connections', connect: 'slack', nonce: Date.now() })
    case 'schedule':
      return void navigate({ name: 'schedules', seed: {}, nonce: Date.now() })
    case 'autopilot':
      return open.autopilot(a.id)
  }
}

// ---------- the card ----------

/**
 * `chip` (five doors step 3, Home): a one-line "Setup 4 of 6 · Next: …" chip with the next step's button and Show
 * steps; the list opens in place, without the autopilot tiles (they live in Automations). Hidden once all is done.
 */
export function SetupChecklist({ companyId, chip = false }: { companyId: Id; chip?: boolean }): React.JSX.Element | null {
  const setup = useCompanySetup(companyId)
  const stored = useChecklistPref(companyId)
  const [expanded, setExpanded] = useState(false)
  const pref = chip ? { ...stored, collapsed: !expanded } : stored
  const [socialsOpen, setSocialsOpen] = useState(false)
  const [autopilot, setAutopilot] = useState<AutopilotId | null>(null)
  const [showDone, setShowDone] = useState(false)
  const { done, total } = checklistProgress(setup.items)
  const next = nextItem(setup.items)
  const open = { socials: () => setSocialsOpen(true), autopilot: (id: AutopilotId) => setAutopilot(id) }
  const act = (item: ChecklistItem): void => void runChecklistAction(item.action, companyId, setup, open)
  if (!setup.items.length || pref.dismissedAt) return null
  const todo = setup.items.filter((x) => !x.done)
  const finished = setup.items.filter((x) => x.done)
  const sheets = (
    <>
      {socialsOpen && <SocialsSheet companyId={companyId} socials={setup.socials} onClose={() => setSocialsOpen(false)} />}
      {autopilot && setup.ctx && (
        <AutopilotSheet
          id={autopilot}
          setup={setup}
          onClose={() => setAutopilot(null)}
          onFix={(a) => {
            setAutopilot(null)
            void runChecklistAction(a, companyId, setup, open)
          }}
        />
      )}
    </>
  )
  if (chip && done === total) return null
  if (chip && !expanded)
    return (
      <section className="setup-chip" aria-label={`Setup ${done} of ${total}`}>
        <ProgressRing done={done} total={total} />
        <div className="setup-chip__text">
          <div className="setup-chip__title">
            Setup {done} of {total}
          </div>
          {next && <div className="setup-chip__next">Next: {next.title}</div>}
        </div>
        <span className="flex1" />
        {next && (
          <Button size="sm" variant="primary" onClick={() => act(next)}>
            {next.actionLabel}
          </Button>
        )}
        <Button size="sm" onClick={() => setExpanded(true)} aria-expanded={false}>
          Show steps
        </Button>
        {sheets}
      </section>
    )

  return (
    <section className={`ck-card ${pref.collapsed ? 'is-collapsed' : ''}`} aria-label="Get the most out of Principia">
      <header className="ck-card__head">
        <ProgressRing done={done} total={total} />
        <div className="ck-card__titles">
          <h2 className="ck-card__title">{chip ? `Setup ${done} of ${total}` : 'Get the most out of Principia'}</h2>
          <div className="ck-card__sub">
            {done === total ? 'Everything is set up. Your autopilots can use all of it.' : `${done} of ${total} done${next && pref.collapsed ? ` · Next: ${next.title}` : ''}`}
          </div>
        </div>
        <span className="flex1" />
        {pref.collapsed && next && (
          <Button size="sm" variant="primary" onClick={() => act(next)}>
            {next.actionLabel}
          </Button>
        )}
        {chip ? (
          <Button size="sm" onClick={() => setExpanded(false)} aria-expanded>
            Hide steps
          </Button>
        ) : (
          <IconButton icon={pref.collapsed ? 'chevronRight' : 'chevronDown'} label={pref.collapsed ? 'Expand checklist' : 'Collapse checklist'} onClick={() => setChecklistPref(companyId, { collapsed: !pref.collapsed })} />
        )}
        <IconButton
          icon="close"
          label="Dismiss checklist"
          onClick={() => {
            setChecklistPref(companyId, { dismissedAt: new Date().toISOString() })
            toast('Checklist hidden. Bring it back from the palette: “Show Setup Checklist”.')
          }}
        />
      </header>
      {!pref.collapsed && (
        <>
          <ol className="ck-list">
            {todo.map((item) => (
              <ChecklistRow key={item.id} item={item} next={item === next} onAct={() => act(item)} />
            ))}
          </ol>
          {finished.length > 0 && (
            <>
              <button type="button" className="ck-done-toggle link-btn" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                {showDone ? '▾' : '▸'} Done ({finished.length})
              </button>
              {showDone && (
                <ol className="ck-list ck-list--done">
                  {finished.map((item) => (
                    <ChecklistRow key={item.id} item={item} next={false} onAct={() => act(item)} />
                  ))}
                </ol>
              )}
            </>
          )}
          {!chip && <AutopilotTiles companyId={companyId} setup={setup} onOpen={(id) => setAutopilot(id)} />}
        </>
      )}
      {sheets}
    </section>
  )
}

function ChecklistRow({ item, next, onAct }: { item: ChecklistItem; next: boolean; onAct: () => void }): React.JSX.Element {
  return (
    <li className={`ck-row ${item.done ? 'is-done' : ''} ${next ? 'is-next' : ''}`}>
      <CheckMark done={item.done} pending={item.pending} />
      <div className="ck-row__text">
        <div className="ck-row__title">
          {item.title}
          {item.progress && !item.done && <span className="ck-row__progress">{`${item.progress.n}/${item.progress.of}`}</span>}
          {next && <span className="ck-row__next">Next</span>}
        </div>
        <div className="ck-row__detail">{item.detail}</div>
      </div>
      <Button size="sm" variant={next ? 'primary' : item.done ? 'ghost' : 'secondary'} onClick={onAct}>
        {item.actionLabel}
      </Button>
      <span className="rm-sr">{item.done ? 'done' : item.pending ? 'checking' : 'not done'}</span>
    </li>
  )
}

/** The two autopilots, with how many of their steps can run today. */
export function AutopilotTiles({ companyId, setup, onOpen }: { companyId: Id; setup: CompanySetup; onOpen: (id: AutopilotId) => void }): React.JSX.Element | null {
  const plans = useMemo(() => (setup.ctx ? AUTOPILOTS.map((a) => ({ a, steps: planAutopilot(a.id, setup.ctx!) })) : []), [setup.ctx])
  // A4: a paused company's autopilots read "Off while paused" and are greyed out (still openable to look)
  const held = useStore((s) => !!s.companies.find((c) => c.id === companyId)?.pausedAt)
  if (!plans.length) return null
  return (
    <div className="ck-auto">
      <div className="ck-auto__eyebrow">Autopilots</div>
      <div className="ck-auto__grid">
        {plans.map(({ a, steps }) => {
          const rec = setup.autopilots?.[a.id]
          const ready = steps.filter((s) => s.ready).length
          const on = rec ? Object.keys(rec.steps).length : 0
          return (
            <button key={a.id} type="button" className={`ck-auto__tile ${rec && !held ? 'is-on' : ''} ${held ? 'is-held' : ''}`} onClick={() => onOpen(a.id)}>
              <span className="ck-auto__name">{a.name}</span>
              <span className="ck-auto__tag">{a.tagline}</span>
              <span className="ck-auto__state">
                {held ? 'Off while paused' : rec ? `${rec.paused ? 'Paused' : 'On'} · ${on} step${on === 1 ? '' : 's'}` : `${ready} of ${steps.length} steps ready`}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------- socials ----------

const STATE_LABEL: Record<SocialStatus['state'], string> = { mcp: 'Connected', key: 'Key saved', account: 'Connected (drafts only)', partial: 'Some keys missing', missing: 'Key needed' }

/** One row per network: its state, the official developer setup link, and fields for the missing keys. */
export function SocialsSheet({ companyId, socials, onClose }: { companyId: Id; socials: SocialStatus[] | null; onClose: () => void }): React.JSX.Element {
  const company = useStore((s) => s.companies.find((c) => c.id === companyId))
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const pasted = Object.entries(values).filter(([, v]) => v.trim())
  const save = async (): Promise<void> => {
    if (!pasted.length) return onClose()
    setBusy(true)
    let ok = 0
    for (const [name, value] of pasted) {
      const ch = SOCIAL_CHANNELS.find((c) => c.keys.some((k) => k.name === name))
      const label = ch ? `${ch.name} · ${ch.keys.find((k) => k.name === name)!.label}` : name
      const r = await attempt(() => hive.secrets.set({ name, value: value.trim(), label, companyId }), name)
      if (r) ok++
    }
    setBusy(false)
    if (ok) toast(`Saved ${ok} key${ok === 1 ? '' : 's'} to ${company?.name ?? 'the company'}’s Keys`)
    if (ok === pasted.length) onClose()
  }
  return (
    <Sheet title="Your social channels" onCancel={onClose} onPrimary={() => void save()} primaryLabel={pasted.length ? `Save ${pasted.length} key${pasted.length === 1 ? '' : 's'}` : 'Got it'} primaryDisabled={busy} width={620}>
      <p className="ck-sheet__lede">
        Your agents get every post ready for you: the picture, the caption and the hashtags. It comes to Home › Needs you; you approve it and post it yourself. Nothing posts on its own, and nothing extra to set up.
      </p>
      <p className="ck-sheet__lede">
        Instagram and the other networks don’t let apps sign in here yet. When they do, Connect will open each one in your browser, and we’ll ask before anything is posted for you.
      </p>
      <Disclosure label="For developers: connect a network with its own API keys">
        <p className="ck-sheet__lede">
          Each network’s developer app gives you keys to paste here. They are saved encrypted to {company?.name ?? 'this company'}’s Keys only.
        </p>
      <ul className="ck-socials">
        {SOCIAL_CHANNELS.map((ch) => {
          const st = socials?.find((s) => s.id === ch.id)
          const ready = !!st?.ready
          return (
            <li key={ch.id} className={`ck-social ${ready ? 'is-ready' : ''}`}>
              <div className="ck-social__head">
                <CheckMark done={ready} pending={!st} />
                <b>{ch.name}</b>
                <span className="ck-social__state">{st ? (st.state === 'mcp' ? `Connected via ${st.connection}` : st.state === 'account' ? `Connected · ${st.connection} (drafts only)` : STATE_LABEL[st.state]) : 'Checking…'}</span>
                {ch.can === 'read' && <span className="ck-social__state">read-only</span>}
                <span className="flex1" />
                <Button size="sm" variant="ghost" icon="external" onClick={() => void hive.app.openExternal({ url: ch.docs }).catch(() => toast('Could not open the developer page.', 'error'))}>
                  {ch.docsLabel}
                </Button>
              </div>
              <p className="ck-social__setup">{ch.setup}</p>
              {st?.state !== 'mcp' && (
                <div className="ck-social__keys">
                  {ch.keys.map((k) => {
                    const saved = !!st && !st.missingKeys.includes(k.name)
                    return (
                      <label key={k.name} className="ck-key">
                        <span className="ck-key__label">
                          {k.label} <code>{k.name}</code>
                        </span>
                        <input
                          type="password"
                          className="input"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={saved ? 'Saved · paste to replace' : 'Paste'}
                          value={values[k.name] ?? ''}
                          onChange={(e) => setValues((v) => ({ ...v, [k.name]: e.target.value }))}
                        />
                      </label>
                    )
                  })}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      </Disclosure>
    </Sheet>
  )
}
