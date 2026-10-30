/**
 * FORUM.md §3, §6: builds the ForumService over the running app. Everything app-specific (CompanyStore, departments,
 * the board's answer path, profiles, emit) is adapted here so service.ts stays testable. Called at boot before the
 * engine is created (the engine context takes `h.forum` as its ForumBridge).
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { departmentsEnabled } from '../../shared/company'
import { resolvePersonas } from '../../shared/personas'
import type { Hive } from '../hive'
import { emit } from '../ipc'
import { log } from '../log'
import { boardActions } from '../handlers/board'
import { createTaskGuarded, departmentActions } from '../handlers/company'
import { ForumService, type ForumTaskView } from './service'
import { ForumResponder } from './responder'
import { UNPICKED } from './replyJournal'
import { ConversationPilot } from './conversationPilot'
import { routeModelCall } from '../company/routeCall'
import { conversationTaskLines } from './taskStatus'
import { FORUM_AGENT_ADAPTERS, type ForumAgentAdapter } from '../../shared/forum'

const TERMINAL = new Set(['passed', 'failed', 'canceled'])

function ownerName(): string {
  try {
    const u = os.userInfo().username
    return u ? u.charAt(0).toUpperCase() + u.slice(1) : 'You'
  } catch {
    return 'You'
  }
}

export function wireForum(h: Hive, opts: { mainDir: string }): ForumService {
  const c = () => h.company
  const spawnRoot = path.join(h.paths.userData, 'forum', 'spawn')
  try {
    fs.rmSync(spawnRoot, { recursive: true, force: true })
    fs.mkdirSync(spawnRoot, { recursive: true, mode: 0o700 })
  } catch {
    /* best effort: open() reports per step */
  }
  const changed = (domain: 'tasks' | 'departments') => {
    emit('data:changed', { domain })
    h.statusChanged()
  }
  const board = () => boardActions(h, (companyId) => {
    emit('data:changed', { domain: 'tasks' })
    try {
      void h.dispatcher?.pump(companyId)
    } catch {
      /* the 60 s tick pumps anyway */
    }
  })
  const view = (id: string): ForumTaskView | null => {
    try {
      const t = c().task(id)
      return { id: t.id, companyId: t.companyId, identifier: t.identifier, status: t.status, blockReason: t.blockReason, runId: t.runId, ask: t.ask, report: t.report, title: t.title, agentId: t.agentId, doneNote: t.doneNote, prUrl: t.work?.pr?.url ?? null, updatedAt: t.updatedAt, createdAt: t.createdAt }
    } catch {
      return null
    }
  }
  const service = new ForumService({
    db: h.db,
    enabled: () => departmentsEnabled(h.settings().experimental),
    emit: (e) => emit('forum:event', e),
    quitting: () => h.quitting,
    redact: (s) => h.vault.redact(s),
    directory: {
      departments: (companyId) => c().departments.list(companyId, { includeArchived: true }).map((d) => ({ id: d.id, key: d.key, name: d.name, archivedAt: d.archivedAt })),
      agents: (companyId) => {
        const agents = c().departments.listAgents({ companyId, includeArchived: true })
        const personas = resolvePersonas(agents, c().departments.list(companyId, { includeArchived: true }))
        // handles follow the persona whatever the display setting (a handle must not flip with a toggle)
        return agents.map((a) => ({ id: a.id, departmentId: a.departmentId, name: a.name, archivedAt: a.archivedAt, personaName: personas.get(a.id)?.name ?? null }))
      },
      ownerName,
      hasCompany: (companyId) => {
        try {
          c().passport(companyId)
          return true
        } catch {
          return false
        }
      }
    },
    tasks: {
      get: view,
      setAsk: (taskId, ask) => {
        c().patchInFlight(taskId, ask ? { ask, report: null } : { ask: null })
        changed('tasks')
      },
      answer: (taskId, answer) => {
        board().answer({ id: taskId, answer })
      },
      lastAnswer: (taskId) => {
        const a = c().detail(taskId).activity.filter((x) => x.kind === 'answered').pop()
        return a ? a.message.replace(/^Answer: /, '') : null
      },
      // the founder's go-ahead (their answer, "go ahead", a request filed from the conversation): a consented start now
      start: (taskId, why) => {
        const d = h.dispatcher
        if (!d) return { state: 'refused', line: 'Tasks cannot start yet: Principia is still starting up.' }
        const go = d.goAhead(taskId, why)
        changed('tasks')
        return go
      },
      create: (input) => {
        const t = createTaskGuarded(h, {
          companyId: input.companyId, title: input.title, description: input.description, repoId: null,
          status: input.departmentId || input.agentId ? 'todo' : 'triage', priority: 0, source: 'manual', sourceUrl: null, externalId: null,
          assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: input.departmentId, agentId: input.agentId
        })
        changed('tasks')
        return { id: t.id, identifier: t.identifier }
      }
    },
    // CHAT-UI.md §8: answer or status question? the cheap tier (routeCall.ts: haiku, no tools); null without a Claude CLI
    replyKind: () => (h.engine ? routeModelCall({ providers: () => h.engine.providers.cached() }) : null),
    company: {
      saveDepartment: (input) => {
        const dep = departmentActions(h).save({ companyId: input.companyId, name: input.name, ...(input.key ? { key: input.key } : {}), data: { charter: { does: input.does, doesNot: input.doesNot } } })
        changed('departments')
        return { id: dep.id, key: dep.key, name: dep.name }
      },
      saveAgent: (input) => {
        const a = departmentActions(h).saveAgent({
          companyId: input.companyId, departmentId: input.departmentId, kind: 'profile', refId: input.profileId, name: input.role,
          data: { instructions: input.instructions, capabilities: input.capabilities, autonomy: 'manual' }
        })
        changed('departments')
        return { id: a.id, name: a.name }
      },
      departmentByKey: (companyId, key) => {
        const d = c().departments.byKey(companyId, key.toLowerCase())
        return d ? { id: d.id, key: d.key, name: d.name, archivedAt: d.archivedAt } : null
      },
      defaultProfile: (adapter) => h.store.defaultProfileFor(adapter),
      profileExists: (id) => !!h.store.getProfile(id),
      companyName: (companyId) => {
        try {
          return c().passport(companyId).name
        } catch {
          return ''
        }
      },
      seatLabel: (agentId) => {
        const a = c().departments.getAgent(agentId)
        if (!a) return null
        const dep = a.departmentId ? c().departments.get(a.departmentId) : null
        return dep ? `${a.name}, ${dep.name}` : a.name
      }
    },
    // AGENT-COLLAB.md: the board for team_board, the guards' settings and seat facts
    board: (companyId) =>
      c()
        .listTasks(companyId)
        .map((t) => ({ identifier: t.identifier, title: t.title, status: t.status, blockReason: t.blockReason ?? null, agentId: t.agentId ?? null, departmentId: t.departmentId ?? null, priority: t.priority, updatedAt: t.updatedAt })),
    collabSettings: () => h.settings().agentCollab,
    seats: {
      departmentOf: (agentId) => c().departments.getAgent(agentId)?.departmentId ?? null,
      canAnswer: (agentId) => {
        const a = c().departments.getAgent(agentId)
        if (!a || a.archivedAt || a.pausedAt || a.kind !== 'profile') return false
        const p = h.store.getProfile(a.refId)
        return !!p && p.adapter !== 'shell'
      },
      leadOf: (companyId, departmentId) => {
        const lead = c()
          .departments.listAgents({ companyId, departmentId })
          .find((a) => !a.archivedAt && !a.pausedAt && a.kind === 'profile' && h.store.getProfile(a.refId)?.adapter !== 'shell')
        return lead?.id ?? null
      }
    },
    cliScript: path.join(opts.mainDir, 'forum-cli.js'),
    execPath: process.execPath,
    spawnRoot,
    log
  })
  // §4.1.4: fenced ```forum ops of seat runs, at step end (after the task report harvest registered earlier)
  h.stepOutputHooks.push((e) => void service.harvest(e))
  // §6: an answer held for a running task is applied once the run ends and parks it (after the company run hook)
  h.runHooks.push((run) => {
    if (!TERMINAL.has(run.status) || !run.companyId || !service.enabled()) return
    setImmediate(() => {
      try {
        service.reconcileAsks(run.companyId!)
      } catch (e) {
        log.warn('forum: ask reconcile failed', { runId: run.id, error: String(e) })
      }
    })
  })
  // CHAT-UI.md §8: the live task cards follow their tasks; a task that came back posts its result into the
  // conversation it was started from. A short delay lets Principia's run report post first (it says more).
  const cardTimers = new Map<string, NodeJS.Timeout>()
  const followCards = (companyId: string | null | undefined, ms = 2500): void => {
    if (!companyId || !service.enabled() || cardTimers.has(companyId)) return
    const timer = setTimeout(() => {
      cardTimers.delete(companyId)
      try {
        service.reconcileTaskCards(companyId, { post: true })
      } catch (e) {
        log.warn('forum: task cards failed', { companyId, error: String(e) })
      }
    }, ms)
    timer.unref?.()
    cardTimers.set(companyId, timer)
  }
  h.safe(() => c().onTaskWrite((t) => followCards(t.companyId)), undefined)
  h.runHooks.push((run) => {
    if (TERMINAL.has(run.status)) followCards(run.companyId, 4000)
  })
  // §6.4: a human's post wakes the agents it is for (one short seat run each, no board task)
  const responder = new ForumResponder({
    store: () => service.store,
    enabled: () => service.enabled(),
    quitting: () => h.quitting,
    journal: service.owed,
    seat: (agentId) => {
      const a = c().departments.getAgent(agentId)
      if (!a) return null
      const profile = a.kind === 'profile' ? h.store.getProfile(a.refId) : null
      return {
        id: a.id,
        companyId: a.companyId,
        departmentId: a.departmentId,
        name: a.name,
        instructions: a.data.instructions ?? '',
        profileId: profile && profile.adapter !== 'shell' ? profile.id : null,
        repoId: a.data.defaultRepoId ?? null,
        active: !a.archivedAt && !a.pausedAt
      }
    },
    departmentName: (id) => c().departments.get(id)?.name ?? null,
    seats: (companyId, departmentId) =>
      c()
        .departments.listAgents({ companyId, ...(departmentId ? { departmentId } : {}) })
        .filter((a) => !a.archivedAt && !a.pausedAt && a.kind === 'profile')
        .map((a) => a.id),
    start: ({ companyId, agentId, profileId, repoId, prompt, reply }) => {
      const run = h.engine.runs.start({ kind: 'prompt', profileId, repoId, prompt: h.vault.redact(prompt), memory: 'read' }, { trigger: 'manual', companyId, agentId, reply: true })
      // the seat on the run row: the step-end harvest posts for it when it does not reply itself
      h.db.prepare('UPDATE runs SET agent_id=?, company_id=? WHERE id=?').run(agentId, companyId, run.id)
      service.noteReplyRun(run.id, reply)
      return run.id
    },
    onWakeStarted: (wakeIds, runId) => service.collab.noteStarted(wakeIds, runId),
    onWakeFailed: (wakeIds, reason) => service.wakeFailed(wakeIds, reason),
    askOf: (m, memberId) => service.askOf(m, memberId),
    repick: (m) => service.pilot?.repick(m) ?? false,
    onUnanswered: (messageId, memberId, reason) => service.noteUnanswered(messageId, memberId, reason),
    taskStates: (channelId) =>
      conversationTaskLines(
        c(),
        service.conversationCards(channelId).map((card) => card.taskId),
        (agentId) => service.store.memberForAgent(agentId)?.name ?? null
      ),
    taskAsks: (channelId) =>
      service.openTaskAsks(channelId).flatMap((q) => {
        const t = q.ask?.taskId ? view(q.ask.taskId) : null
        return t?.ask ? [{ identifier: t.identifier, ref: q.ref, prompt: t.ask.prompt }] : []
      }),
    log
  })
  service.onHumanPost = (m) => void responder.onHumanPost(m)
  service.wakeOne = (memberId, m) => void responder.wakeOne(memberId, m)
  service.recoverReplies = () => responder.recover()
  // CHAT-UI.md §7.1, §7.2: conversation titles and "Principia picks", on the cheap tier (routeCall.ts: haiku, no tools)
  service.pilot = new ConversationPilot({
    store: () => service.store,
    call: () => (h.engine ? routeModelCall({ providers: () => h.engine.providers.cached() }) : null),
    seats: (companyId) => {
      const deps = new Map(c().departments.list(companyId).map((d) => [d.id, d]))
      return c()
        .departments.listAgents({ companyId })
        .filter((a) => !a.archivedAt && !a.pausedAt && a.kind === 'profile' && (h.store.getProfile(a.refId)?.adapter ?? 'shell') !== 'shell')
        .map((a) => {
          const d = a.departmentId ? deps.get(a.departmentId) : undefined
          return {
            agentId: a.id,
            name: service.store.memberForAgent(a.id)?.name ?? a.name,
            role: a.name,
            departmentKey: d?.key ?? null,
            department: d?.name ?? null,
            does: d?.data.charter.does ?? '',
            capabilities: a.data.capabilities ?? '',
            instructions: a.data.instructions ?? ''
          }
        })
    },
    departments: (companyId) =>
      c()
        .departments.list(companyId)
        .filter((d) => !d.archivedAt)
        .map((d) => ({ key: d.key, name: d.name, does: d.data.charter.does ?? '' })),
    defaultAdapter: () => {
      const a = h.settings().defaultAdapter
      return (FORUM_AGENT_ADAPTERS as readonly string[]).includes(a) ? (a as ForumAgentAdapter) : null
    },
    humanPosted: (m) => service.humanPosted(m),
    journal: service.owed,
    onUnanswered: (messageId, reason) => service.noteUnanswered(messageId, UNPICKED, reason),
    redact: (s) => h.vault.redact(s),
    log
  })
  // AGENT-COLLAB.md §2: an agent's ask or mention wakes another agent, after collab.ts checked the guards
  service.collabWake = (req) =>
    responder.wakeForAgent(req.target, req.message.companyId, req.message.id, {
      handle: req.asker.handle,
      label: req.asker.agentId ? (() => {
        const a = c().departments.getAgent(req.asker.agentId!)
        const dep = a?.departmentId ? c().departments.get(a.departmentId) : null
        return a ? (dep ? `${a.name}, ${dep.name}` : a.name) : null
      })() : null,
      depth: req.depth,
      maxHops: req.maxHops,
      why: req.why
    }, req.wakeId)
  h.runHooks.push((run) => {
    if (!TERMINAL.has(run.status)) return
    responder.onRunEnded(run.id)
    // after the step-end harvest, which applies the run's last writes
    setTimeout(() => service.settleReply(run.id, run.status, run.reason), 2500).unref?.()
    // after the step-end harvest (it reads the reply target first)
    setTimeout(() => service.forgetRun(run.id), 60_000).unref?.()
  })
  void service.start().then((url) => url && log.info('forum endpoint ready', { url }))
  return service
}
