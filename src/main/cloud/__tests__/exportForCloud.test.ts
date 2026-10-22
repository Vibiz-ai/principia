// docs/CLOUD.md §8: the desktop rewrites a workflow export for the cloud. cwd under a company repo -> <repo>/<sub>,
// profiles -> prof_<adapter>, worktrees and folders outside the company refused with a plain reason, no secrets.
import { describe, expect, it } from 'vitest'
import type { AgentProfile, Workflow, WorkflowNode } from '../../../shared/types'
import type { GatewayConnection } from '../../../shared/gateway'
import { companyConnections, exportForCloud, githubRemote, referencedKeys, repoFolder, usesAgents, workflowFileOf } from '../exportForCloud'

const repos = [
  { id: 'repo_site', name: 'vibiz site', path: '/Users/l/code/vibiz-site' },
  { id: 'repo_api', name: 'api', path: '/Users/l/code/api' },
  { id: 'repo_api_docs', name: 'docs', path: '/Users/l/code/api/docs' }
]
const profiles: Pick<AgentProfile, 'id' | 'adapter' | 'secretNames'>[] = [
  { id: 'p_claude_01', adapter: 'claude', secretNames: ['*'] },
  { id: 'p_codex_77', adapter: 'codex', secretNames: ['FAL_KEY'] },
  { id: 'p_cursor', adapter: 'cursor', secretNames: [] },
  { id: 'p_shell', adapter: 'shell', secretNames: [] }
]
const agent = (id: string, p: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type: 'agent', label: id, after: [], cwd: null, timeoutMin: 30, profileId: 'p_claude_01', prompt: 'Write the brief', ...p }) as WorkflowNode
const shell = (id: string, command: string, cwd: string | null = null): WorkflowNode => ({ id, type: 'shell', label: id, after: [], cwd, timeoutMin: 5, command })
const wf = (nodes: WorkflowNode[], extra: Partial<Workflow> = {}): Workflow =>
  ({ id: 'wf_1', name: 'Morning brief', description: 'Daily', inputs: [], nodes, createdAt: '', updatedAt: '', companyId: 'co_vibiz', origin: { kind: 'agent' }, departmentId: 'dep_1', ...extra }) as unknown as Workflow

describe('exportForCloud: cwd rewrite', () => {
  it('a repo id becomes the repo folder; an absolute path under a repo becomes <folder>/<sub>', () => {
    const r = exportForCloud(workflowFileOf(wf([agent('a', { cwd: 'repo_site' }), shell('b', 'npm test', '/Users/l/code/api/packages/core'), shell('c', 'ls', '/Users/l/code/api/')])), repos, profiles)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const nodes = r.file.workflow.nodes
    expect(nodes[0].cwd).toBe('vibiz-site')
    expect(nodes[1].cwd).toBe('api/packages/core')
    expect(nodes[2].cwd).toBe('api')
    expect(r.repoIds.sort()).toEqual(['repo_api', 'repo_site'])
  })
  it('the deepest repo wins for nested repos, and null stays the company folder', () => {
    const r = exportForCloud(workflowFileOf(wf([shell('a', 'make', '/Users/l/code/api/docs/guide'), shell('b', 'pwd', null)])), repos, profiles)
    expect(r.ok && r.file.workflow.nodes.map((n) => n.cwd)).toEqual(['docs/guide', null])
  })
  it('a folder outside the company is refused with a plain reason', () => {
    const r = exportForCloud(workflowFileOf(wf([shell('a', 'ls', '/Users/l/Desktop/other')])), repos, profiles)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reasons[0]).toBe("A step runs in /Users/l/Desktop/other, which is not one of this company's repos.")
  })
  it('a lookalike prefix is not inside the repo', () => {
    const r = exportForCloud(workflowFileOf(wf([shell('a', 'ls', '/Users/l/code/api-old')])), repos, profiles)
    expect(r.ok).toBe(false)
  })
  it('a cwd template picked at run time is refused', () => {
    const r = exportForCloud(workflowFileOf(wf([shell('a', 'ls', '{{inputs.repo}}')])), repos, profiles)
    expect(!r.ok && r.reasons[0]).toMatch(/picks its folder when it starts/)
  })
  it('an unknown repo id is refused', () => {
    expect(exportForCloud(workflowFileOf(wf([shell('a', 'ls', 'repo_gone')])), repos, profiles).ok).toBe(false)
  })
})

describe('exportForCloud: profiles', () => {
  it('maps every profile reference to prof_<adapter> (agent, check, room)', () => {
    const nodes: WorkflowNode[] = [
      agent('a', { profileId: 'p_codex_77' }),
      { id: 'c', type: 'check', label: 'c', after: ['a'], cwd: null, timeoutMin: 10, profileId: 'p_claude_01', command: null, target: 'a', criteria: 'ok', maxRetries: 1 },
      { id: 'r', type: 'room', label: 'r', after: [], cwd: null, timeoutMin: 10, topic: 't', rounds: 1, final: 'last', participants: [{ profileId: 'p_claude_01', label: 'A' }, { profileId: 'p_codex_77', label: 'B' }] }
    ]
    const r = exportForCloud(workflowFileOf(wf(nodes)), repos, profiles)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [a, c, room] = r.file.workflow.nodes as [Extract<WorkflowNode, { type: 'agent' }>, Extract<WorkflowNode, { type: 'check' }>, Extract<WorkflowNode, { type: 'room' }>]
    expect(a.profileId).toBe('prof_codex')
    expect(c.profileId).toBe('prof_claude')
    expect(room.participants.map((p) => p.profileId)).toEqual(['prof_claude', 'prof_codex'])
    expect(r.adapters.sort()).toEqual(['claude', 'codex'])
  })
  it('an adapter not in the cloud (Cursor) is refused; shell steps are fine', () => {
    const r = exportForCloud(workflowFileOf(wf([agent('a', { profileId: 'p_cursor' }), shell('s', 'ls')])), repos, profiles)
    expect(!r.ok && r.reasons).toContain('A step uses Cursor, which is not in the cloud yet.')
    expect(r.adapters).toContain('shell')
  })
  it('an already-portable prof_<adapter> id passes', () => {
    expect(exportForCloud(workflowFileOf(wf([agent('a', { profileId: 'prof_claude' })])), repos, profiles).ok).toBe(true)
  })
})

