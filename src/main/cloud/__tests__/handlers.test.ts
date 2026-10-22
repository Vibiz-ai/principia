// docs/CLOUD.md §13.1: every cloud:* channel is registered and validated, calls go through the CloudLink, and no
// response carries the device token or a pasted credential.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>>()
const opened: string[] = []
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, fn: never) => void handlers.set(c, fn), removeHandler: (c: string) => void handlers.delete(c), on: () => {}, removeAllListeners: () => {} },
  shell: { openExternal: async (u: string) => void opened.push(u) }
}))

import { INVOKE_CHANNELS } from '../../../shared/ipc'
import { REQUEST_SCHEMAS } from '../../ipcSchemas'
import { registerCloudHandlers } from '../../handlers/cloud'
import { CloudLink } from '../link'
import type { CloudWiring } from '../wire'
import { DEVICE_TOKEN, PAIR_CODE, fakeCipher, startFakeCloud, type FakeCloud } from './fakeCloud'

let cloud: FakeCloud
let dir: string
let link: CloudLink
const sender = { id: 1 }
const invoke = async (channel: string, req?: unknown) => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn({ sender }, req)
}

beforeEach(async () => {
  handlers.clear()
  opened.length = 0
  cloud = await startFakeCloud()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-ipc-'))
  link = new CloudLink({ userData: dir, cipher: fakeCipher(), emit: () => {}, sse: false })
  const wiring = { link, logins: { cancel: vi.fn(), start: vi.fn(async () => ({})), current: () => null }, move: { link } } as unknown as CloudWiring
  const h = { company: { passport: (id: string) => ({ id }) } } as never
  registerCloudHandlers(h, wiring)
})
afterEach(async () => {
  link.stop()
  await cloud.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('cloud IPC', () => {
  it('registers every cloud:* channel in the contract, each with a request schema', () => {
    const cloudChannels = INVOKE_CHANNELS.filter((c) => c.startsWith('cloud:'))
    expect(cloudChannels.length).toBe(29)
    for (const c of cloudChannels) {
      expect(handlers.has(c), c).toBe(true)
      expect(REQUEST_SCHEMAS[c], c).toBeDefined()
    }
    // CLOUD.md §14: no server-side device login, forum or hooks channels on the desktop
    expect(cloudChannels.some((c) => /deviceLogin|forum|hook/i.test(c))).toBe(false)
  })

  it('state, pair with a connect link, summary, providers; no token in any answer', async () => {
    expect((await invoke('cloud:state')).data).toMatchObject({ linked: false })
    expect((await invoke('cloud:pair', {})).error?.code).toBe('bad_request')
    const paired = await invoke('cloud:pair', { link: `${cloud.url}/pair#${PAIR_CODE}` })
    expect(paired.data).toMatchObject({ linked: true, workspace: { name: 'lautaro-cloud' } })
    const answers = [paired, await invoke('cloud:summary'), await invoke('cloud:providers'), await invoke('cloud:devices'), await invoke('cloud:asks'), await invoke('cloud:runs')]
    for (const a of answers) expect(a.ok).toBe(true)
    expect(JSON.stringify(answers)).not.toContain(DEVICE_TOKEN)
  })

  it('a pasted key goes to the cloud and the answer never echoes it', async () => {
    await invoke('cloud:pair', { link: `${cloud.url}/pair#${PAIR_CODE}` })
    const r = await invoke('cloud:providerPut', { adapter: 'gemini', kind: 'gemini_api_key', value: 'AIza-SECRET-KEY-123' })
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r.data)).not.toContain('AIza-SECRET-KEY-123')
    expect(cloud.requests.find((q) => q.path === '/v1/providers/gemini/credential')?.body).toEqual({ kind: 'gemini_api_key', value: 'AIza-SECRET-KEY-123' })
    expect((await invoke('cloud:providerPut', { adapter: 'cursor', kind: 'x', value: 'y' })).error?.code).toBe('bad_request')
  })

  it('answers an ask, decides a proposal, opens the console link and connector consent in the browser', async () => {
    await invoke('cloud:pair', { link: `${cloud.url}/pair#${PAIR_CODE}` })
    cloud.asks = [{ id: 'cask_1', companyId: 'co', runId: null, agentName: 'Marcus · Copywriter', question: 'Today?', options: ['Today'], createdAt: '', status: 'open', answer: null }]
    expect((await invoke('cloud:answer', { id: 'cask_1', answer: 'Today' })).data).toMatchObject({ status: 'answered', answer: 'Today' })
    expect((await invoke('cloud:decideProposal', { companyId: 'co', proposalId: 'prop_1', decision: 'accept' })).ok).toBe(true)
    expect(cloud.requests.at(-1)?.path).toBe('/v1/companies/co/passport/proposals/prop_1/accept')
    const ll = await invoke('cloud:loginLink', { open: true })
    expect((ll.data as { url: string }).url).toContain('/console/login?t=pll_')
    expect(opened).toEqual([(ll.data as { url: string }).url])
    await invoke('cloud:connectionAuthorize', { companyId: 'co', connectionId: 'notion' })
    expect(opened.at(-1)).toBe('https://auth.example.com/authorize?state=x')
    expect((await invoke('cloud:runLog', { id: 'crun_x' })).data).toEqual({ lines: ['› step one', '  ••••FAL_KEY redacted'] })
  })

  it('this Mac cannot revoke itself (that is Disconnect); unlink revokes and forgets', async () => {
    await invoke('cloud:pair', { link: `${cloud.url}/pair#${PAIR_CODE}` })
    expect((await invoke('cloud:revokeDevice', { id: 'dev_mac' })).error?.message).toMatch(/Disconnect/)
    expect((await invoke('cloud:revokeDevice', { id: 'dev_phone' })).ok).toBe(true)
    expect((await invoke('cloud:unlink')).data).toMatchObject({ linked: false })
  })

  it('calls before pairing fail with a plain conflict', async () => {
    expect((await invoke('cloud:summary')).error).toMatchObject({ code: 'conflict', message: 'Connect this Mac to a cloud first.' })
    expect((await invoke('cloud:loginClaude')).error?.code).toBe('conflict')
  })
})

