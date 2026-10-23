import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import type { Id, WorkflowDraft, WorkflowFile } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { checkAfterProblems } from '../../shared/authoring'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { workflowFile, zodErrors } from '../ipcSchemas'
import { migrateNotifyNode } from '../db/slackMigration'
import { guardWorkflowTargets, requireCompany } from './companyScope'

/** SPEC A4: a check's `after` defaults to [target]; it may also name nodes downstream of the target (loop body). */
export function normalizeDraft(d: WorkflowDraft): WorkflowDraft {
  return {
    name: d.name.trim(),
    description: d.description ?? '',
    inputs: d.inputs ?? [],
    // SLACK.md §10.4: a legacy notify `imessage` (imports, older editors) becomes `slack`
    nodes: d.nodes.map((n) => migrateNotifyNode(n.type === 'check' && !(n.after ?? []).length ? { ...n, after: n.target ? [n.target] : [] } : n)),
    ...(d.slackTools ? { slackTools: true, ...(d.slackAgentPermissions === 'profile' ? { slackAgentPermissions: 'profile' as const } : {}) } : {}),
    // AUTHORING.md §6: the workflow-level worktree block survives save/import
    ...(d.worktree?.repo
      ? { worktree: { repo: d.worktree.repo, base: d.worktree.base ?? null, ...(d.worktree.pushBranches?.length ? { pushBranches: d.worktree.pushBranches } : {}) } }
      : {})
  }
}

/** `workflowId`: an existing workflow; when it has Slack triggers the Slack-driven rules apply (no step output in a command). */
export function validateDraft(h: Hive, draft: WorkflowDraft, workflowId?: string): void {
  const slackTriggered = !!workflowId && h.safe(() => (h.slack?.listTriggers(workflowId).length ?? 0) > 0, true)
  const errors = [...h.engine.workflows.validate(draft, { slackTriggered }), ...checkAfterProblems(draft).errors]
  if (!draft.name) errors.unshift({ path: 'name', message: 'Name is required' })
  if (errors.length) throw new HiveError('validation', errors[0].message, errors)
}

/** Imported files come from other machines: unknown profile ids are mapped to this Mac's default agent profile. */
export function remapProfiles(h: Hive, d: WorkflowDraft): WorkflowDraft {
  const profiles = h.store.listProfiles()
  const known = new Set(profiles.map((p) => p.id))
  const fallback = profiles.find((p) => p.adapter === 'claude') ?? profiles.find((p) => p.adapter !== 'shell')
  if (!fallback) return d
  // marketplace files name a provider instead of a profile: "prof_codex" -> this Mac's first Codex profile
  const byAdapter = (id: string) => profiles.find((p) => `prof_${p.adapter}` === id)
  const fix = (id: string) => (known.has(id) ? id : (byAdapter(id)?.id ?? fallback.id))
  return {
    ...d,
    nodes: d.nodes.map((n) => {
      if (n.type === 'agent') return { ...n, profileId: fix(n.profileId) }
      if (n.type === 'check') return { ...n, profileId: n.profileId ? fix(n.profileId) : null }
      if (n.type === 'room') return { ...n, participants: n.participants.map((p) => ({ ...p, profileId: fix(p.profileId) })) }
      return n
    })
  }
}

export async function importWorkflowFromDialog(h: Hive, win: BrowserWindow | null, companyId?: Id) {
  const opts: Electron.OpenDialogOptions = {
    title: 'Import Workflow',
    properties: ['openFile'],
    filters: [{ name: 'Hive Workflow', extensions: ['json'] }]
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled || !r.filePaths[0]) return null
  let raw: unknown
  try {
    const st = fs.statSync(r.filePaths[0])
    if (st.size > 5 * 1024 * 1024) throw new Error('File is larger than 5 MB')
    raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
  } catch (e) {
    throw new HiveError('bad_request', `Not a Hive workflow file: ${e instanceof Error ? e.message : String(e)}`)
  }
  return importWorkflowFile(h, raw, companyId)
}

/** A parsed .hive.json -> its draft (profiles remapped to this Mac), unsaved. */
export function parseWorkflowFile(h: Hive, raw: unknown): WorkflowDraft {
  const parsed = workflowFile.safeParse(raw)
  if (!parsed.success) throw new HiveError('bad_request', 'Not a Hive workflow file (.hive.json)', zodErrors(parsed.error))
  return normalizeDraft(remapProfiles(h, parsed.data.workflow as WorkflowDraft))
}

