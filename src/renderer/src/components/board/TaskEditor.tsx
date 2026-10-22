import { useState } from 'react'
import { TASK_SOURCES, TASK_STATUSES, type CompanyPassport, type CompanyTask, type CompanyTaskInput, type TaskSource, type TaskStatus } from '@shared/company'
import { Button, Sheet } from '../ui'
import { TaskStatusIcon } from '../TaskBits'
import { PRIORITIES, SOURCE_LABEL, STATUS_LABEL } from '../../lib/company'
import { companyLabel, reposOf } from '../../lib/companyModel'
import { agentsOf, departmentsOf } from '../../lib/departments'
import { errorMessage, hive } from '../../lib/hive'
import { toast, useStore } from '../../state/store'
import { CompanyChip } from '../CompanyChip'

/** Statuses a human picks in the board editor: work starts with Run now, done needs an approval, a park needs a reason. */
const BOARD_STATUSES: TaskStatus[] = ['triage', 'backlog', 'todo', 'canceled']

/**
 * New / edit task sheet. `board` (DEPARTMENTS.md §9, departments on) adds the department and agent pickers, makes the
 * project optional (the company workspace) and keeps statuses to planning moves; without it the sheet is today's.
 */
export function TaskEditor({ task, companies, tasks, defaultCompanyId, lockCompany = false, board = false, defaultDepartmentId = null, onClose, onSaved }: { task?: CompanyTask; companies: CompanyPassport[]; tasks: CompanyTask[]; defaultCompanyId: string; lockCompany?: boolean; board?: boolean; defaultDepartmentId?: string | null; onClose: () => void; onSaved: (task: CompanyTask) => void }): React.JSX.Element {
  const repos = useStore((s) => s.repos)
  const profiles = useStore((s) => s.profiles)
  const allDepartments = useStore((s) => s.departments)
  const allAgents = useStore((s) => s.companyAgents)
  const [draft, setDraft] = useState<CompanyTaskInput>(() => task ? { title: task.title, description: task.description, companyId: task.companyId, repoId: task.repoId, status: task.status, priority: task.priority, source: task.source, sourceUrl: task.sourceUrl, externalId: task.externalId, assigneeProfileId: task.assigneeProfileId, parentId: task.parentId, dependencyIds: [...task.dependencyIds], ...(board ? { departmentId: task.departmentId ?? null, agentId: task.agentId ?? null } : {}) } : { title: '', description: '', companyId: defaultCompanyId, repoId: null, status: board ? (defaultDepartmentId ? 'todo' : 'triage') : 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], ...(board ? { departmentId: defaultDepartmentId, agentId: null } : {}) })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const update = <K extends keyof CompanyTaskInput>(key: K, value: CompanyTaskInput[K]): void => setDraft((d) => ({ ...d, [key]: value }))
  // a company's repos (Personal owns every unassigned one, §2.2)
  const eligibleRepos = reposOf(repos, draft.companyId)
  const departments = departmentsOf(allDepartments, draft.companyId)
  const seats = allAgents.filter((a) => a.companyId === draft.companyId && !a.archivedAt && (!draft.departmentId || a.departmentId === draft.departmentId || a.departmentId === null))
  // the agent follows its department: picking another department drops a seat of the old one
  const pickDepartment = (id: string | null): void => setDraft((d) => {
    const seat = allAgents.find((a) => a.id === d.agentId)
    return { ...d, departmentId: id, agentId: seat && (seat.departmentId === null || seat.departmentId === id) ? d.agentId : null, status: d.status === 'triage' && id ? 'todo' : d.status }
  })
  const pickAgent = (id: string | null): void => setDraft((d) => {
    const seat = allAgents.find((a) => a.id === id)
    return { ...d, agentId: id, departmentId: seat?.departmentId ?? d.departmentId ?? null, status: d.status === 'triage' && id ? 'todo' : d.status }
  })
  const save = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const result = task ? await hive.tasks.update({ id: task.id, patch: draft }) : await hive.tasks.create({ task: draft })
      onSaved(result); toast(task ? 'Task updated' : 'Task created')
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  const statuses = board ? TASK_STATUSES.filter((s) => BOARD_STATUSES.includes(s) || s === task?.status) : TASK_STATUSES.filter((s) => s !== 'in_progress' || task?.status === 'in_progress')
  return <Sheet title={task ? `Edit ${task.identifier}` : 'New task'} onCancel={() => { if (!busy) onClose() }} onPrimary={() => void save()} primaryLabel={busy ? 'Saving…' : task ? 'Save task' : 'Create task'} primaryDisabled={busy || !draft.title.trim() || !draft.companyId || draft.source !== 'manual' && !draft.sourceUrl?.trim()} width={620}>
    <div className="company-form task-editor">
      {error && <div className="company-error" role="alert">{error}</div>}
      <label className="company-field">Title<input data-autofocus placeholder="What needs to happen?" maxLength={240} value={draft.title} onChange={(e) => update('title', e.target.value)} /></label>
      <label className="company-field">Description<textarea rows={4} placeholder="Describe the outcome, context and how you’ll know it’s done." value={draft.description} onChange={(e) => update('description', e.target.value)} maxLength={20000} /></label>
      <div className="company-form-grid"><label className="company-field">Company{task || lockCompany ? <span className="task-editor-company"><CompanyChip companyId={draft.companyId} always /></span> : <select value={draft.companyId} onChange={(e) => setDraft((d) => ({ ...d, companyId: e.target.value, repoId: null, parentId: null, dependencyIds: [], ...(board ? { departmentId: null, agentId: null } : {}) }))}>{companies.map((c) => <option key={c.id} value={c.id}>{companyLabel(c, true)}</option>)}</select>}</label>
      {board && <label className="company-field">Department<select value={draft.departmentId ?? ''} disabled={task?.status === 'in_progress'} onChange={(e) => pickDepartment(e.target.value || null)}><option value="">No department (Inbox)</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
      {board && <label className="company-field">Agent<select value={draft.agentId ?? ''} disabled={task?.status === 'in_progress'} onChange={(e) => pickAgent(e.target.value || null)}><option value="">{draft.departmentId ? 'Route automatically' : 'Unassigned'}</option>{seats.map((a) => <option key={a.id} value={a.id}>{a.name}{a.pausedAt ? ' (paused)' : ''}</option>)}</select>{draft.departmentId && !agentsOf(allAgents, draft.companyId, draft.departmentId).length && <small>This department has no agents yet; the task waits in Needs you.</small>}</label>}
      <label className="company-field">Project<select value={draft.repoId ?? ''} onChange={(e) => update('repoId', e.target.value || null)}><option value="">{board ? 'Company workspace (no repository)' : 'Choose before running an agent'}</option>{eligibleRepos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>{!board && !eligibleRepos.length && <small>Assign a project to this company in Company settings first.</small>}</label>
      <label className="company-field">Status<select value={draft.status} disabled={task?.status === 'in_progress'} onChange={(e) => update('status', e.target.value as TaskStatus)}>{statuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
      <label className="company-field">Priority<select value={draft.priority} onChange={(e) => update('priority', Number(e.target.value) as CompanyTaskInput['priority'])}>{PRIORITIES.map((p, i) => <option key={p} value={i}>{p}</option>)}</select></label>
      <label className="company-field">Source<select value={draft.source} onChange={(e) => update('source', e.target.value as TaskSource)}>{TASK_SOURCES.filter((s) => (s !== 'agent' && s !== 'schedule') || s === task?.source).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></label>
      {!board && <label className="company-field">Assigned agent<select value={draft.assigneeProfileId ?? ''} onChange={(e) => update('assigneeProfileId', e.target.value || null)}><option value="">Unassigned</option>{profiles.filter((p) => p.adapter !== 'shell').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}</div>
      <label className="company-field">Source link{draft.source !== 'manual' ? ' · required' : ' · optional'}<input type="url" placeholder="https://…" value={draft.sourceUrl ?? ''} onChange={(e) => update('sourceUrl', e.target.value || null)} /><small>Keep the original issue, message or insight attached. This adds a reference, not a live integration.</small></label>
      {draft.source === 'github' && <Button icon="download" disabled={busy || !draft.sourceUrl?.trim()} onClick={() => { setBusy(true); setError(null); void hive.tasks.previewGithub({ url: draft.sourceUrl! }).then((issue) => { setDraft((d) => ({ ...d, title: issue.title, description: issue.description, source: issue.source, sourceUrl: issue.sourceUrl, externalId: issue.externalId })); if (issue.truncated) toast('Long issue description shortened. Review before creating.') }, (e: unknown) => setError(errorMessage(e))).finally(() => setBusy(false)) }}>Fetch GitHub issue or pull request</Button>}
      <label className="company-field">Parent task<select value={draft.parentId ?? ''} onChange={(e) => update('parentId', e.target.value || null)}><option value="">No parent</option>{tasks.filter((t) => t.companyId === draft.companyId && t.id !== task?.id).map((t) => <option key={t.id} value={t.id}>{t.identifier} · {t.title}</option>)}</select></label>
      {tasks.some((t) => t.companyId === draft.companyId && t.id !== task?.id) && <fieldset className="company-checklist"><legend>Depends on</legend>{tasks.filter((t) => t.companyId === draft.companyId && t.id !== task?.id).map((t) => <label key={t.id}><input type="checkbox" checked={draft.dependencyIds.includes(t.id)} onChange={(e) => update('dependencyIds', e.target.checked ? [...draft.dependencyIds, t.id] : draft.dependencyIds.filter((id) => id !== t.id))} /><TaskStatusIcon status={t.status} /><span>{t.identifier} · {t.title}</span></label>)}</fieldset>}
    </div>
  </Sheet>
}
