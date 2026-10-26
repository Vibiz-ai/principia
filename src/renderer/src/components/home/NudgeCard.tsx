/**
 * Home's one suggestion at a time (lib/nudges.ts): a quiet card above Needs you with one action and a "Don't suggest
 * this again". It never blocks anything; doing what it suggests also retires it.
 */
import { useMemo, useState } from 'react'
import { connectionsFor } from '@shared/gateway'
import { presetForUrl } from '@shared/connectionCatalog'
import { planRoutine, routineDef, routineSchedule, ROUTINE_IDS, setRoutine, type RoutineId } from '@shared/routines'
import type { Id } from '@shared/types'
import { Button } from '../ui'
import { Icon } from '../Icon'
import { AgentBust } from '../../shell/DepartmentGroup'
import { useAgentDisplay } from '../board/NeedsYouTasks'
import { useCompanySetup } from './useCompanySetup'
import { routineDeps, useRoutineContext } from '../RoutinesTab'
import { turnOnRoutine } from '../../lib/routinesApply'
import { dismissNudge, pickNudge, type Nudge, type NudgeAction } from '../../lib/nudges'
import { TOOL_NAMES } from '../../lib/deepLinkNav'
import { inScope } from '../../lib/scope'
import { errorMessage } from '../../lib/hive'
import { getState, navigate, openDeepLink, toast, updateSettings, useStore } from '../../state/store'
import '../../styles/desk.css'

export function NudgeCard({ companyId }: { companyId: Id }): React.JSX.Element | null {
  const company = useStore((s) => s.companies.find((c) => c.id === companyId))
  const dismissed = useStore((s) => s.settings?.nudges?.[companyId])
  const records = useStore((s) => s.settings?.routines?.[companyId])
  const trackTasks = useStore((s) => s.settings?.trackTasks ?? 'auto')
  const allTasks = useStore((s) => s.tasks)
  const sessions = useStore((s) => s.sessions)
  const agents = useStore((s) => s.companyAgents)
  const who = useAgentDisplay()
  const setup = useCompanySetup(companyId)
  const { ctx, schedules, workflows } = useRoutineContext(companyId)
  const [busy, setBusy] = useState(false)

  const tasks = useMemo(() => allTasks.filter((t) => t.companyId === companyId), [allTasks, companyId])
  const connected = useMemo(() => {
    if (!setup.connections) return null
    const ids = new Set<string>()
    for (const c of connectionsFor(setup.connections, companyId)) {
      const p = c.url ? presetForUrl(c.url) : undefined
      if (p && c.enabled && (c.authentication !== 'oauth' || c.authStatus === 'connected')) ids.add(p.id)
    }
    if (company?.accounts?.instagram) ids.add('instagram')
    if (company?.accounts?.github) ids.add('github')
    return ids
  }, [setup.connections, companyId, company?.accounts])
  const routinesOn = useMemo(() => new Set<RoutineId>(schedules ? ROUTINE_IDS.filter((id) => routineSchedule(id, companyId, records?.[id], schedules)?.enabled) : []), [schedules, records, companyId])

  const nudge = useMemo<Nudge | null>(() => {
    if (!company) return null
    return pickNudge({
      now: new Date(),
      companyId,
      companyCreatedAt: company.createdAt ?? null,
      dismissed,
      tasks,
      schedulesOn: schedules ? schedules.filter((s) => s.enabled).length : null,
      routinesOn,
      morningBriefReady: !!ctx && planRoutine(routineDef('morning-brief'), ctx).ready,
      connected,
      agentName: (id) => who(agents.find((a) => a.id === id))?.name ?? null,
      toolName: (t) => TOOL_NAMES[t] ?? t,
      trackTasks,
      chatCount: sessions.filter((s) => inScope(s, companyId)).length
    })
  }, [company, companyId, dismissed, tasks, schedules, routinesOn, ctx, connected, who, agents, trackTasks, sessions])
  if (!nudge || company?.pausedAt) return null

  const retire = (): Promise<unknown> => updateSettings({ nudges: dismissNudge(getState().settings?.nudges, companyId, nudge.id) })
  const run = async (a: NudgeAction): Promise<void> => {
    if (a.kind === 'link') {
      await openDeepLink(a.href)
      return
    }
    if (a.kind === 'activity') return void navigate({ name: 'canvas' })
    setBusy(true)
    try {
      if (a.kind === 'trackTasks') {
        await updateSettings({ trackTasks: 'auto' })
        toast('Chats track their work as tasks again. Change it in Settings › Team & autonomy.')
      } else {
        if (!ctx || !schedules) return
        const def = routineDef(a.routine)
        const { record } = await turnOnRoutine(routineDeps, planRoutine(def, ctx), ctx, workflows, routineSchedule(a.routine, companyId, records?.[a.routine], schedules))
        await updateSettings({ routines: setRoutine(getState().settings?.routines, companyId, a.routine, record) })
        toast(`${def.name} is on: ${def.cadence.toLowerCase()}. Change it in Automations › Routines.`)
      }
      await retire()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const agent = nudge.agentId ? agents.find((a) => a.id === nudge.agentId) : undefined
  return (
    <section className="nudge" aria-label="Suggestion" data-nudge={nudge.id}>
      <span className="nudge__mark" aria-hidden>
        {agent ? <AgentBust agent={agent} size={26} /> : <Icon name="spark" size={14} />}
      </span>
      <div className="nudge__body">
        <div className="nudge__title">{nudge.title}</div>
        <div className="nudge__text">{nudge.body}</div>
      </div>
      <div className="nudge__acts">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(nudge.action)}>
          {nudge.action.label}
        </Button>
        {nudge.secondary && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(nudge.secondary!)}>
            {nudge.secondary.label}
          </Button>
        )}
        <button type="button" className="nudge__close" title="Don’t suggest this again" aria-label="Don’t suggest this again" disabled={busy} onClick={() => void retire()}>
          ×
        </button>
      </div>
    </section>
  )
}
