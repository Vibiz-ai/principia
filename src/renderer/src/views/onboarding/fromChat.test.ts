/**
 * "Start a company from this chat": the confirmation card's buttons against the store and a fake `window.hive`.
 * Confirm → main told (accept, edits) → onboarding open "From a prompt" with the brief → repo scanned → brief read →
 * Plan. Decline → main told, nothing opens. A setup already open blocks it; a half-done one is replaced only on yes.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompanyProposal } from '@shared/chatCompany'

const ls = new Map<string, string>()
const listeners = new Map<string, (p: unknown) => void>()
const decided: unknown[] = []
let confirmAnswer = true
const P = (over: Partial<CompanyProposal> = {}): CompanyProposal => ({
  id: 'cpr_1',
  sessionId: 's_0000000001',
  sessionTitle: 'Chat',
  name: 'Sunday Bakery',
  brief: 'A sourdough bakery delivering to offices in Lisbon.',
  repo: null,
  website: null,
  status: 'pending',
  createdAt: '2026-10-24T10:00:00.000Z',
  decidedAt: null,
  ...over
})
const fakeHive = {
  company: { list: vi.fn(async () => [{ id: 'co_personal', name: 'Personal', sortOrder: 0, slug: 'personal', color: '', system: 'personal', archivedAt: null, repoIds: [], createdAt: '', updatedAt: '' }]), overview: vi.fn(async () => []), logos: vi.fn(async () => []) },
  tasks: { list: vi.fn(async () => []) },
  settings: { update: vi.fn(async (p: unknown) => p) },
  memory: { overview: vi.fn(async () => null) },
  ui: { confirm: vi.fn(async () => confirmAnswer) },
  chatCompany: {
    list: vi.fn(async () => []),
    decide: vi.fn(async (req: { id: string; accept: boolean; name?: string; brief?: string }) => {
      decided.push(req)
      return { ...P(), ...(req.name ? { name: req.name } : {}), status: req.accept ? 'accepted' : 'declined' }
    })
  },
  onboarding: {
    status: vi.fn(async () => null),
    key: vi.fn(async () => undefined),
    plan: vi.fn(async () => {
      throw new Error('no plan')
    }),
    cancelPlan: vi.fn(async () => undefined),
    cancelBrief: vi.fn(async () => undefined),
    inspectFolders: vi.fn(async ({ paths }: { paths: string[] }) => paths.map((p) => ({ path: p, name: 'bakery', isGit: true, ownedBy: null }))),
    scan: vi.fn(async () => ({ summary: { repos: [] }, warnings: [] })),
    brief: vi.fn(async () => ({ answers: { name: 'Sunday Bakery', oneLiner: 'Sourdough for offices' }, source: 'agent' }))
  },
  on: (e: string, cb: (p: unknown) => void) => {
    listeners.set(e, cb)
    return () => listeners.delete(e)
  },
  send: () => undefined
}

type Store = typeof import('../../state/store')
type Flow = typeof import('./fromChat')
let m: Store
let f: Flow
const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0))

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { hive: fakeHive, addEventListener: () => undefined, dispatchEvent: () => true }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k)
  }
  m = await import('../../state/store')
  f = await import('./fromChat')
})

beforeEach(() => {
  ls.clear()
  decided.length = 0
  confirmAnswer = true
  vi.clearAllMocks()
  m.discardOnboarding()
  m.setState({ onboarding: null, onboardingDraft: null, ready: true, settings: { onboardingDone: true, experimental: {} } as never, providers: [], toasts: [], chatProposals: [P()] })
})

const edits = { name: 'Sunday Bakery', brief: 'A sourdough bakery delivering to offices in Lisbon.', logo: { kind: 'emblem' as const, variant: 'arch' as const } }

describe('confirm', () => {
  it('tells main, opens "From a prompt" with the brief, reads it and lands on Plan', async () => {
    expect(await f.confirmChatCard(P(), edits)).toBe(true)
    expect(decided).toEqual([{ id: 'cpr_1', accept: true, name: 'Sunday Bakery', brief: edits.brief }])
    const s = m.getState()
    expect(s.onboarding).toEqual({ open: true, mode: 'new', resumable: false })
    expect(s.onboardingDraft?.start).toBe('prompt')
    expect(s.onboardingDraft?.brief).toBe(`Sunday Bakery\n${edits.brief}`)
    expect(s.onboardingDraft?.fromChat).toEqual({ proposalId: 'cpr_1', logo: { variant: 'arch', keepDetected: false } })
    for (let i = 0; i < 20 && m.getState().onboardingDraft?.step !== 'plan'; i++) await flush()
    expect(fakeHive.onboarding.brief).toHaveBeenCalledTimes(1)
    expect(m.getState().onboardingDraft?.step).toBe('plan')
    expect(m.getState().onboardingDraft?.answers.oneLiner).toBe('Sourdough for offices')
  })

  it('a repo folder is inspected and scanned before the brief is read', async () => {
    await f.confirmChatCard(P({ repo: { kind: 'local', path: '/Users/me/code/bakery' } }), edits)
    expect(fakeHive.onboarding.inspectFolders).toHaveBeenCalledWith({ paths: ['/Users/me/code/bakery'] })
    for (let i = 0; i < 20 && m.getState().onboardingDraft?.step !== 'plan'; i++) await flush()
    expect(fakeHive.onboarding.scan).toHaveBeenCalledWith({ paths: ['/Users/me/code/bakery'] })
    const d = m.getState().onboardingDraft!
    expect(d.hasCode).toBe(true)
    expect(d.repos).toEqual([{ kind: 'local', path: '/Users/me/code/bakery' }])
    expect(d.fromChat?.logo).toEqual({ variant: 'arch', keepDetected: true })
  })

  it('an open setup blocks it (nothing decided); a half-done one is replaced only after a yes', async () => {
    m.openNewCompany()
    expect(await f.confirmChatCard(P(), edits)).toBe(false)
    expect(decided).toEqual([])
    // close it with answers in it: saved, resumable
    m.onboardingDispatch({ type: 'chooseStart', start: 'guided' })
    m.onboardingDispatch({ type: 'next' })
    m.onboardingDispatch({ type: 'setAnswers', patch: { name: 'Half done' } })
    m.closeOnboarding()
    confirmAnswer = false
    expect(await f.confirmChatCard(P(), edits)).toBe(false)
    expect(decided).toEqual([])
    confirmAnswer = true
    expect(await f.confirmChatCard(P(), edits)).toBe(true)
    expect(m.getState().onboardingDraft?.answers.name).toBe('Sunday Bakery')
  })

  it('a card the chat stopped waiting on still opens the setup', async () => {
    fakeHive.chatCompany.decide.mockRejectedValueOnce(new Error('That company card was already expired'))
    expect(await f.confirmChatCard(P(), edits)).toBe(true)
    expect(m.getState().chatProposals).toEqual([])
    expect(m.getState().onboarding?.open).toBe(true)
  })
})

describe('decline', () => {
  it('tells main and opens nothing', async () => {
    await f.declineChatCard(P())
    expect(decided).toEqual([{ id: 'cpr_1', accept: false }])
    expect(m.getState().chatProposals).toEqual([])
    expect(m.getState().onboarding).toBeNull()
  })
})

describe('cards from main', () => {
  it('chatCompany:updated adds a pending card and drops a decided one', () => {
    m.setState({ chatProposals: [] })
    m.upsertChatProposal(P({ id: 'cpr_2' }))
    m.upsertChatProposal(P({ id: 'cpr_3', createdAt: '2026-10-24T09:00:00.000Z' }))
    expect(m.getState().chatProposals.map((p) => p.id)).toEqual(['cpr_3', 'cpr_2'])
    m.upsertChatProposal(P({ id: 'cpr_3', status: 'accepted' }))
    expect(m.getState().chatProposals.map((p) => p.id)).toEqual(['cpr_2'])
  })
})
