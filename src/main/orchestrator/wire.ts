/**
 * ORCHESTRATOR.md: builds Principia's own layer over the running app and plugs it in. Called once at boot, after the
 * Forum, authoring (the handoff wrapper around syncRun) and the dispatcher exist, so:
 *
 * - the step hook runs after the task report harvest and the Forum's (both registered earlier);
 * - `beforeSync` wraps CompanyStore.syncRun outside the handoff wrapper (it runs first and can still register a
 *   handoff for the wrapper to apply);
 * - `afterRun` is the last run hook (after the board's syncRun and the dispatcher), so the board outcome is final.
 *
 * Cheap model calls (the fallback extractor) use the founder's own CLI login, never a shared key: a company's own key
 * only when that company set one.
 */
import type { Hive } from '../hive'
import { emit } from '../ipc'
import { log } from '../log'
import { CLI_PROVIDER_KEYS, pickCli, strippedChildEnv, type OneshotCli } from '../oneshot'
import { baseChildEnv } from '../loginEnv'
import type { OrchestratorStepRequest } from '../../shared/engine'
import type { BoardTask } from '../../shared/company'
import type { OrchDecisionRecord, OrchSuggestion, RunOrchestration } from '../../shared/orchestrator'
import { capReached } from '../../shared/spend'
import { HookedCompanyStore } from '../company/dispatcher'
import { createSchedule } from '../handlers/schedules'
import { usageSummary } from '../usage/summary'
import { RunApplier } from './apply'
import { buildRunContext, ContextReader } from './context'
import { Coordinator, WHO } from './coordinator'
import { coordinatorCall } from './coordinatorCall'
import { extractRunReport } from './extract'
import { Mailbox } from './mailbox'
import { Suggestions } from './suggestions'
import { recordUsage } from './usage'
import { companyConnections } from '../handlers/playbooks'
import { levelLabel, playbookDef, type PlaybookLevel } from '../../shared/autopilotPlaybooks'

export interface Orchestrator {
  readonly applier: RunApplier
  readonly mailbox: Mailbox
  readonly coordinator: Coordinator
  readonly suggestions: Suggestions
  /** orchestrator:suggestions (Needs you) */
  openSuggestions(companyId?: string | null): OrchSuggestion[]
  /** orchestrator:decideSuggestion (the founder's yes or no) */
  decideSuggestion(id: string, decision: 'accept' | 'dismiss' | 'never', level?: number): { suggestion: OrchSuggestion; detail: string }
  /** orchestrator:decisions (Activity: "Principia (chief of staff)") */
  decisions(companyId: string, limit?: number): OrchDecisionRecord[]
  dispose(): void
  /** EngineContext.orchestrator.stepContext */
  stepContext(req: OrchestratorStepRequest): string | null
  /** AGENT CHAT: the team block of an agent's standing chat (teammates, recent work; no report contract, no inbox) */
  chatContext(companyId: string, agentId: string): string | null
  forRun(runId: string): RunOrchestration | null
}

