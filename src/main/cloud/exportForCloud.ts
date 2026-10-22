/**
 * Principia Cloud: rewrite a workflow export for the cloud (docs/CLOUD.md §8). Pure: no fs, no Electron.
 *
 * - A step's cwd is a repo id or an absolute path on this Mac. In the cloud each company repo is cloned to
 *   `/workspace/<companyId>/<repo-folder>`, so a cwd inside a company repo becomes `<repo-folder>/<subpath>`, relative to
 *   the company folder. Anything else (another folder, a template picked at run time) is refused with a plain reason.
 * - Profile ids are this Mac's; the cloud has one profile per adapter, so they become `prof_<adapter>`.
 * - Worktree workflows and steps are refused: worktrees are not in the cloud yet.
 * - The output is a `.hive.json` object with the workflow's own fields only (no origin, ids or company stamps). Secret
 *   values never appear: keys are named by `referencedKeys` and copied separately, only when ticked.
 */
import { CLOUD_ADAPTERS, type CloudAdapter } from '../../shared/cloud'
import type { AdapterId, AgentProfile, Workflow, WorkflowDraft, WorkflowFile, WorkflowNode } from '../../shared/types'
import type { GatewayConnection } from '../../shared/gateway'

export interface CloudRepoRef {
  id: string
  name: string
  /** absolute path on this Mac */
  path: string
}

export type CloudExport =
  | { ok: true; file: WorkflowFile; adapters: AdapterId[]; repoIds: string[] }
  | { ok: false; reasons: string[]; adapters: AdapterId[]; repoIds: string[] }

const ADAPTER_LABEL: Record<AdapterId, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', cursor: 'Cursor', shell: 'Shell' }

/** The folder a repo is cloned to in the company folder: its name, safe for a path segment. */
export function repoFolder(name: string): string {
  const s = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+$/, '')
  return s.slice(0, 80) || 'repo'
}

/** `.hive.json` exactly as workflows:export writes it (origin omitted, AUTHORING.md §2.5). */
export function workflowFileOf(wf: Pick<Workflow, 'name' | 'description' | 'inputs' | 'nodes' | 'worktree'>): WorkflowFile {
  return { hive: 'workflow', version: 1, workflow: { name: wf.name, description: wf.description, inputs: wf.inputs, nodes: wf.nodes, ...(wf.worktree ? { worktree: wf.worktree } : {}) } }
}

const norm = (p: string): string => p.replace(/\/+$/, '') || '/'

