/**
 * AUTOPILOT.md §6: the playbooks:* channels (Automations › Autopilots, the offer cards). Every write is the founder's
 * own click; the levels and limits are checked again in Playbooks (a money playbook above Level 2 needs `raise`).
 */
import { HiveError } from '../../shared/errors'
import { agentActive, departmentsEnabled } from '../../shared/company'
import { autopilotOverview, type AutopilotOverview, type OverviewEvent } from '../../shared/autopilotOverview'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { log } from '../log'
import { Playbooks } from '../company/playbooks'
import { createSchedule, removeSchedule, setScheduleEnabled, updateSchedule } from './schedules'

/**
 * AUTOPILOT.md §6: what reaches a company: its MCP connections (signed in), its own keys and its accounts, by id and
 * name. The tick's offers read it, and a playbook that needs a connection waits for it.
 */
export function companyConnections(h: Hive, companyId: string): string[] {
  const out: string[] = []
  for (const g of h.safe(() => h.gateway?.list() ?? [], [])) {
    if (!g.enabled || (g.companyIds && !g.companyIds.includes(companyId))) continue
    if (g.authentication === 'oauth' && g.authStatus !== 'connected') continue
    out.push(g.id, g.name)
  }
  for (const k of h.safe(() => h.vault.list(), [])) if (k.companyId === companyId) out.push(k.name)
  const co = h.safe(() => h.company.passport(companyId), null)
  for (const [kind, acc] of Object.entries(co?.accounts ?? {})) if (acc) out.push(kind)
  // CONNECTIONS.md S7: a service connected in any form (a Stripe key, a sign-in) counts by its registry id
  for (const st of h.safe(() => h.connections?.list(companyId, { usage: false }) ?? [], [])) if (st.state === 'connected') out.push(st.serviceId)
  return out
}

export function createPlaybooks(h: Hive): Playbooks {
  return new Playbooks({
    db: h.db,
    company: () => h.company,
    schedules: {
      create: (input) => createSchedule(h, input),
      update: (id, input) => updateSchedule(h, id, input),
      setEnabled: (id, enabled) => setScheduleEnabled(h, id, enabled),
      remove: (id) => removeSchedule(h, id),
      get: (id) => h.store.getSchedule(id)
    },
    departmentsOn: () => departmentsEnabled(h.settings().experimental),
    connections: (companyId) => companyConnections(h, companyId),
    log: (m, meta) => log.warn(m, meta),
    onChange: () => {
      emit('data:changed', { domain: 'schedules' })
      h.statusChanged()
    }
  })
}

/**
 * AUTOPILOT.md §8: "What is Autopilot doing?" for one company: the rows (agents, tasks, schedules, playbooks, what
 * started lately), worded by shared/autopilotOverview. Read-only.
 */
export function playbookOverview(h: Hive, companyId: string): AutopilotOverview {
  const c = h.company
  const co = c.passport(companyId)
  const board = c.boardSettings(companyId)
  const deps = new Map(c.departments.list(companyId).map((d) => [d.id, d.name]))
  const raw = c.departments.listAgents({ companyId }).filter((a) => a.companyId === companyId && !a.archivedAt)
  const nameOf = (a: (typeof raw)[number]): string => a.data.persona?.name || a.name
  const agents = raw.map((a) => ({ id: a.id, name: nameOf(a), department: a.departmentId ? deps.get(a.departmentId) ?? null : null, auto: a.data.autonomy === 'auto' && a.data.mode !== 'session', active: agentActive(a) }))
  const held = new Set<string>()
  const tasks = c.listTasks(companyId).map((t) => {
    if (t.status === 'todo') {
      const last = h.safe(() => h.db.prepare('SELECT kind, actor FROM company_task_activity WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(t.id) as { kind: string; actor: string | null } | undefined, undefined)
      if (last?.kind === 'paused' && last.actor === 'human') held.add(t.id)
    }
    return { id: t.id, identifier: t.identifier, title: t.title, status: t.status, blockReason: t.blockReason ?? null, agentId: t.agentId ?? null, dependencyIds: t.dependencyIds, priority: t.priority, plan: !!t.plan, heldByYou: held.has(t.id), limitWait: t.limitWait ?? null, scheduleCard: t.source === 'schedule' }
  })
  const pb = h.playbooks
  const byAgent = new Map(raw.map((a) => [a.id, nameOf(a)]))
  const schedules = h.store.listSchedules(companyId).map((s) => ({
    name: s.name,
    enabled: s.enabled,
    sentence: s.sentence,
    nextFireAt: s.nextFireAt,
    agentName: s.target.kind === 'prompt' && s.target.agentId ? byAgent.get(s.target.agentId) ?? null : null,
    playbook: !!pb?.forSchedule(s.id)
  }))
  const playbooks = pb ? pb.list(companyId) : []
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const lately: OverviewEvent[] = []
  const woke = h.safe(() => h.db.prepare("SELECT a.created_at AS at, a.message AS message, json_extract(t.data,'$.identifier') AS ref, json_extract(t.data,'$.title') AS title FROM company_task_activity a JOIN company_tasks t ON t.id=a.task_id WHERE t.company_id=? AND a.kind='woke' AND a.created_at>=? ORDER BY a.seq DESC LIMIT 6").all(companyId, since) as { at: string; message: string; ref: string; title: string }[], [])
  for (const w of woke) lately.push({ at: w.at, line: `${/^Woke ([^:]+):/.exec(w.message)?.[1] ?? 'An agent'} started ${w.ref} ${w.title} on its own` })
  for (const s of h.store.listSchedules(companyId)) if (s.lastFireAt && s.lastFireAt >= since) lately.push({ at: s.lastFireAt, line: `${s.name} ran${s.lastRunStatus ? ` (${s.lastRunStatus})` : ''}` })
  for (const v of playbooks) for (const m of v.nearMisses ?? []) lately.push({ at: m.at, line: m.line })
  return autopilotOverview({ companyName: co.name, switchOn: !!board.autopilot, paused: c.isPaused(companyId), maxInFlight: board.maxInFlight, monthlyCap: co.monthlyCap ?? null, agents, tasks, schedules, playbooks, lately })
}

export function registerPlaybookHandlers(h: Hive): void {
  const p = (): Playbooks => {
    if (!h.playbooks) throw new HiveError('conflict', 'Playbooks are not available')
    return h.playbooks
  }
  if (!h.playbooks) h.playbooks = h.safe(() => createPlaybooks(h), null)
  handle('playbooks:list', ({ companyId }) => p().list(companyId))
  handle('playbooks:summary', () => p().summary())
  handle('playbooks:overview', ({ companyId }) => playbookOverview(h, companyId))
  handle('playbooks:turnOn', ({ companyId, playbookId, level, raise, limits }) => p().turnOn(companyId, playbookId, { level, raise, limits: limits ?? undefined }))
  handle('playbooks:configure', ({ companyId, playbookId, level, raise, limits }) => p().configure(companyId, playbookId, { level, raise, limits: limits ?? undefined }))
  handle('playbooks:setPaused', ({ companyId, playbookId, paused }) => p().setPaused(companyId, playbookId, paused))
  handle('playbooks:turnOff', ({ companyId, playbookId }) => p().turnOff(companyId, playbookId))
}
