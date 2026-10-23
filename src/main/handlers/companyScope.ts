/**
 * Company stamping and guards shared by the IPC handlers (COMPANY.md §3, §6). Every company question still goes
 * through CompanyStore / scope.ts; this only decides how a cross-company finding is reported: with
 * `settings.experimental.companies` on it throws, with it off it logs a warning and the write goes ahead.
 */
import path from 'node:path'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import type { Id, WorkflowDraft } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import type { SameCompanyRefs } from '../company'
import { log } from '../log'

/** The minimal surface used here (lets pure tests pass a store + company module without a full Hive). */
export type ScopeHost = Pick<Hive, 'store' | 'company'>

/** An explicit company must exist; absent = Personal. */
export function requireCompany(h: ScopeHost, companyId: Id | null | undefined): Id {
  if (!companyId) return PERSONAL_COMPANY_ID
  const c = h.company.listPassports({ includeArchived: true }).find((p) => p.id === companyId)
  if (!c) throw new HiveError('not_found', 'Company not found')
  return c.id
}

/** Throws with the flag on; otherwise logs and lets the caller stamp anyway. Returns the problem (null = same company). */
export function guardSameCompany(h: ScopeHost, companyId: Id, refs: SameCompanyRefs, what: string): string | null {
  if (h.store.companyGuardsEnforced()) {
    h.company.assertSameCompany(companyId, refs)
    return null
  }
  const problem = h.company.crossCompany(companyId, refs)
  if (problem) log.warn('company guard (not enforced)', { what, companyId, problem })
  return problem
}

/**
 * Repo targets a workflow names (§3 Workflows guard): node cwds that are repo ids or absolute paths, plus the worktree
 * repo. Templates (`{{inputs.repo}}`) are resolved at run time by the executor, which checks them there.
 */
export function workflowRepoRefs(h: ScopeHost, draft: Pick<WorkflowDraft, 'nodes' | 'worktree'>): SameCompanyRefs[] {
  const refs: SameCompanyRefs[] = []
  const add = (target: string | null | undefined) => {
    const t = target?.trim()
    if (!t || t.includes('{{')) return
    if (h.store.getRepo(t)) refs.push({ repoId: t })
    else if (path.isAbsolute(t)) refs.push({ cwd: t })
  }
  for (const n of draft.nodes) add(n.cwd)
  add(draft.worktree?.repo)
  return refs
}

/** Guards every repo target of a workflow against its company (first problem wins). */
export function guardWorkflowTargets(h: ScopeHost, companyId: Id, draft: Pick<WorkflowDraft, 'nodes' | 'worktree'>): string | null {
  for (const ref of workflowRepoRefs(h, draft)) {
    const problem = guardSameCompany(h, companyId, ref, 'workflow')
    if (problem) return problem
  }
  return null
}

/** The company a workflow is stamped with (NULL / missing reads as Personal). */
export function workflowCompany(h: ScopeHost, workflowId: Id): Id {
  return h.store.getWorkflow(workflowId)?.companyId ?? PERSONAL_COMPANY_ID
}