/** Rewrites one cwd, or returns the reason it cannot run in the cloud. */
function cloudCwd(cwd: string | null, repos: CloudRepoRef[], used: Set<string>): { cwd: string | null } | { reason: string } {
  if (cwd === null || cwd === '') return { cwd: null }
  if (cwd.includes('{{')) return { reason: 'A step picks its folder when it starts. The cloud needs a fixed folder.' }
  const byId = repos.find((r) => r.id === cwd)
  if (byId) {
    used.add(byId.id)
    return { cwd: repoFolder(byId.name) }
  }
  if (cwd.startsWith('/')) {
    const p = norm(cwd)
    // the longest matching repo path wins (a repo nested in another)
    const hit = repos
      .filter((r) => p === norm(r.path) || p.startsWith(`${norm(r.path)}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!hit) return { reason: `A step runs in ${cwd}, which is not one of this company's repos.` }
    used.add(hit.id)
    const sub = p.slice(norm(hit.path).length).replace(/^\/+/, '')
    if (sub.split('/').some((seg) => seg === '..')) return { reason: `A step runs in ${cwd}, outside the repo.` }
    return { cwd: sub ? `${repoFolder(hit.name)}/${sub}` : repoFolder(hit.name) }
  }
  return { reason: 'A step runs in a folder this company does not have.' }
}

/**
 * The cloud version of a workflow export, or why it stays on this Mac. `repos` are the company's repos; `profiles`
 * every profile on this Mac (ids resolve to adapters).
 */
export function exportForCloud(file: WorkflowFile, repos: CloudRepoRef[], profiles: Pick<AgentProfile, 'id' | 'adapter'>[]): CloudExport {
  const wf = file.workflow
  const reasons: string[] = []
  const adapters = new Set<AdapterId>()
  const used = new Set<string>()
  const add = (r: string): void => {
    if (!reasons.includes(r)) reasons.push(r)
  }
  if (wf.worktree) add(`${wf.name} runs in a worktree on this Mac. Worktrees are not in the cloud yet, so it stays local.`)
  if ((wf.inputs ?? []).some((i) => i.type === 'repo')) add(`${wf.name} asks for a repo when it starts. The cloud needs fixed folders.`)

  const profileOf = (id: string): string => {
    const p = profiles.find((x) => x.id === id) ?? profiles.find((x) => `prof_${x.adapter}` === id)
    if (!p) {
      add('A step uses an agent profile that is not on this Mac.')
      return id
    }
    adapters.add(p.adapter)
    if (p.adapter !== 'shell' && !(CLOUD_ADAPTERS as readonly string[]).includes(p.adapter)) add(`A step uses ${ADAPTER_LABEL[p.adapter]}, which is not in the cloud yet.`)
    return `prof_${p.adapter}`
  }

  const nodes: WorkflowNode[] = wf.nodes.map((n) => {
    if (n.isolate === 'worktree') add(`${wf.name} runs in a worktree on this Mac. Worktrees are not in the cloud yet, so it stays local.`)
    const c = cloudCwd(n.cwd, repos, used)
    if ('reason' in c) add(c.reason)
    const base = { ...n, cwd: 'cwd' in c ? c.cwd : n.cwd }
    if (n.type === 'shell' || n.type === 'wait' || (n.type === 'check' && !n.profileId)) adapters.add('shell')
    if (n.type === 'notify' && n.slack) add('A step posts to Slack. Slack in the cloud comes later.')
    switch (base.type) {
      case 'agent':
        return { ...base, profileId: profileOf(base.profileId) }
      case 'check':
        return { ...base, profileId: base.profileId ? profileOf(base.profileId) : null }
      case 'room':
        return { ...base, participants: base.participants.map((p) => ({ ...p, profileId: profileOf(p.profileId) })) }
      default:
        return base
    }
  })

  const out = { adapters: [...adapters], repoIds: [...used] }
  if (reasons.length) return { ok: false, reasons, ...out }
  // only the workflow's own fields: no origin, ids, company or department stamps; Slack tools stay on this Mac
  const draft: WorkflowDraft = { name: wf.name, description: wf.description ?? '', inputs: wf.inputs ?? [], nodes }
  return { ok: true, file: { hive: 'workflow', version: 1, workflow: draft }, ...out }
}

/** Every text an agent or a command sees in a workflow. */
function workflowText(wf: Pick<WorkflowDraft, 'description' | 'nodes'>): string {
  const parts: string[] = [wf.description ?? '']
  for (const n of wf.nodes) {
    parts.push(n.label)
    if (n.type === 'agent') parts.push(n.prompt)
    if (n.type === 'shell' || n.type === 'wait') parts.push(n.command)
    if (n.type === 'check') parts.push(n.command ?? '', n.criteria)
    if (n.type === 'room') parts.push(n.topic)
    if (n.type === 'notify') parts.push(n.title, n.message)
  }
  return parts.join('\n')
}

/**
 * The key names a workflow uses (CLOUD.md §3 "What these workflows need"): a known key named in a prompt, command or
 * message (`$FAL_KEY`, `${FAL_KEY}`, `FAL_KEY`), or listed by name on a profile a step uses. `'*'` profiles name no
 * key on their own: offering every key would offer unused secrets.
 */
export function referencedKeys(wf: Pick<WorkflowDraft, 'description' | 'nodes'>, known: string[], profiles: Pick<AgentProfile, 'id' | 'secretNames'>[] = []): string[] {
  const text = workflowText(wf)
  const out = new Set<string>()
  for (const name of known) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue
    if (new RegExp(`(^|[^A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text)) out.add(name)
  }
  const profileIds = new Set<string>()
  for (const n of wf.nodes) {
    if (n.type === 'agent') profileIds.add(n.profileId)
    if (n.type === 'check' && n.profileId) profileIds.add(n.profileId)
    if (n.type === 'room') n.participants.forEach((p) => profileIds.add(p.profileId))
  }
  for (const p of profiles) if (profileIds.has(p.id)) for (const s of p.secretNames) if (s !== '*' && known.includes(s)) out.add(s)
  return [...out].sort()
}

/** True when a workflow has an agent that can call tools (the gateway attaches its connections to such steps). */
export function usesAgents(wf: Pick<WorkflowDraft, 'nodes'>): boolean {
  return wf.nodes.some((n) => n.type === 'agent' || n.type === 'room' || (n.type === 'check' && !!n.profileId))
}

/**
 * The gateway connections a company's agents get (COMPANY.md §6): enabled, and limited to this company, or global, or
 * rooted in one of its repos. Only offered when the selected workflows have an agent step.
 */
export function companyConnections(connections: GatewayConnection[], companyId: string, repoPaths: string[]): GatewayConnection[] {
  return connections.filter((c) => {
    if (!c.enabled || c.id === 'passport') return false
    if (c.companyIds?.length) return c.companyIds.includes(companyId)
    if (c.scope === 'global') return true
    return c.roots.some((root) => repoPaths.some((p) => norm(p) === norm(root) || norm(p).startsWith(`${norm(root)}/`)))
  })
}

/** v1 adapters plus shell: what a cloud workflow may use. */
export const isCloudAdapter = (a: AdapterId): a is CloudAdapter | 'shell' => a === 'shell' || (CLOUD_ADAPTERS as readonly string[]).includes(a)

/** `https://github.com/owner/repo(.git)` or `git@github.com:owner/repo(.git)` -> https URL and owner/repo; else null. */
export function githubRemote(remote: string | null | undefined): { url: string; ownerRepo: string } | null {
  const r = (remote ?? '').trim()
  const m = r.match(/^https:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/) ?? r.match(/^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
  if (!m) return null
  return { url: `https://github.com/${m[1]}/${m[2]}`, ownerRepo: `${m[1]}/${m[2]}` }
}
