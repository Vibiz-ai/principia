/**
 * Review fixes for Slack-driven runs (SLACK.md SA2 / §9.2 / §9.4):
 * - step output never reaches a shell, wait or check command in a Slack-triggered (or slackTools) workflow, at
 *   validation and again at run time; commands read it as data from $HIVE_OUT_<NODE> instead;
 * - a Slack-driven run works in its own folder, never the shared scratch dir;
 * - memory is read-only for restricted Slack-driven agents.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryGrantRequest } from '../../../shared/engine'
import type { SlackAgentAccess, SlackRunContext, SlackTriggerInput } from '../../../shared/slack'
import type { AgentNode, CheckNode, ShellNode, WaitNode, WorkflowDraft, WorkflowNode } from '../../../shared/types'
import { hiveOutVar, validateSlackTrigger, validateWorkflow } from '../validate'
import { addWorkflow, fakeAdapter, fakeCtx, makeEngine, profile, waitRun, type FakeCall } from './fakes'

const agent = (id: string, x: Partial<AgentNode> = {}): AgentNode => ({ id, type: 'agent', label: id, after: [], cwd: null, timeoutMin: 1, profileId: 'p_claude', prompt: 'answer', ...x })
const shell = (id: string, command: string, x: Partial<ShellNode> = {}): ShellNode => ({ id, type: 'shell', label: id, after: [], cwd: null, timeoutMin: 1, command, ...x })
const wait = (id: string, command: string): WaitNode => ({ id, type: 'wait', label: id, after: [], cwd: null, timeoutMin: 1, command, until: 'exit0', pattern: null, intervalSec: 5, onTimeout: 'fail' })
const checkCmd = (id: string, target: string, command: string): CheckNode => ({ id, type: 'check', label: id, after: [target], cwd: null, timeoutMin: 1, profileId: null, command, target, criteria: '', maxRetries: 0 })

const sctx = (access?: SlackAgentAccess): SlackRunContext => ({
  triggerId: 'stg_1',
  teamId: 'T1',
  channelId: 'C1',
  channelName: 'support',
  channelKind: 'channel',
  threadTs: '1792141200.000100',
  messageTs: ['1792141200.000100'],
  userId: 'U1',
  userName: 'Dana Lee',
  text: 'q',
  permalink: '',
  isMention: true,
  isDm: false,
  catchup: false,
  ...(access ? { access } : {})
})

const deps = { getProfile: () => profile('p_claude', 'claude'), getRepo: () => null }

describe('validation: no step output in a command of a Slack-driven workflow', () => {
  const wf = (nodes: WorkflowNode[], x: Partial<WorkflowDraft> = {}): WorkflowDraft => ({ name: 'w', description: '', inputs: [], nodes, ...x })
  const bad = [
    wf([agent('a'), shell('s', 'echo {{a.output}}')]),
    wf([agent('a'), wait('w', 'test -n "{{a.transcript}}"')]),
    wf([agent('a'), checkCmd('c', 'a', 'grep ok <<< "{{a.output}}"')])
  ]

  it('refuses {{node.output}} / {{node.transcript}} in shell, wait and check commands when the workflow has a Slack trigger', () => {
    for (const d of bad) {
      expect(validateWorkflow(d, deps), 'editor workflow without a trigger keeps working').toEqual([])
      const errs = validateWorkflow(d, { ...deps, slackTriggered: true })
      expect(errs).toHaveLength(1)
      expect(errs[0]!.message).toMatch(/reads Slack, so another step's output never runs as shell; read it as data from "\$HIVE_OUT_A"/)
    }
  })

  it('slackTools: true is Slack-driven too', () => {
    expect(validateWorkflow({ ...bad[0]!, slackTools: true }, deps)[0]!.message).toMatch(/HIVE_OUT_A/)
  })

  it('outputs stay allowed in prompts and notify messages, and $HIVE_OUT_<NODE> in commands', () => {
    const ok = wf([agent('a'), agent('b', { prompt: 'Review {{a.output}}' }), shell('s', 'jq -r .url "$HIVE_OUT_A"')])
    expect(validateWorkflow(ok, { ...deps, slackTriggered: true })).toEqual([])
  })

  it('a Slack trigger cannot be added to a workflow that runs step output as shell', () => {
    const input: SlackTriggerInput = { name: 't', workflowId: 'wf_1', match: { on: ['mention'], channels: [], keywords: [], regex: null, fromUsers: [] }, reply: { mode: 'draft', autoChannels: [] } }
    const errs = validateSlackTrigger(input, { workflow: bad[0]! })
    expect(errs.map((e) => e.message).join('\n')).toMatch(/\{\{a\.output\}\} in a command.*HIVE_OUT_A.*before adding a Slack trigger/)
    expect(validateSlackTrigger(input, { workflow: wf([agent('a'), shell('s', 'cat "$HIVE_OUT_A"')]) })).toEqual([])
  })

  it('$HIVE_OUT_<NODE> names: upper case, - becomes _', () => {
    expect(hiveOutVar('scan')).toBe('HIVE_OUT_SCAN')
    expect(hiveOutVar('review-claude_2')).toBe('HIVE_OUT_REVIEW_CLAUDE_2')
  })
})

// NEVER put a destructive command in a fake output: a manual (non-Slack) run legitimately interpolates it into a shell.
async function setup(nodes: WorkflowNode[], output = 'model said: $(touch pwned) `id`', x: Partial<WorkflowDraft> = {}) {
  const ctx = fakeCtx()
  ctx.profiles.set('p_claude', profile('p_claude', 'claude'))
  const calls: FakeCall[] = []
  const claude = fakeAdapter('claude', calls, () => ({ output }))
  const wf = addWorkflow(ctx, { name: 'Support', description: '', inputs: [], nodes, ...x })
  const engine = await makeEngine(ctx, { adapters: { claude }, available: ['claude', 'shell'] })
  return { ctx, calls, wf, engine }
}

describe('$HIVE_OUT_<NODE>: commands read upstream output as data', () => {
  it('a shell step gets the path of each finished node output file, byte for byte, never interpolated', async () => {
    const out = 'model said: $(touch pwned) `id`'
    const s = await setup([agent('review-a'), shell('use', 'printf "%s" "$(cat "$HIVE_OUT_REVIEW_A")"', { after: ['review-a'] })], out)
    const run = await waitRun(s.ctx, s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'manual' }).id)
    expect(run.status).toBe('passed')
    const steps = s.ctx.store.stepsOf(run.id)
    expect(steps.find((x) => x.nodeId === 'use')!.output).toBe(out)
    expect(existsSync(join(s.ctx.paths.scratchDir, 'pwned'))).toBe(false)
    const file = join(s.ctx.paths.runLogsDir, run.id, 'out', 'review-a.txt')
    expect(readFileSync(file, 'utf8')).toBe(out)
  })

  it('works in a Slack-triggered run (the safe alternative to {{node.output}})', async () => {
    const s = await setup([agent('answer'), shell('log', 'wc -c < "$HIVE_OUT_ANSWER" | tr -d " "', { after: ['answer'] })], 'twelve chars')
    const run = await waitRun(s.ctx, s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'slack', slack: sctx() }).id)
    expect(run.status).toBe('passed')
    expect(s.ctx.store.stepsOf(run.id).find((x) => x.nodeId === 'log')!.output).toBe('12')
  })
})

describe('run time: a Slack-driven run refuses step output in a command (fail closed)', () => {
  it('startRun refuses a Slack-triggered run of such a workflow', async () => {
    const s = await setup([agent('a'), shell('s', 'echo {{a.output}}')], 'plain text')
    expect(() => s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'slack', slack: sctx() })).toThrow(/invalid/)
    // a manual run of the same (trigger-less) workflow is unchanged
    const run = await waitRun(s.ctx, s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'manual' }).id)
    expect(run.status).toBe('passed')
  })

  for (const kind of ['shell', 'wait', 'check'] as const) {
    it(`a ${kind} command that slipped past validation never runs with the output in it`, async () => {
      const node = kind === 'shell' ? shell('cmd', 'true', { after: ['a'] }) : kind === 'wait' ? { ...wait('cmd', 'true'), after: ['a'] } : checkCmd('cmd', 'a', 'true')
      const s = await setup([agent('a'), node])
      const run0 = s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'slack', slack: sctx() })
      // an older stored workflow / a changed snapshot: the command now templates the agent's (Slack-influenced) output
      ;(node as { command: string }).command = `touch "${join(s.ctx.root, 'ran')}" {{a.output}}`
      const run = await waitRun(s.ctx, run0.id)
      expect(run.status).toBe('failed')
      expect(run.reason).toMatch(/\{\{a\.output\}\} in a command: .*\$HIVE_OUT_A/)
      expect(existsSync(join(s.ctx.root, 'ran'))).toBe(false)
    })
  }

  it('{{trigger.*}} in a command is refused at run time too', async () => {
    const node = shell('cmd', 'true', { after: ['a'] })
    const s = await setup([agent('a'), node], 'x', { slackTools: true })
    const run0 = s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'manual' })
    node.command = `touch "${join(s.ctx.root, 'ran')}" {{trigger.text}}`
    const run = await waitRun(s.ctx, run0.id)
    expect(run.status).toBe('failed')
    expect(run.reason).toMatch(/Slack text is untrusted/)
    expect(existsSync(join(s.ctx.root, 'ran'))).toBe(false)
  })
})

describe('a Slack-driven run works in its own folder', () => {
  it('Slack-triggered steps without a folder run in scratch/slack-runs/<runId>, removed when left empty; other runs keep scratch', async () => {
    const s = await setup([agent('a'), shell('pwd', 'pwd -P', { after: ['a'] })])
    const run = await waitRun(s.ctx, s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'slack', slack: sctx() }).id)
    expect(run.status).toBe('passed')
    const dir = join(s.ctx.paths.scratchDir, 'slack-runs', run.id)
    for (const st of s.ctx.store.stepsOf(run.id)) expect(st.cwd).toBe(dir)
    expect(existsSync(dir)).toBe(false)

    const plain = await waitRun(s.ctx, s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'manual' }).id)
    for (const st of s.ctx.store.stepsOf(plain.id)) expect(st.cwd).toBe(s.ctx.paths.scratchDir)
  })

  it('two Slack-triggered runs never share a folder', async () => {
    const s = await setup([agent('a')])
    const r1 = s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'slack', slack: sctx() })
    const r2 = s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, { trigger: 'slack', slack: { ...sctx(), threadTs: '1792141300.000100' } })
    await waitRun(s.ctx, r1.id)
    await waitRun(s.ctx, r2.id)
    const c1 = s.ctx.store.stepsOf(r1.id)[0]!.cwd
    const c2 = s.ctx.store.stepsOf(r2.id)[0]!.cwd
    expect(c1).not.toBe(c2)
    expect(c1.startsWith(join(s.ctx.paths.scratchDir, 'slack-runs'))).toBe(true)
  })
})

describe('memory is read-only for restricted Slack-driven agents', () => {
  async function grantsFor(slack: SlackRunContext | null, x: Partial<WorkflowDraft> = {}): Promise<MemoryGrantRequest[]> {
    const s = await setup([agent('a', { memory: 'read-write' })], 'ok', x)
    const requests: MemoryGrantRequest[] = []
    s.ctx.memory = {
      grant: (req) => {
        requests.push(req)
        return null
      },
      release: () => {}
    }
    const run = await waitRun(s.ctx, s.engine.runs.start({ kind: 'workflow', workflowId: s.wf.id, inputs: {} }, slack ? { trigger: 'slack', slack } : { trigger: 'manual' }).id)
    expect(run.status).toBe('passed')
    return requests
  }

  it('read-write becomes read in a Slack-triggered run; full permissions keep read-write; other runs unchanged', async () => {
    expect((await grantsFor(sctx()))[0]).toMatchObject({ mode: 'read' })
    expect((await grantsFor(sctx({ fullPermissions: true, secretNames: [] })))[0]).toMatchObject({ mode: 'read-write' })
    expect((await grantsFor(null, { slackTools: true }))[0]).toMatchObject({ mode: 'read' })
    expect((await grantsFor(null))[0]).toMatchObject({ mode: 'read-write' })
  })
})