/** Workflows › Import and the marketplace: validate and save a parsed .hive.json into companyId (else Personal). */
export function importWorkflowFile(h: Hive, raw: unknown, companyId?: Id) {
  const draft = parseWorkflowFile(h, raw)
  validateDraft(h, draft)
  const target = requireCompany(h, companyId)
  guardWorkflowTargets(h, target, draft)
  const wf = h.store.createWorkflow(draft, null, null, target)
  emit('data:changed', { domain: 'workflows' })
  return wf
}

export function registerWorkflowHandlers(h: Hive): void {
  handle('workflows:list', (q) => h.store.listWorkflows(q?.companyId))
  handle('workflows:get', ({ id }) => {
    const wf = h.store.getWorkflow(id)
    if (!wf) throw new HiveError('not_found', 'Workflow not found')
    return wf
  })
  handle('workflows:create', (raw) => {
    const draft = normalizeDraft(raw as WorkflowDraft)
    validateDraft(h, draft)
    // COMPANY.md §3: the company it is created from; its repo targets must belong to it (guarded, §6)
    const companyId = requireCompany(h, raw.companyId)
    guardWorkflowTargets(h, companyId, draft)
    const wf = h.store.createWorkflow(draft, null, null, companyId)
    emit('data:changed', { domain: 'workflows' })
    return wf
  })
  handle('workflows:update', ({ id, draft: raw }) => {
    const existing = h.store.getWorkflow(id)
    if (!existing) throw new HiveError('not_found', 'Workflow not found')
    const draft = normalizeDraft(raw as WorkflowDraft)
    validateDraft(h, draft, id)
    guardWorkflowTargets(h, existing.companyId ?? requireCompany(h, null), draft)
    const wf = h.store.updateWorkflow(id, draft)
    emit('data:changed', { domain: 'workflows' })
    return wf
  })
  handle('workflows:remove', ({ id }) => {
    // DEPARTMENTS.md §1.1: an agent seat never points at a deleted workflow
    h.company.departments.assertNotBacking('workflow', id)
    h.store.removeWorkflow(id)
    h.author?.onWorkflowRemoved(id) // AUTHORING.md §2.4: deleting a workflow deletes its run permissions
    emit('data:changed', { domain: 'workflows' })
  })
  handle('workflows:duplicate', ({ id, companyId }) => {
    const wf = h.store.getWorkflow(id)
    if (!wf) throw new HiveError('not_found', 'Workflow not found')
    // "Duplicate to company…" (COMPANY.md §3): a new row in the target company, seed_key NULL
    const target = companyId ? requireCompany(h, companyId) : (wf.companyId ?? requireCompany(h, null))
    const draft: WorkflowDraft = { name: `${wf.name} copy`, description: wf.description, inputs: wf.inputs, nodes: wf.nodes, ...(wf.worktree ? { worktree: wf.worktree } : {}) }
    guardWorkflowTargets(h, target, draft)
    // a copy is the user's own: no agent provenance (origin) carried over
    const copy = h.store.createWorkflow(draft, null, null, target)
    emit('data:changed', { domain: 'workflows' })
    return copy
  })
  handle('workflows:validate', (raw) => {
    const draft = normalizeDraft(raw as WorkflowDraft)
    const errors = h.engine.workflows.validate(draft)
    if (!draft.name) errors.unshift({ path: 'name', message: 'Name is required' })
    return errors
  })
  handle('workflows:export', async ({ id }, sender) => {
    const wf = h.store.getWorkflow(id)
    if (!wf) throw new HiveError('not_found', 'Workflow not found')
    const win = BrowserWindow.fromWebContents(sender)
    const safeName = wf.name.replace(/[/\\:*?"<>|]+/g, '-').trim() || 'workflow'
    const opts: Electron.SaveDialogOptions = {
      title: 'Export Workflow',
      defaultPath: path.join(app.getPath('documents'), `${safeName}.hive.json`),
      filters: [{ name: 'Hive Workflow', extensions: ['json'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const file: WorkflowFile = {
      hive: 'workflow',
      version: 1,
      // export omits `origin` (AUTHORING.md §2.5)
      workflow: { name: wf.name, description: wf.description, inputs: wf.inputs, nodes: wf.nodes, ...(wf.worktree ? { worktree: wf.worktree } : {}) }
    }
    fs.writeFileSync(r.filePath, `${JSON.stringify(file, null, 2)}\n`)
    return { path: r.filePath }
  })
  handle('workflows:import', (q, sender) => importWorkflowFromDialog(h, BrowserWindow.fromWebContents(sender), q?.companyId))
}
