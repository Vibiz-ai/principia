import { describe, expect, it } from 'vitest'
import { INVOKE_CHANNELS, SEND_CHANNELS } from '../../shared/ipc'
import { REQUEST_SCHEMAS, SEND_SCHEMAS } from '../ipcSchemas'

describe('IPC request schemas', () => {
  it('cover every invoke and send channel', () => {
    for (const c of INVOKE_CHANNELS) expect(REQUEST_SCHEMAS[c], c).toBeDefined()
    for (const c of SEND_CHANNELS) expect(SEND_SCHEMAS[c], c).toBeDefined()
  })
  it('void channels accept undefined/null', () => {
    expect(REQUEST_SCHEMAS['app:info'].safeParse(undefined).success).toBe(true)
    expect(REQUEST_SCHEMAS['repos:pick'].safeParse(null).success).toBe(true)
    expect(REQUEST_SCHEMAS['providers:list'].safeParse(undefined).success).toBe(true)
    expect(REQUEST_SCHEMAS['providers:list'].safeParse({ refresh: true }).success).toBe(true)
  })
  it('rejects bad shapes', () => {
    expect(REQUEST_SCHEMAS['repos:add'].safeParse({ paths: ['relative/path'] }).success).toBe(false)
    expect(REQUEST_SCHEMAS['sessions:create'].safeParse({ adapter: 'vim', cols: 80, rows: 24 }).success).toBe(false)
    expect(REQUEST_SCHEMAS['settings:update'].safeParse({ hideDockWhenClosed: true }).success).toBe(false)
    expect(REQUEST_SCHEMAS['settings:update'].safeParse({ terminalFontSize: 30 }).success).toBe(false)
    expect(REQUEST_SCHEMAS['settings:update'].safeParse({ terminalFontSize: 14 }).success).toBe(true)
    expect(REQUEST_SCHEMAS['artifacts:openDir'].safeParse({}).success).toBe(false)
    expect(REQUEST_SCHEMAS['artifacts:openDir'].safeParse({ runId: 'r_abc' }).success).toBe(true)
    expect(REQUEST_SCHEMAS['sessions:kill'].safeParse({ id: '../../etc' }).success).toBe(false)
  })
  it('usage:cleanup takes run worktree, task worktree and log ids, nothing else', () => {
    const ok = (ids: string[]) => REQUEST_SCHEMAS['usage:cleanup'].safeParse({ ids }).success
    expect(ok(['wt:wt_ab12', 'tw:task_310da2a460d890c487ff', 'log:r_0000000001'])).toBe(true)
    expect(ok(['tw:../../etc'])).toBe(false)
    expect(ok(['rm:task_1'])).toBe(false)
  })
  it('accepts a full workflow draft with all node types', () => {
    const draft = {
      name: 'W',
      description: '',
      inputs: [{ name: 'repo', label: 'Repo', type: 'repo' }],
      nodes: [
        { id: 'build', type: 'agent', label: 'B', after: [], cwd: '{{inputs.repo}}', timeoutMin: 30, profileId: 'prof_1', prompt: 'x' },
        { id: 'tests', type: 'check', label: 'T', after: ['build'], cwd: null, timeoutMin: 10, profileId: null, command: 'npm test', target: 'build', criteria: '', maxRetries: 3 },
        { id: 'room', type: 'room', label: 'R', after: [], cwd: null, timeoutMin: 30, participants: [{ profileId: 'p', label: 'A' }, { profileId: 'p', label: 'B' }], topic: 't', rounds: 2, final: 'summary' },
        { id: 'sh', type: 'shell', label: 'S', after: [], cwd: null, timeoutMin: 5, command: 'echo hi' }
      ]
    }
    const r = REQUEST_SCHEMAS['workflows:create'].safeParse(draft)
    expect(r.success).toBe(true)
    expect(REQUEST_SCHEMAS['workflows:create'].safeParse({ ...draft, nodes: [{ ...draft.nodes[0], type: 'loop' }] }).success).toBe(false)
  })
  it('schedule input', () => {
    const ok = {
      name: 'Daily',
      target: { kind: 'prompt', profileId: 'prof_1', repoId: null, prompt: 'hi' },
      when: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Madrid' },
      preset: { kind: 'weekdays', time: '09:00' }
    }
    expect(REQUEST_SCHEMAS['schedules:create'].safeParse(ok).success).toBe(true)
    expect(REQUEST_SCHEMAS['schedules:create'].safeParse({ ...ok, name: '  ' }).success).toBe(false)
  })
  it('sessions:saveImage takes an image with or without a session (New conversation has none yet)', () => {
    const data = new Uint8Array([137, 80, 78, 71])
    expect(REQUEST_SCHEMAS['sessions:saveImage'].safeParse({ data, type: 'image/png' }).success).toBe(true)
    expect(REQUEST_SCHEMAS['sessions:saveImage'].safeParse({ id: 's_abc', data, type: 'image/png' }).success).toBe(true)
    expect(REQUEST_SCHEMAS['sessions:saveImage'].safeParse({ id: '../x', data, type: 'image/png' }).success).toBe(false)
    expect(REQUEST_SCHEMAS['sessions:saveImage'].safeParse({ data: new Uint8Array(), type: 'image/png' }).success).toBe(false)
    expect(REQUEST_SCHEMAS['sessions:saveImage'].safeParse({ data, type: 'image/svg+xml' }).success).toBe(false)
  })
})
