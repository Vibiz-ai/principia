/**
 * Five doors step 5 (design §4.5, pm-review E13): the quick create row at the top of To do. A real input: type a
 * title, ↵ creates, ⌘↵ creates and starts, Esc clears. Chips under it: Department and Agent ("auto" lets the board
 * route it) and, in a code company, a working repository picker with the branch Start will create. "More options…"
 * opens the full sheet (parent, depends on, source).
 */
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { CompanyPassport, CompanyTask, CompanyTaskInput } from '@shared/company'
import type { Id } from '@shared/types'
import { reposOf } from '../../lib/companyModel'
import { departmentsOf } from '../../lib/departments'
import { errorMessage, hive } from '../../lib/hive'
import { nextIdentifier, quickBranchLine, quickRoute } from '../../lib/boardFlow'
import { useDeskAgents } from '../../state/desk'
import { toast, useStore } from '../../state/store'
import { Icon } from '../Icon'

/** seed: ⌘K's "New task: …" lands here with its title typed, so the chips and the branch line show before ↵ */
export interface QuickCreateHandle { focus: () => void; seed: (title: string) => void }

export const QuickCreate = forwardRef<QuickCreateHandle, { company: CompanyPassport; tasks: CompanyTask[]; defaultDepartmentId: Id | null; onCreated: (t: CompanyTask) => void; onMore: () => void }>(function QuickCreate({ company, tasks, defaultDepartmentId, onCreated, onMore }, ref) {
  const allRepos = useStore((s) => s.repos)
  const allDepartments = useStore((s) => s.departments)
  const allAgents = useStore((s) => s.companyAgents)
  const repos = useMemo(() => reposOf(allRepos, company.id), [allRepos, company.id])
  const code = repos.length > 0
  const departments = useMemo(() => departmentsOf(allDepartments, company.id), [allDepartments, company.id])
  const [title, setTitle] = useState('')
  const [depId, setDepId] = useState<Id | ''>(defaultDepartmentId ?? '')
  const [agentId, setAgentId] = useState<Id | ''>('')
  // a code company's task works in a repository by default (its first); "No repository" keeps it in the workspace
  const [repoId, setRepoId] = useState<Id | ''>(() => repos[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => { setOpen(true); input.current?.focus() }, seed: (t) => { setTitle(t); setOpen(true); input.current?.focus() } }))
  const seats = allAgents.filter((a) => a.companyId === company.id && !a.archivedAt && (!depId || a.departmentId === depId || a.departmentId === null))
  const desk = useDeskAgents(company.id)
  // "auto" really picks someone: the agent the title reaches (as the Ask box routes), shown on the chip before ↵
  const auto = useMemo(() => (agentId ? null : quickRoute(title, depId || null, allAgents.filter((a) => a.companyId === company.id), desk)), [agentId, title, depId, allAgents, company.id, desk])
  const autoName = auto ? (desk.find((d) => d.id === auto.agentId)?.name ?? null) : null
  const autoDep = auto && !depId ? (departments.find((d) => d.id === auto.departmentId)?.name ?? null) : null
  const repo = repos.find((r) => r.id === repoId) ?? null
  // the counter main hands out next, raised past any task we already hold (a reload may lag a create by a moment)
  const prefix = company.taskPrefix
  const seq = Math.max(company.taskSeq ?? 0, ...tasks.filter((t) => t.companyId === company.id && prefix && t.identifier.startsWith(`${prefix}-`)).map((t) => Number(/-(\d+)$/.exec(t.identifier)?.[1] ?? 0)))
  const branchLine = code ? quickBranchLine(nextIdentifier(prefix, seq), title, repo?.name ?? null) : null
  const create = async (start: boolean): Promise<void> => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const route = agentId ? null : quickRoute(t, depId || null, allAgents.filter((a) => a.companyId === company.id), desk)
      const pickedAgent = agentId || route?.agentId || null
      const pickedDep = depId || route?.departmentId || (pickedAgent ? (allAgents.find((a) => a.id === pickedAgent)?.departmentId ?? null) : null)
      const routed = !!(pickedDep || pickedAgent)
      const task: CompanyTaskInput = { title: t, description: '', companyId: company.id, repoId: repoId || null, status: routed ? 'todo' : 'triage', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: pickedDep, agentId: pickedAgent }
      const made = await hive.tasks.create({ task })
      setTitle('')
      onCreated(made)
      if (start) {
        try {
          if (made.repoId && code) toast((await hive.taskWork.start({ id: made.id })).message)
          else { await hive.tasks.start({ id: made.id }); toast(`Started ${code ? made.identifier : made.title}`) }
        } catch (e) { toast(`Created ${code ? made.identifier : made.title}, but it didn’t start: ${errorMessage(e)}`, 'error') }
      } else {
        const who = pickedAgent ? desk.find((d) => d.id === pickedAgent)?.name : null
        toast(`Created ${code ? made.identifier : made.title}${who ? ` for ${who}` : ''}`)
      }
    } catch (e) { toast(errorMessage(e), 'error') } finally { setBusy(false) }
  }
  const expanded = open || !!title
  const depName = departments.find((d) => d.id === depId)?.name
  return <div className={`qc ${expanded ? 'is-open' : ''}`} onFocus={() => setOpen(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false) }}>
    <label className="qc__row">
      <Icon name="plus" size={13} />
      <input
        ref={input}
        className="qc__input"
        aria-label="New task title"
        placeholder="New task…"
        value={title}
        maxLength={240}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') { e.preventDefault(); void create(e.metaKey || e.ctrlKey) }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setTitle(''); input.current?.blur() }
        }}
      />
      {!expanded && <kbd className="qc__kbd" aria-hidden>C</kbd>}
    </label>
    {expanded && <>
      <div className="qc__chips">
        <select className="qc__chip" aria-label="Department" value={depId} onChange={(e) => { setDepId(e.target.value); const seat = allAgents.find((a) => a.id === agentId); if (seat && seat.departmentId && seat.departmentId !== e.target.value) setAgentId('') }}>
          <option value="">{depName ?? autoDep ?? 'Department'} · auto</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className="qc__chip" aria-label="Agent" value={agentId} onChange={(e) => { setAgentId(e.target.value); const seat = allAgents.find((a) => a.id === e.target.value); if (seat?.departmentId) setDepId(seat.departmentId) }}>
          <option value="">{autoName ?? 'Agent'} · auto</option>
          {seats.map((a) => <option key={a.id} value={a.id}>{a.name}{a.pausedAt ? ' (paused)' : ''}</option>)}
        </select>
        {code && <select className="qc__chip qc__chip--mono" aria-label="Repository" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          <option value="">No repository</option>
        </select>}
      </div>
      {branchLine && <div className="qc__branch">{branchLine}</div>}
      <div className="qc__hint"><span>↵ create · ⌘↵ create and start</span><button type="button" className="link-btn" onMouseDown={(e) => e.preventDefault()} onClick={onMore}>More options…</button></div>
    </>}
  </div>
})