export function startOrchestrator(h: Hive): Orchestrator {
  const mailbox = new Mailbox({
    db: h.db,
    forum: () => h.forum,
    company: () => h.company,
    wakeTask: (taskId, reason) => void h.dispatcher?.addWake(taskId, reason),
    log
  })
  const cliOrder = (): OneshotCli[] => {
    const c = applier.settings().cli
    return c === 'auto' ? ['claude', 'codex'] : [c]
  }
  const applier: RunApplier = new RunApplier({
    db: h.db,
    company: () => h.company,
    settings: () => h.settings().orchestrator,
    boardFlags: () => h.settings().experimental,
    forum: () => h.forum,
    mailbox,
    runLogsDir: h.paths?.runLogsDir ?? null,
    facts: (companyId, run, facts) => h.memorySuggest?.fileRunFacts(companyId, run, facts) ?? null,
    handoff: (owner, args) => (h.author ? h.author.taskCall(owner, 'task_handoff', args, {}) : Promise.reject(new Error('Handoffs are not available'))),
    extract: (input, companyId) => {
      const cli = pickCli(h.safe(() => h.engine.providers.cached(), []), cliOrder())
      if (!cli) return Promise.resolve(null)
      return extractRunReport(input, {
        cli,
        env: () => strippedChildEnv(h.vault.resolveCompanyOnly(CLI_PROVIDER_KEYS[cli.id], companyId), baseChildEnv()),
        onUsage: (usage, id) => recordUsage(h.db, { companyId, purpose: 'extract', cli: id, usage, at: new Date().toISOString() })
      })
    },
    redact: (t) => h.vault.redact(t),
    onChange: () => {
      emit('data:changed', { domain: 'tasks' })
      h.statusChanged()
    },
    log
  })
  const reader = new ContextReader({ company: () => h.company, mailbox })

  h.stepOutputHooks.push((e) => applier.onStepOutput(e))
  const company = h.company
  const sync = company.syncRun.bind(company)
  company.syncRun = (run) => {
    applier.beforeSync(run)
    return sync(run)
  }
  // ---------- the chief of staff (ORCHESTRATOR.md §3) ----------
  const changed = (): void => {
    emit('data:changed', { domain: 'tasks' })
    h.statusChanged()
  }
  const suggestions = new Suggestions({
    db: h.db,
    redact: (t) => h.vault.redact(t),
    onChange: changed,
    routineOn: (companyId, id) => !!h.settings().routines?.[companyId]?.[id],
    playbookOn: (companyId, id) => !!h.playbooks?.isOn(companyId, id)
  })
  const connectionsOf = (companyId: string): string[] => companyConnections(h, companyId)
  const coordinator = new Coordinator({
    db: h.db,
    company: () => h.company,
    settings: (companyId) => applier.settingsFor(companyId),
    boardFlags: () => h.settings().experimental,
    overCap: (companyId) => {
      const co = h.company.listPassports().find((x) => x.id === companyId)
      if (!co?.monthlyCap) return false
      const month = usageSummary({ db: h.db, companyName: (id) => id }, { range: 'month', companyId })
      return capReached(month.total.usd, co.monthlyCap)
    },
    takeBudget: (companyId, perDay) => applier.takeBudget(companyId, perDay),
    model: (input, companyId) => {
      const cli = pickCli(h.safe(() => h.engine.providers.cached(), []), cliOrder())
      if (!cli) return Promise.resolve(null)
      return coordinatorCall(input, { cli, env: () => strippedChildEnv(h.vault.resolveCompanyOnly(CLI_PROVIDER_KEYS[cli.id], companyId), baseChildEnv()) })
    },
    usage: (companyId, r) => recordUsage(h.db, { companyId, purpose: 'coordinator', cli: r.cli, usage: r.usage, at: new Date().toISOString() }),
    pump: (companyId) => void h.dispatcher?.pump(companyId),
    wakeTask: (taskId, reason) => void h.dispatcher?.addWake(taskId, reason),
    mailbox,
    forum: () => h.forum,
    suggestions,
    connections: connectionsOf,
    playbooksOn: (companyId) => (h.playbooks ? h.playbooks.list(companyId).filter((v) => v.on).map((v) => v.id) : []),
    redact: (t) => h.vault.redact(t),
    onChange: changed,
    log
  })

  h.runHooks.push((run) => {
    const p = applier.afterRun(run)
    if (!['passed', 'failed', 'canceled'].includes(run.status)) return
    // AUTOPILOT.md §6: a playbook run that called a tool above its level pauses the playbook, and the founder is told
    const breach = h.safe(() => h.playbooks?.guardRun(run.id) ?? null, null)
    if (breach) {
      const def = playbookDef(breach.id)
      // AUTOPILOT.md §6: every refused call leaves its line ("Ads watch tried to change a budget to $900; refused.")
      const lines = [...new Set(breach.refused.map((r) => r.line))]
      suggestions.suggest({ companyId: breach.companyId, kind: 'autopilot', breach: true, playbookId: breach.id, title: `${def.short} was stopped and paused`, detail: `${lines.slice(0, 4).join(' ')}${lines.length > 4 ? ` And ${lines.length - 4} more.` : ''} Why: ${breach.refused[0]!.reason}. Principia paused it; nothing else runs until you resume it.` })
      log.warn('autopilot: paused a playbook after a refused tool call', { companyId: breach.companyId, playbook: breach.id, tools: breach.refused.map((r) => r.tool) })
    }
    void Promise.resolve(p).then(() => coordinator.runEnded(run.id))
  })
  if (h.forum) {
    h.forum.deferAutoPost = (e) => applier.willPost(e)
    h.forum.onAskAnswered = (m, o) => {
      mailbox.onAnswered(m, o)
      coordinator.event({ kind: 'ask_answered', companyId: m.companyId, messageId: m.id })
    }
    // ORCHESTRATOR.md §2: a teammate's reply to a question asked by @mention picks the asking task back up
    h.forum.collab.onReplied = (e) => mailbox.onReplied(e)
    const human = h.forum.onHumanPost
    h.forum.onHumanPost = (m) => {
      human?.(m)
      coordinator.event({ kind: 'forum_human_post', companyId: m.companyId, messageId: m.id, text: m.text })
    }
  }
  // the board's writes: a task created or done (any caller), an answer from the founder
  const done = (prev: Pick<BoardTask, 'status'> | null, next: BoardTask): void => {
    if (next.status === 'done' && prev?.status !== 'done') coordinator.event({ kind: 'task_done', companyId: next.companyId, taskId: next.id, agentId: next.agentId ?? null })
  }
  if (company instanceof HookedCompanyStore) {
    const inner = company.hooks
    company.hooks = {
      created: (t) => {
        inner?.created(t)
        coordinator.event({ kind: 'task_created', companyId: t.companyId, taskId: t.id, agentId: t.agentId ?? null })
      },
      updated: (prev, next) => {
        inner?.updated(prev, next)
        done(prev, next)
      },
      commented: (taskId, message, by) => inner?.commented(taskId, message, by)
    }
  }
  const approve = company.approve.bind(company)
  company.approve = (...args) => {
    const t = approve(...args)
    done(null, t)
    return t
  }
  const answer = company.answer.bind(company)
  company.answer = (...args) => {
    const t = answer(...args)
    coordinator.event({ kind: 'ask_answered', companyId: t.companyId, taskId: t.id, agentId: t.agentId ?? null })
    return t
  }
  // the daily tick (the digest): checked every hour, one tick per company per day
  const companiesOn = (): string[] => h.safe(() => h.company.listPassports().filter((c) => !c.archivedAt && c.system !== 'personal').map((c) => c.id), [])
  const ticker = setInterval(() => {
    // AUTOPILOT.md §6: a playbook waiting for its connection starts within the hour once it is connected
    for (const id of companiesOn()) h.safe(() => h.playbooks?.wakeWaiting(id), null)
    coordinator.tick(companiesOn())
  }, 3_600_000)
  ticker.unref?.()

  // ---------- suggestions: what accepting one does (the founder's own yes) ----------
  const accept = {
    createRoutine: (sg: OrchSuggestion): string => {
      const c = h.company
      const seats = c.departments.listAgents({ companyId: sg.companyId }).filter((a) => !a.archivedAt && a.kind === 'profile')
      const agent = (sg.agentId ? seats.find((a) => a.id === sg.agentId) : null) ?? seats[0]
      if (!agent) throw new Error('Add an agent first: a routine needs someone to do it')
      const name = sg.title.replace(/^Make it a routine:\s*/i, '').slice(0, 80) || 'Routine'
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      const sch = createSchedule(h, {
        companyId: sg.companyId,
        name,
        target: { kind: 'prompt', profileId: agent.refId, repoId: null, prompt: `${name}${sg.detail ? `\n\n${sg.detail}` : ''}`, mode: 'task', agentId: agent.id },
        departmentId: agent.departmentId,
        when: { kind: 'cron', cron: sg.cron ?? '0 9 * * 1-5', tz },
        preset: null,
        enabled: true
      })
      return sch.name
    },
    startTask: (taskId: string): string => {
      const t = h.dispatcher ? h.dispatcher.runNow(taskId) : h.company.task(taskId)
      changed()
      return `Started ${t.identifier}.`
    },
    turnOnPlaybook: (sg: OrchSuggestion, level: PlaybookLevel): string => {
      if (!h.playbooks || !sg.playbookId) throw new Error('Playbooks are not available')
      // the ads offer's budget cap is the daily budget the work named ($10/day), never a bigger default
      const v = h.playbooks.turnOn(sg.companyId, sg.playbookId, { level, agentId: sg.agentId ?? null, ...(sg.budgetUsd ? { limits: { budgetCapUsd: sg.budgetUsd } } : {}) })
      changed()
      const def = playbookDef(v.id)
      if (v.waiting) return `${def.name} is on at ${levelLabel(v.level)}${v.agentName ? `, run by ${v.agentName}` : ''}. It waits for ${v.waiting.label}: connect it and it starts by itself.`
      return `${def.name} is on at ${levelLabel(v.level)}${v.agentName ? `, run by ${v.agentName}` : ''}. ${def.cadence}. Pause it any time in Automations › Autopilot.`
    },
    resumePlaybook: (sg: OrchSuggestion): string => {
      if (!h.playbooks || !sg.playbookId) throw new Error('Playbooks are not available')
      const v = h.playbooks.setPaused(sg.companyId, sg.playbookId, false)
      changed()
      return `${playbookDef(v.id).name} runs again at ${levelLabel(v.level)}.`
    },
    fileTask: (sg: OrchSuggestion): string => {
      const t = h.company.createTask({ companyId: sg.companyId, title: sg.title.slice(0, 200), description: `${sg.detail}\n\nSuggested by ${WHO}; you said yes.`.trim(), repoId: null, status: 'todo', priority: 0, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [] })
      changed()
      return t.identifier
    }
  }
  /** a task suggestion whose task moved on leaves Needs you */
  const fresh = (list: OrchSuggestion[]): OrchSuggestion[] =>
    list.filter((sg) => {
      if (sg.kind !== 'task' || !sg.taskId) return true
      try {
        const t = h.company.task(sg.taskId)
        if (t.status === 'backlog' || t.status === 'todo') return true
      } catch {
        /* gone */
      }
      suggestions.expire(sg.id)
      return false
    })

  return {
    applier,
    mailbox,
    coordinator,
    suggestions,
    openSuggestions: (companyId) => fresh(suggestions.list(companyId)),
    decideSuggestion: (id, decision, level) => suggestions.decide(id, decision, accept, { level }),
    decisions: (companyId, limit) => coordinator.recent(companyId, limit),
    dispose: () => {
      clearInterval(ticker)
      coordinator.dispose()
    },
    stepContext: (req) => {
      if (!applier.active(req.companyId)) return null
      return buildRunContext(reader.input({ companyId: req.companyId, taskId: req.taskId, agentId: req.agentId, runId: req.runId, resumed: req.resumed, reportPath: req.reportPath }))
    },
    chatContext: (companyId, agentId) => {
      if (!applier.active(companyId)) return null
      return buildRunContext(reader.input({ companyId, taskId: null, agentId, runId: 'chat', resumed: false, reportPath: null, chat: true })) || null
    },
    forRun: (runId) => applier.forRun(runId)
  }
}
