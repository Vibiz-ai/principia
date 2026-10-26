/**
 * Five doors step 5: two one-time cards.
 * - Things moved (pm-review Risks): for people who used the old app, where each old page went, and Customize sidebar.
 * - Your team is ready. Start the first week? (design §6.7): a new company lands on Home with this as its one primary
 *   card: each agent and its first task, Start the first week (Autopilot on, the schedules ticked on Ready) or Look
 *   around first (nothing starts; each task waits in To do with Start). AUTOPILOT.md §7: before either is pressed, the
 *   card says exactly what Start the first week turns on (onboarding:startPreview): Autopilot in one sentence, the
 *   agents that will start work on their own, and the schedules that will run and when. Nothing turns on silently.
 */
import { useEffect, useMemo, useState } from 'react'
import type { OnboardingStartPreview } from '@shared/ipc'
import { AUTOPILOT_SENTENCE } from '@shared/autopilotState'
import type { Id } from '@shared/types'
import { Button } from '../ui'
import { AgentBust } from '../../shell/DepartmentGroup'
import { openCustomizeSidebar } from '../../shell/CustomizeSidebar'
import { brandNewUser, firstWeekRows, MOVED, THINGS_MOVED } from '../../lib/firstRun'
import { errorMessage, hive } from '../../lib/hive'
import { getState, navigate, refreshCompanies, refreshTasks, toast, updateSettings, useStore } from '../../state/store'
import { claudeSignedOut } from '../../state/claudeAuth'
import { useAgentDisplay } from '../board/NeedsYouTasks'
import '../../styles/desk.css'

export function ThingsMovedCard(): React.JSX.Element {
  const dismiss = (): void => void updateSettings({ notices: { ...(getState().settings?.notices ?? {}), [THINGS_MOVED]: new Date().toISOString() } })
  return (
    <section className="moved-card" aria-label="Things moved">
      <div className="moved-card__head">
        <span className="moved-card__title">Things moved</span>
        <span className="moved-card__sub">The sidebar is five doors now: Home, Team, Board, Chats, Knowledge. Nothing was removed.</span>
      </div>
      <ul className="moved-card__list">
        {MOVED.map((m) => (
          <li key={m.from}>
            <span className="moved-card__from">{m.from}</span>
            <span className="moved-card__arrow" aria-hidden>→</span>
            <span>{m.to}</span>
          </li>
        ))}
      </ul>
      <div className="moved-card__actions">
        <Button size="sm" variant="primary" onClick={dismiss}>
          Got it
        </Button>
        <Button
          size="sm"
          onClick={() => {
            dismiss()
            openCustomizeSidebar()
          }}
        >
          Customize sidebar…
        </Button>
        <span className="moved-card__hint">Old names still work in ⌘K.</span>
      </div>
    </section>
  )
}

