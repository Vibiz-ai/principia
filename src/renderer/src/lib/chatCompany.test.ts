/** "Start a company from this chat": the card's defaults, the confirmed card → onboarding seed → draft mapping. */
import { describe, expect, it } from 'vitest'
import { DraftSchema, type FolderCandidate } from '@shared/onboarding'
import type { CompanyProposal } from '@shared/chatCompany'
import { newDraft, reduceOnboarding, nextStep, planInput } from '../state/onboarding'
import { cardDefaults, logoNote, repoLabel, seedFor } from './chatCompany'

const BRIEF = 'A sourdough bakery delivering to offices in Lisbon. First 20 office customers and weekly Instagram posts.'
const P = (over: Partial<CompanyProposal> = {}): CompanyProposal => ({
  id: 'cpr_1',
  sessionId: 's_1',
  sessionTitle: 'Chat',
  name: 'Sunday Bakery',
  brief: BRIEF,
  repo: null,
  website: 'sundaybakery.pt',
  status: 'pending',
  createdAt: '2026-10-24T10:00:00.000Z',
  decidedAt: null,
  ...over
})
const cand = (over: Partial<FolderCandidate> = {}): FolderCandidate => ({ path: '/Users/me/code/bakery', name: 'bakery', isGit: true, ownedBy: null, ...over })

describe('the card', () => {
  it('starts with the chat’s name, the brief with the website, and the arch emblem', () => {
    expect(cardDefaults(P())).toEqual({ name: 'Sunday Bakery', brief: `${BRIEF}\nWebsite: sundaybakery.pt`, logo: { kind: 'emblem', variant: 'arch' } })
  })
  it('says where the logo comes from', () => {
    expect(logoNote(P(), { kind: 'emblem', variant: 'arch' })).toMatch(/Change Logo/)
    expect(logoNote(P({ repo: { kind: 'local', path: '/x' } }), { kind: 'emblem', variant: 'arch' })).toMatch(/repo’s own logo/)
    expect(repoLabel(P({ repo: { kind: 'local', path: '/Users/me/code/bakery' } }))).toBe('~/code/bakery')
    expect(repoLabel(P({ repo: { kind: 'url', url: 'https://github.com/acme/bakery.git' } }))).toBe('github.com/acme/bakery')
  })
})

describe('confirmed card → seed', () => {
  const edits = { name: 'Sunday Bakery', brief: BRIEF, logo: { kind: 'emblem' as const, variant: 'ring' as const } }
  it('no repo: the name heads the brief, the emblem is plain', () => {
    const { seed, skipped } = seedFor(P(), edits)
    expect(skipped).toBeNull()
    expect(seed).toEqual({ proposalId: 'cpr_1', name: 'Sunday Bakery', brief: `Sunday Bakery\n${BRIEF}`, logo: { variant: 'ring', keepDetected: false } })
  })
  it('a usable local folder rides along (existing repo id kept); the repo logo wins over the emblem', () => {
    const p = P({ repo: { kind: 'local', path: '/Users/me/code/bakery' } })
    const { seed } = seedFor(p, edits, { candidate: cand({ existingRepoId: 'repo_1', ownedBy: { companyId: 'co_personal', name: 'Personal', personal: true } }) })
    expect(seed.repo).toEqual({ kind: 'local', path: '/Users/me/code/bakery', existingRepoId: 'repo_1' })
    expect(seed.logo).toEqual({ variant: 'ring', keepDetected: true })
  })
  it('a folder of another company, a blocked or unreadable one is left out with a reason', () => {
    const p = P({ repo: { kind: 'local', path: '/Users/me/code/bakery' } })
    expect(seedFor(p, edits, { candidate: cand({ ownedBy: { companyId: 'co_acme', name: 'Acme', personal: false } }) })).toMatchObject({ seed: { logo: { keepDetected: false } }, skipped: expect.stringMatching(/belongs to Acme/) })
    expect(seedFor(p, edits, { candidate: cand({ blockedReason: 'Not a folder' }) }).skipped).toMatch(/Not a folder/)
    expect(seedFor(p, edits, { candidate: null }).seed.repo).toBeUndefined()
  })
  it('a clone link needs the clone folder', () => {
    const p = P({ repo: { kind: 'url', url: 'https://github.com/acme/bakery.git' } })
    expect(seedFor(p, edits, { cloneDir: '/Users/me/Code' }).seed.github).toEqual({ url: 'https://github.com/acme/bakery.git', parentDir: '/Users/me/Code' })
    expect(seedFor(p, edits, {}).skipped).toMatch(/No folder to clone into/)
  })
  it('"Initial" keeps no emblem', () => {
    expect(seedFor(P(), { ...edits, logo: { kind: 'initials' } }).seed.logo).toBeNull()
  })
})

describe('seed → onboarding draft (seedFromChat)', () => {
  const fresh = () => newDraft('new', { id: 'ob_chat', now: new Date('2026-10-24T10:00:00Z') })
  it('opens "From a prompt" on the Brief step with the brief and name filled in, saveable', () => {
    const { seed } = seedFor(P(), { name: 'Sunday Bakery', brief: BRIEF, logo: { kind: 'emblem', variant: 'arch' } })
    const d = reduceOnboarding(fresh(), { type: 'seedFromChat', seed })
    expect(d).toMatchObject({ start: 'prompt', step: 'brief', history: ['start'], hasCode: false, repos: [], brief: `Sunday Bakery\n${BRIEF}`, fromChat: { proposalId: 'cpr_1', logo: { variant: 'arch', keepDetected: false } } })
    expect(d.answers.name).toBe('Sunday Bakery')
    expect(DraftSchema.safeParse(d).success).toBe(true)
    // the brief's own primary reads it; a plain next is the no-model path (the questions)
    expect(nextStep(d)).toBe('name')
    expect(planInput(d).brief).toContain('sourdough')
    // Back goes to Start
    expect(reduceOnboarding(d, { type: 'back' }).step).toBe('start')
  })
  it('with a repo it is on the code branch, so the repo and its scan reach the plan and the launch', () => {
    const { seed } = seedFor(P({ repo: { kind: 'local', path: '/Users/me/code/bakery' } }), { name: 'Sunday Bakery', brief: BRIEF, logo: { kind: 'emblem', variant: 'arch' } }, { candidate: cand() })
    const d = reduceOnboarding(fresh(), { type: 'seedFromChat', seed })
    expect(d.hasCode).toBe(true)
    expect(d.repos).toEqual([{ kind: 'local', path: '/Users/me/code/bakery' }])
    expect(planInput(d).hasCode).toBe(true)
  })
  it('a clone link lands as the GitHub pick, without userinfo', () => {
    const d = reduceOnboarding(fresh(), { type: 'seedFromChat', seed: { proposalId: 'cpr_2', name: 'X', brief: BRIEF, github: { url: 'https://me:tok@github.com/acme/x.git', parentDir: '/Users/me/Code' }, logo: null } })
    expect(d.github).toEqual({ url: 'https://github.com/acme/x.git', parentDir: '/Users/me/Code' })
    expect(d.hasCode).toBe(true)
  })
  it('never overwrites a draft that already has answers', () => {
    const started = reduceOnboarding(fresh(), { type: 'setAnswers', patch: { name: 'Other' } })
    const { seed } = seedFor(P(), { name: 'Sunday Bakery', brief: BRIEF, logo: { kind: 'initials' } })
    expect(reduceOnboarding(started, { type: 'seedFromChat', seed })).toBe(started)
  })
})
