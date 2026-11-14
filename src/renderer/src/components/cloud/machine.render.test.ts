// docs/MACHINES.md on the Cloud page: the "Make my cloud" form, the progress while it is made, and the machine card.
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MachineView } from '@shared/machines'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {} })

const M: MachineView = {
  provider: 'hetzner',
  name: 'principia-a1b2c3',
  serverId: '42',
  ip: '203.0.113.7',
  url: 'https://203-0-113-7.sslip.io',
  region: 'nbg1',
  size: 'cx33',
  createdAt: '2026-11-14T10:00:00Z',
  phase: 'installing',
  failedAt: null,
  detail: 'Installing… 3 min (a first install takes 3 to 10 minutes)',
  error: null,
  bring: { github: true, keys: true, claude: true, codex: false },
  notes: [],
  install: null
}

describe('Cloud › Make my cloud', () => {
  it('the form: three ways, a token with a link to get one, and what to sign it in with', async () => {
    const { MakeCloud } = await import('./Machine')
    const out = renderToStaticMarkup(createElement(MakeCloud))
    for (const s of ['Make my cloud', 'Hetzner Cloud', 'DigitalOcean', 'My own server', 'Hetzner Cloud API token', 'Get a token', 'Sign it in with', 'GitHub', 'Shared keys', 'Claude', 'Codex']) expect(out).toContain(s)
    // nothing to create with until the token is checked
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>(<[^>]+>)*Create/)
  })

  it('progress: done steps, the current one with its detail, the rest queued', async () => {
    const { MachineProgress } = await import('./Machine')
    const out = renderToStaticMarkup(createElement(MachineProgress, { m: M }))
    expect(out).toContain('Making your cloud')
    expect(out).toMatch(/cl-mstep--ok[^]*Creating the machine[^]*cl-mstep--ok[^]*Starting it[^]*cl-mstep--running[^]*Installing Principia Cloud[^]*Installing… 3 min[^]*cl-mstep--q[^]*Connecting this Mac/)
    expect(out).toContain('Stop and Delete')
    expect(out).not.toContain('Try Again')
  })

  it('stopped: the error and Try Again; my own server skips the provider steps', async () => {
    const { MachineProgress } = await import('./Machine')
    const out = renderToStaticMarkup(createElement(MachineProgress, { m: { ...M, provider: 'ssh', phase: 'failed', failedAt: 'installing', error: 'The install stopped on the server: E: Unable to locate package' } }))
    expect(out).toContain('stopped while being made')
    expect(out).toContain('Unable to locate package')
    expect(out).toContain('Try Again')
    expect(out).toContain('Forget Server')
    expect(out).not.toContain('Creating the machine')
  })

  it('the card: address, size and region, and what still needs you', async () => {
    const { MachineCard } = await import('./Machine')
    const out = renderToStaticMarkup(createElement(MachineCard, { m: { ...M, phase: 'ready', detail: null, notes: ['Claude: finish signing in in your browser.'] } }))
    expect(out).toContain('203-0-113-7.sslip.io')
    expect(out).toContain('cx33 · nbg1 · 203.0.113.7')
    expect(out).toContain('Claude: finish signing in in your browser.')
    expect(out).toContain('cl-tes--needs')
    expect(out).toContain('>Delete<')
  })

  it('a managed machine: Your cloud, awake or asleep with why and when it wakes, its hours, Wake and Turn Off', async () => {
    const { MachineCard } = await import('./Machine')
    const base: MachineView = { ...M, provider: 'principia', phase: 'ready', detail: null, size: 't4g.large', region: null, usage: { month: '2026-11', hours: 12.5, limitHours: 200 }, sleep: { reason: null, wakeAt: null, idleMinutes: 20 } }
    const awake = renderToStaticMarkup(createElement(MachineCard, { m: { ...base, power: 'awake' } }))
    for (const s of ['Your cloud', 'Run by Principia', 'Awake', 'Sleeps after 20 minutes with nothing running.', '12.5 of 200 hours this month', '>Turn Off<']) expect(awake).toContain(s)
    expect(awake).not.toContain('sslip.io')
    const asleep = renderToStaticMarkup(createElement(MachineCard, { m: { ...base, power: 'asleep', sleep: { reason: 'idle', wakeAt: null, idleMinutes: 20 } } }))
    expect(asleep).toContain('Asleep')
    expect(asleep).toContain('Since nothing ran for a while. Wakes when you start something.')
    expect(asleep).toContain('>Wake<')
  })

  it('managed progress hides the machine details', async () => {
    const { MachineProgress } = await import('./Machine')
    const out = renderToStaticMarkup(createElement(MachineProgress, { m: { ...M, provider: 'principia', size: 't4g.large', region: null, phase: 'booting' } }))
    expect(out).toContain('Turning on your cloud')
    expect(out).toContain('Principia Cloud')
    expect(out).not.toContain('t4g.large')
    expect(out).not.toContain('203.0.113.7')
    expect(out).toContain('>Cancel<')
  })
})