describe('exportForCloud: refusals', () => {
  it('a worktree workflow stays local, in one plain sentence', () => {
    const r = exportForCloud(workflowFileOf(wf([agent('a', { isolate: 'worktree' })], { worktree: { repo: 'repo_site' } })), repos, profiles)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reasons).toEqual(['Morning brief runs in a worktree on this Mac. Worktrees are not in the cloud yet, so it stays local.'])
  })
  it('an isolated step alone is refused too', () => {
    expect(exportForCloud(workflowFileOf(wf([agent('a', { isolate: 'worktree' })])), repos, profiles).ok).toBe(false)
  })
  it('a repo-picker input is refused', () => {
    expect(exportForCloud(workflowFileOf(wf([agent('a')], { inputs: [{ name: 'repo', label: 'Repo', type: 'repo' }] })), repos, profiles).ok).toBe(false)
  })
  it('a Slack notify step is refused (Slack in the cloud comes later)', () => {
    const n: WorkflowNode = { id: 'n', type: 'notify', label: 'n', after: [], cwd: null, timeoutMin: 1, title: 't', message: 'm', slack: { kind: 'dm' } as never }
    expect(exportForCloud(workflowFileOf(wf([n])), repos, profiles).ok).toBe(false)
  })
})

describe('exportForCloud: no secrets, no stamps', () => {
  it('the output is the workflow file only: no origin, ids, company, department, slack tools', () => {
    const r = exportForCloud(workflowFileOf({ ...wf([agent('a')]), slackTools: true } as Workflow), repos, profiles)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.keys(r.file).sort()).toEqual(['hive', 'version', 'workflow'])
    expect(Object.keys(r.file.workflow).sort()).toEqual(['description', 'inputs', 'name', 'nodes'])
    const json = JSON.stringify(r.file)
    for (const leak of ['origin', 'companyId', 'co_vibiz', 'dep_1', 'p_claude_01', '/Users/l/code']) expect(json).not.toContain(leak)
  })
  it('never carries a key value even when the vault has one: keys are named, not exported', () => {
    const r = exportForCloud(workflowFileOf(wf([shell('a', 'curl -H "Authorization: $FAL_KEY" x')])), repos, profiles)
    expect(r.ok && JSON.stringify(r.file)).not.toContain('sk-live-')
  })
})

describe('referencedKeys and connections', () => {
  const known = ['FAL_KEY', 'FIRECRAWL_API_KEY', 'STRIPE_KEY', 'UNUSED_KEY', 'KEY']
  it('names only the keys a workflow mentions, as a whole word, or lists on a used profile', () => {
    const w = wf([shell('a', 'curl -H "x: ${FAL_KEY}" && echo $FIRECRAWL_API_KEY_OLD'), agent('b', { profileId: 'p_codex_77', prompt: 'Use STRIPE_KEY to list charges' })])
    expect(referencedKeys(w, known, profiles)).toEqual(['FAL_KEY', 'STRIPE_KEY'])
  })
  it("a '*' profile names no key by itself (no unused secret is ever offered)", () => {
    expect(referencedKeys(wf([agent('a', { prompt: 'hello' })]), known, profiles)).toEqual([])
  })
  it('usesAgents: agent, room and agent checks; shell-only workflows have no gateway use', () => {
    expect(usesAgents(wf([shell('a', 'ls')]))).toBe(false)
    expect(usesAgents(wf([agent('a')]))).toBe(true)
  })
  it('companyConnections: limited to the company, global, or rooted in its repos; enabled only', () => {
    const c = (id: string, p: Partial<GatewayConnection>): GatewayConnection => ({ id, name: id, transport: 'http', url: 'https://x', enabled: true, roots: [], hasCredentials: true, ...p })
    const list = [
      c('linear', { companyIds: ['co_vibiz'] }),
      c('other', { companyIds: ['co_other'] }),
      c('global', { scope: 'global' }),
      c('rooted', { roots: ['/Users/l/code'] }),
      c('off', { enabled: false, scope: 'global' }),
      c('passport', { scope: 'global' })
    ]
    expect(companyConnections(list, 'co_vibiz', repos.map((r) => r.path)).map((x) => x.id)).toEqual(['linear', 'global', 'rooted'])
  })
})

describe('repoFolder and githubRemote', () => {
  it('repo names become safe folder names', () => {
    expect(repoFolder('vibiz site')).toBe('vibiz-site')
    expect(repoFolder('../../etc')).toBe('etc')
    expect(repoFolder('')).toBe('repo')
  })
  it('https and ssh GitHub remotes become https owner/repo; others are null', () => {
    expect(githubRemote('https://github.com/vibiz-ai/quest.git')).toEqual({ url: 'https://github.com/vibiz-ai/quest', ownerRepo: 'vibiz-ai/quest' })
    expect(githubRemote('git@github.com:vibiz-ai/quest.git')).toEqual({ url: 'https://github.com/vibiz-ai/quest', ownerRepo: 'vibiz-ai/quest' })
    expect(githubRemote('https://gitlab.com/a/b.git')).toBeNull()
    expect(githubRemote(null)).toBeNull()
  })
})
