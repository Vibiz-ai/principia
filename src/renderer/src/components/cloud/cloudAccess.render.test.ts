// docs/ACCOUNTS.md on the Keys page: not connected, one line to Cloud; connected, the model accounts plus GitHub, and
// the "In the cloud" switch on a Shared key. No value ever renders.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CloudAccountsView, WorkspaceSummary } from '@shared/cloud'
import { DEFAULT_QUOTAS } from '@shared/cloud'
import type { CloudLinkState } from '@shared/types'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {} })

const LINKED: CloudLinkState = { linked: true, url: 'https://cloud.example.dev', workspace: { id: 'ws_1', name: 'my-cloud' }, deviceId: 'dev', encryption: true, online: true, offlineSince: null, lastSyncAt: null, error: null, cloudCompanyIds: [], cloudScheduleIds: [], openAsks: 0, login: null }
const SUMMARY: WorkspaceSummary = {
  workspace: { id: 'ws_1', name: 'my-cloud', createdAt: '', paused: false, quotas: DEFAULT_QUOTAS, publicUrl: 'https://cloud.example.dev', mode: 'self-host' },
  companies: [],
  providers: [
    { adapter: 'claude', credential: { id: 'c1', kind: 'claude_oauth_token', label: 'Claude subscription', createdAt: '', lastUsedAt: null, expiresAt: null }, status: 'ok', detail: null, cliVersion: null },
    { adapter: 'codex', credential: null, status: 'missing', detail: null, cliVersion: null }
  ],
  runtime: { status: 'ok', version: '1', sandbox: 'process', detail: null },
  passportHost: { status: 'ok', url: '' },
  usage24h: { runs: 0, runMinutes: 0 }
}

async function render(view: CloudAccountsView, state: CloudLinkState | null = LINKED): Promise<string> {
  const { resetCloud } = await import('../../state/cloud')
  resetCloud({ state, summary: state?.linked ? SUMMARY : null, asks: [], proposals: {}, runs: [] })
  const { KeysAccounts, CloudKeySwitch } = await import('./CloudAccess')
  const set = (): void => {}
  return renderToStaticMarkup(createElement('div', null, createElement(KeysAccounts, { view, set }), createElement(CloudKeySwitch, { name: 'OPENAI_API_KEY', view, set })))
}

describe('Keys › accounts for the cloud', () => {
  beforeEach(() => vi.resetModules())

  it('without a cloud: one line that points to Cloud, and the switch is off and disabled', async () => {
    const out = await render({ linked: false, github: null, inCloud: [], cloudKeys: [] }, { ...LINKED, linked: false })
    expect(out).toContain('sign in once from')
    expect(out).toContain('>Cloud<')
    expect(out).not.toContain('>GitHub<')
    expect(out).toMatch(/role="switch" aria-checked="false"[^>]*disabled/)
  })

  it('connected: Claude and Codex accounts, GitHub with its login, and a Shared key in the cloud', async () => {
    const out = await render({ linked: true, github: { login: 'octo-founder', createdAt: '', lastUsedAt: null }, inCloud: ['OPENAI_API_KEY'], cloudKeys: ['OPENAI_API_KEY'] })
    expect(out).toContain('>Accounts<')
    expect(out).toContain('Claude')
    expect(out).toContain('<b>GitHub</b>')
    expect(out).toContain('@octo-founder')
    expect(out).toContain('>Replace<')
    expect(out).toContain('In the cloud: every cloud run gets it')
    expect(out).toMatch(/role="switch" aria-checked="true"/)
  })

  it('connected without GitHub: one button that uses this Mac’s gh sign-in', async () => {
    const out = await render({ linked: true, github: null, inCloud: [], cloudKeys: [] })
    expect(out).toContain('Use This Mac’s GitHub')
    expect(out).toContain('Not connected')
    expect(out).toContain('Only agents on this Mac get it')
  })
})