export function FirstWeekCard({ companyId }: { companyId: Id }): React.JSX.Element | null {
  const pending = useStore((s) => s.settings?.firstWeek?.[companyId])
  const company = useStore((s) => s.companies.find((c) => c.id === companyId))
  const agents = useStore((s) => s.companyAgents)
  const tasks = useStore((s) => s.tasks)
  const departments = useStore((s) => s.departments)
  const who = useAgentDisplay()
  const rows = useMemo(() => firstWeekRows(companyId, agents, tasks), [companyId, agents, tasks])
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<OnboardingStartPreview | null>(null)
  const refsKey = JSON.stringify(pending?.scheduleRefs ?? [])
  useEffect(() => {
    if (!pending) return
    let live = true
    hive.onboarding.startPreview({ journalId: pending.journalId, scheduleRefs: pending.scheduleRefs }).then(
      (p) => live && setPreview(p),
      () => live && setPreview(null)
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.journalId, refsKey])
  if (!pending || !company) return null
  const clear = async (): Promise<void> => {
    const st = getState()
    const next = { ...(st.settings?.firstWeek ?? {}) }
    delete next[companyId]
    // someone whose first company this is never used the old app: "Things moved" is not for them
    const fresh = brandNewUser(companyId, st.companies, st.tasks)
    await updateSettings({ firstWeek: next, ...(fresh ? { notices: { ...(st.settings?.notices ?? {}), [THINGS_MOVED]: new Date().toISOString() } } : {}) })
  }
  const start = async (): Promise<void> => {
    if (claudeSignedOut()) return void toast('Sign in to Claude first (Settings › AI providers): agents can’t start without it.', 'error')
    setBusy(true)
    try {
      await hive.onboarding.start({ journalId: pending.journalId, autopilot: true, scheduleRefs: pending.scheduleRefs })
      await clear()
      await Promise.all([refreshCompanies(), refreshTasks().catch(() => undefined)])
      // Autopilot starts the agents that work on their own; the ones that ask first start too, because you just said
      // "start": each agent on the first task the card names (what it makes still waits for you in Needs you)
      const late: string[] = []
      let n = 0
      for (const { agent, task } of rows) {
        if (!task) continue
        const now = getState().tasks.find((t) => t.id === task.id)
        if (!now || now.status === 'in_progress' || now.runId) {
          if (now) n++
          continue
        }
        if (getState().tasks.some((t) => t.agentId === agent.id && t.status === 'in_progress')) continue
        try {
          await hive.tasks.start({ id: task.id })
          n++
        } catch (e) {
          if (/already owns/i.test(errorMessage(e))) n++
          else late.push(`${who(agent)?.name ?? agent.name}: ${errorMessage(e)}`)
        }
      }
      await refreshTasks().catch(() => undefined)
      toast(n ? `Started the first week: ${n} agent${n === 1 ? '' : 's'} on ${n === 1 ? 'its' : 'their'} first task` : 'Started. Agents pick up work as it is assigned.')
      if (late.length) toast(`Not started yet · ${late.join(' · ')}`, 'error')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const later = async (): Promise<void> => {
    setBusy(true)
    try {
      await clear()
      toast('Nothing started. Each first task waits in To do with a Start button.')
    } finally {
      setBusy(false)
    }
  }
  const signedOut = claudeSignedOut()
  return (
    <section className="week1" aria-label="Your team is ready">
      <h2 className="week1__title">Your team is ready. Start the first week?</h2>
      <p className="week1__sub">Each agent starts on its first task. You review what they make in Needs you before anything goes out.</p>
      <ul className="week1__list">
        {rows.map(({ agent, task }) => {
          const d = who(agent)
          const dep = departments.find((x) => x.id === agent.departmentId)
          return (
            <li key={agent.id} className="week1__row">
              <AgentBust agent={agent} color={dep?.color ?? null} size={26} />
              <span className="week1__who">
                <b>{d?.name ?? agent.name}</b>
                {d?.role && <span className="week1__role"> · {d.role}</span>}
              </span>
              <span className="week1__task">{task ? task.title : 'Nothing assigned yet'}</span>
            </li>
          )
        })}
      </ul>
      <div className="week1__turns" aria-label="What Start the first week turns on">
        <div className="week1__turns-title">Start the first week turns on</div>
        <ul className="week1__turns-list">
          <li>
            <b>Autopilot</b>
            {preview?.autopilot === false
              ? preview.noAgentCli
                ? ': stays off until an agent CLI is installed. The first tasks below still start.'
                : ': stays off (departments are off). The first tasks below still start.'
              : `. ${AUTOPILOT_SENTENCE} Up to ${preview?.maxInFlight ?? 2} tasks at once.`}
          </li>
          {preview?.autopilot !== false && (
            <li>
              <b>Starts work on its own</b>: {preview ? (preview.agents.length ? preview.agents.join(', ') : 'nobody yet; every agent waits for your Start') : '…'}
            </li>
          )}
          <li>
            <b>Schedules</b>: {preview ? (preview.schedules.length ? preview.schedules.map((x) => `${x.name} (${x.when})`).join(' · ') : 'none') : '…'}
          </li>
        </ul>
        <div className="week1__turns-note">Look around first turns nothing on.</div>
      </div>
      <div className="week1__actions">
        <Button variant="primary" icon="play" disabled={busy || signedOut} title={signedOut ? 'Sign in to Claude first' : undefined} onClick={() => void start()}>
          Start the first week
        </Button>
        <Button disabled={busy} onClick={() => void later()}>
          Look around first
        </Button>
        {signedOut && (
          <button type="button" className="link-btn" onClick={() => void navigate({ name: 'settings', section: 'providers', nonce: Date.now() })}>
            Sign in to Claude
          </button>
        )}
      </div>
    </section>
  )
}