describe('Run now on a schedule placed in the cloud (CLOUD.md §8: it fires in exactly one place)', () => {
  it('starts the run in the cloud through the control plane, and never a local run', async () => {
    const { registerScheduleHandlers } = await import('../../handlers/schedules')
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    const schedule = (id: string) => ({ id, name: id === 's_cloud' ? 'Morning brief' : 'Local job', companyId: 'co_vibiz', target: { kind: 'workflow', workflowId: 'wf_brief', inputs: { day: 'mon' } } })
    const fireNow = vi.fn(() => ({ run: { id: 'run_local' }, card: null }))
    const runNow = vi.fn(() => ({ id: 'run_local' }))
    const h = {
      store: { getSchedule: (id: string) => schedule(id) },
      engine: { scheduler: { fireNow, runNow } },
      cloud: { link, move: { link } },
      safe: <T,>(fn: () => T, fallback: T): T => { try { return fn() } catch { return fallback } },
      statusChanged: () => {}
    } as never
    registerScheduleHandlers(h)
    link.setSchedulePlacement('s_cloud', 'cloud', 1)
    const before = cloud.requests.length
    const r = await invoke('schedules:runNow', { id: 's_cloud' })
    expect(r).toEqual({ ok: true, data: null })
    expect(fireNow).not.toHaveBeenCalled()
    expect(runNow).not.toHaveBeenCalled()
    const post = cloud.requests.slice(before).find((q) => q.method === 'POST' && q.path === '/v1/companies/co_vibiz/runs')!
    expect(post.body).toEqual({ kind: 'workflow', workflowId: 'wf_brief', inputs: { day: 'mon' } })
    // a local schedule still runs here
    const local = await invoke('schedules:runNow', { id: 's_local' })
    expect(local).toEqual({ ok: true, data: { id: 'run_local' } })
    expect(fireNow).toHaveBeenCalledWith('s_local')
    expect(cloud.requests.slice(before).filter((q) => q.path === '/v1/companies/co_vibiz/runs')).toHaveLength(1)
  })

  it('the engine store never hands the local scheduler a cloud-owned schedule, even by id', async () => {
    await link.pair({ link: `${cloud.url}/pair#${PAIR_CODE}` })
    const all = [{ id: 's_a' }, { id: 's_b' }] as never[]
    const store = { listSchedules: () => all, getSchedule: (id: string) => all.find((s: { id: string }) => s.id === id) ?? null }
    link.guardSchedules(store)
    link.setSchedulePlacement('s_b', 'cloud', 1)
    expect(store.getSchedule('s_a')).toEqual({ id: 's_a' })
    expect(store.getSchedule('s_b')).toBeNull()
    link.setSchedulePlacement('s_b', 'local')
    expect(store.getSchedule('s_b')).toEqual({ id: 's_b' })
  })
})
