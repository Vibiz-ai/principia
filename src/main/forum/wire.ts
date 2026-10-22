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
      h.dispatcher?.pump(companyId)
    } catch {
      /* the 60 s tick pumps anyway */
    }
  })
  const view = (id: string): ForumTaskView | null => {
    try {
      const t = c().task(id)
      return { id: t.id, companyId: t.companyId, identifier: t.identifier, status: t.status, blockReason: t.blockReason, runId: t.runId, ask: t.ask, report: t.report }
    } catch {
      return null
    }
  }
  const service = new ForumService({
    db: h.db,
    enabled: () => departmentsEnabled(h.settings().experimental),
    emit: (e) => emit('forum:event', e),
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
  void service.start().then((url) => url && log.info('forum endpoint ready', { url }))
  return service
}
