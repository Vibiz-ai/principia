/**
 * ONBOARDING.md §3, §3.1, §9, §10 (Renderer): the pure reducer's transitions, draft load/save (version, shape, age),
 * keys never serialized, the agent-plan swap respecting `edited`, stale plans; then the store wiring (openNewCompany
 * opens the flow, close saves with a toast, first run and journal detection, progress events, finish).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAFT_MAX_AGE_MS, DRAFT_STORAGE_KEY, type JournalMeta, type KeyCheckResult, type OnboardingDraft, type OnboardingPlan, type OnboardingStatus, type ProgressEvent } from '@shared/onboarding'
import { templatePlan } from '@shared/onboardingPlan'
import {
  availableFor,
  canContinue,
  canGoBack,
  createDraftSaver,
  draftInputsHash,
  hasProgress,
  launchInput,
  loadDraft,
  needsContent,
  newDraft,
  parseDraft,
  planFreshness,
  planInput,
  receiveAgentPlan,
  reconcileLaunchDraft,
  reduceOnboarding as r,
  serializeDraft,
  shouldRerequestAgentPlan,
  stepIndex,
  writeDraft,
  type OnboardingAction,
  type PlanInputContext
} from './onboarding'

const NOW = new Date('2026-10-21T12:00:00.000Z')
const CTX: PlanInputContext = { tz: 'Europe/Lisbon', sharedKeys: {}, flagsOn: false }

function run(d: OnboardingDraft, ...actions: OnboardingAction[]): OnboardingDraft {
  return actions.reduce(r, d)
}
const fresh = (): OnboardingDraft => newDraft('new', { id: 'ob_test', now: NOW })
/** NO branch up to Goals. */
const toGoals = (): OnboardingDraft => run(fresh(), { type: 'chooseCode', hasCode: false }, { type: 'next' }, { type: 'setAnswers', patch: { name: 'Sunday Bakery' } }, { type: 'next' }, { type: 'next' }, { type: 'next' })

function planFor(d: OnboardingDraft, ctx = CTX): OnboardingPlan {
  const input = planInput(d, ctx)
  return templatePlan(input, availableFor(input, ['claude']))
}

describe('reducer: §3 transitions', () => {
  it('starts at Start with nothing to continue to until a branch is chosen', () => {
    const d = fresh()
    expect(d.step).toBe('start')
    expect(canContinue(d)).toBe(false)
    expect(r(d, { type: 'next' })).toBe(d)
    expect(canGoBack(d)).toBe(false)
    expect(hasProgress(d)).toBe(false)
    expect(d.enableFlags).toBe(true)
  })

  it('yes → connect, no → name', () => {
    expect(run(fresh(), { type: 'chooseCode', hasCode: true }, { type: 'next' }).step).toBe('connect')
    expect(run(fresh(), { type: 'chooseCode', hasCode: false }, { type: 'next' }).step).toBe('name')
  })

  it('connect needs a repo, a GitHub repo or a valid clone link', () => {
    const c = run(fresh(), { type: 'chooseCode', hasCode: true }, { type: 'next' })
    expect(canContinue(c)).toBe(false)
    expect(canContinue(r(c, { type: 'setRepos', repos: [{ kind: 'local', path: '/Users/a/acme-web' }] }))).toBe(true)
    expect(canContinue(r(c, { type: 'setGithub', github: { fullName: 'acme/web', parentDir: '/Users/a/Projects' } }))).toBe(true)
    expect(canContinue(r(c, { type: 'setGithub', github: { url: 'https://github.com/acme/web.git', parentDir: '/Users/a/Projects' } }))).toBe(true)
    expect(canContinue(r(c, { type: 'setGithub', github: { url: 'ext::sh -c x', parentDir: '/Users/a/Projects' } }))).toBe(false)
    expect(canContinue(r(c, { type: 'setGithub', github: { parentDir: '/Users/a/Projects' } }))).toBe(false)
    const withRepo = run(c, { type: 'setRepos', repos: [{ kind: 'local', path: '/Users/a/acme-web' }] }, { type: 'setAnswers', patch: { name: 'Acme' } }, { type: 'next' })
    expect(withRepo.step).toBe('about')
    expect(withRepo.history).toEqual(['start', 'connect'])
  })

  it('setRepos de-duplicates, drops relative paths and caps at 8', () => {
    const c = run(fresh(), { type: 'chooseCode', hasCode: true }, { type: 'next' })
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'local' as const, path: `/r/${i}` }))
    const d = r(c, { type: 'setRepos', repos: [{ kind: 'local', path: '/r/0' }, { kind: 'local', path: 'rel/x' }, ...many] })
    expect(d.repos.length).toBe(8)
    expect(new Set(d.repos.map((x) => x.path)).size).toBe(8)
    expect(d.repos.some((x) => !x.path.startsWith('/'))).toBe(false)
  })

  it('connect "No code after all" → name, keeping nothing; Back from name returns to Start', () => {
    const c = run(
      fresh(),
      { type: 'chooseCode', hasCode: true },
      { type: 'next' },
      { type: 'setRepos', repos: [{ kind: 'local', path: '/Users/a/acme-web' }] },
      { type: 'setGithub', github: { fullName: 'acme/web', parentDir: '/p' } },
      { type: 'setScan', scan: { repos: [], stack: ['Next.js'] } },
      { type: 'setAnswers', patch: { goals: ['ship', 'website'] } }
    )
    const n = r(c, { type: 'skipConnect' })
    expect(n.step).toBe('name')
    expect(n.hasCode).toBe(false)
    expect(n.repos).toEqual([])
    expect(n.github).toBeUndefined()
    expect(n.scan).toBeUndefined()
    expect(n.answers.goals).toEqual(['website'])
    expect(r(n, { type: 'back' }).step).toBe('start')
    // skip only exists on Connect
    expect(r(fresh(), { type: 'skipConnect' }).step).toBe('start')
  })

  it('name needs a name; about → voice → goals', () => {
    const n = run(fresh(), { type: 'chooseCode', hasCode: false }, { type: 'next' })
    expect(canContinue(n)).toBe(false)
    expect(r(n, { type: 'setAnswers', patch: { name: '   ' } }).step).toBe('name')
    const g = toGoals()
    expect(g.step).toBe('goals')
    expect(g.history).toEqual(['start', 'name', 'about', 'voice'])
  })

  it('goals: §2 S4 defaults on arrival (no code → website + social)', () => {
    expect(toGoals().answers.goals).toEqual(['website', 'social'])
  })

  it('goals: code defaults to ship + website without a site, ship + social with one', () => {
    const base = run(fresh(), { type: 'chooseCode', hasCode: true }, { type: 'next' }, { type: 'setRepos', repos: [{ kind: 'local', path: '/a' }] }, { type: 'setAnswers', patch: { name: 'Acme' } }, { type: 'next' })
    expect(run(base, { type: 'next' }, { type: 'next' }).answers.goals).toEqual(['ship', 'website'])
    expect(run(base, { type: 'setAnswers', patch: { siteUrl: 'acme.com' } }, { type: 'next' }, { type: 'next' }).answers.goals).toEqual(['ship', 'social'])
  })

  it('goals the founder picked are not replaced by defaults', () => {
    const g = run(fresh(), { type: 'chooseCode', hasCode: false }, { type: 'next' }, { type: 'setAnswers', patch: { name: 'X', goals: ['support'] } }, { type: 'next' }, { type: 'next' }, { type: 'next' })
    expect(g.answers.goals).toEqual(['support'])
  })

  it('toggleGoal adds/removes and refuses code-only goals without code', () => {
    const g = toGoals()
    expect(r(g, { type: 'toggleGoal', goal: 'ship' })).toBe(g)
    const t = run(g, { type: 'toggleGoal', goal: 'social' }, { type: 'toggleGoal', goal: 'customers' })
    expect(t.answers.goals).toEqual(['website', 'customers'])
    // a 4th pick is allowed (soft cap is a note)
    expect(run(t, { type: 'toggleGoal', goal: 'ads' }, { type: 'toggleGoal', goal: 'seo' }).answers.goals).toHaveLength(4)
  })

  it('Content is shown with a content goal and skipped without one', () => {
    const g = toGoals()
    expect(needsContent(g)).toBe(true)
    expect(r(g, { type: 'next' }).step).toBe('content')
    const noContent = run(g, { type: 'setAnswers', patch: { goals: ['customers', 'support'] } })
    expect(needsContent(noContent)).toBe(false)
    const p = r(noContent, { type: 'next' })
    expect(p.step).toBe('plan')
    expect(p.history).not.toContain('content')
    expect(r(p, { type: 'back' }).step).toBe('goals')
  })

  it('stepIndex: Connect/Name count as Start; Content counts only when shown', () => {
    expect(stepIndex(fresh())).toEqual({ index: 1, total: 6 }) // no goals yet → defaults include content goals
    const n = run(fresh(), { type: 'chooseCode', hasCode: false }, { type: 'next' })
    expect(stepIndex(n)!.index).toBe(1)
    const g = toGoals()
    expect(stepIndex(g)).toEqual({ index: 4, total: 6 })
    expect(stepIndex(r(g, { type: 'next' }))).toEqual({ index: 5, total: 6 })
    const p = run(g, { type: 'setAnswers', patch: { goals: ['customers'] } }, { type: 'next' })
    expect(stepIndex(p)).toEqual({ index: 5, total: 5 })
  })

  it('Back pops the history stack step by step', () => {
    const c = r(toGoals(), { type: 'next' })
    const back = run(c, { type: 'back' }, { type: 'back' }, { type: 'back' })
    expect(back.step).toBe('about')
    expect(back.history).toEqual(['start', 'name'])
    const all = run(back, { type: 'back' }, { type: 'back' })
    expect(all.step).toBe('start')
    expect(r(all, { type: 'back' })).toBe(all)
  })

  it('plan → launching; no Back, no edits once launching; failed / retry / ready', () => {
    const g = toGoals()
    const c = r(g, { type: 'next' })
    const p0 = r(c, { type: 'next' })
    expect(p0.step).toBe('plan')
    expect(canContinue(p0)).toBe(false) // no plan yet
    const p = r(p0, { type: 'templatePlan', plan: planFor(p0), inputsHash: draftInputsHash(p0, CTX) })
    expect(canContinue(p)).toBe(true)
    const l = r(p, { type: 'launchStarted', journalId: 'j_1' })
    expect(l.step).toBe('launching')
    expect(l.journalId).toBe('j_1')
    expect(canGoBack(l)).toBe(false)
    expect(r(l, { type: 'back' })).toBe(l)
    expect(r(l, { type: 'setAnswers', patch: { name: 'Other' } })).toBe(l)
    expect(r(l, { type: 'toggleGoal', goal: 'ads' })).toBe(l)
    expect(r(l, { type: 'next' })).toBe(l)
    const f = r(l, { type: 'launchFailed' })
    expect(f.step).toBe('failed')
    expect(canGoBack(f)).toBe(false)
    expect(r(f, { type: 'back' })).toBe(f)
    const again = r(f, { type: 'launchResumed' })
    expect(again.step).toBe('launching')
    const done = r(again, { type: 'launchDone' })
    expect(done.step).toBe('ready')
    expect(canGoBack(done)).toBe(false)
    expect(r(done, { type: 'back' })).toBe(done)
    expect(stepIndex(done)).toBeNull()
    // launch events don't move a question step
    expect(r(g, { type: 'launchDone' })).toBe(g)
    expect(r(g, { type: 'launchFailed' })).toBe(g)
  })

  it('resumeJournal opens at the Launch step (failed or running) and keeps a name', () => {
    const d = r(fresh(), { type: 'resumeJournal', journalId: 'j_9', status: 'failed', name: 'Sunday Bakery' })
    expect(d.step).toBe('failed')
    expect(d.journalId).toBe('j_9')
    expect(d.answers.name).toBe('Sunday Bakery')
    expect(r(fresh(), { type: 'resumeJournal', journalId: 'j_9', status: 'running' }).step).toBe('launching')
    expect(r(fresh(), { type: 'resumeJournal', journalId: 'bad id!', status: 'running' }).step).toBe('start')
  })

  it('setAnswers caps strings and ignores unknown fields and vibes', () => {
    const d = r(fresh(), { type: 'setAnswers', patch: { name: 'x'.repeat(500), voiceVibe: 'loud' as never, extra: 'nope' } as never })
    expect(d.answers.name.length).toBe(80)
    expect(d.answers.voiceVibe).toBe('friendly')
    expect((d.answers as Record<string, unknown>).extra).toBeUndefined()
    expect(serializeDraft(d)).not.toBeNull()
    expect(r(d, { type: 'setAnswers', patch: { voiceVibe: null } }).answers.voiceVibe).toBeNull()
  })

  it('applyPrefill fills only empty answers from the scan', () => {
    const d = run(
      fresh(),
      { type: 'chooseCode', hasCode: true },
      { type: 'setScan', scan: { repos: [{ source: 'local', label: 'sunday-bakery', description: 'Sourdough for offices', stack: [] }], stack: [] } },
      { type: 'setAnswers', patch: { oneLiner: 'Mine' } },
      { type: 'applyPrefill' }
    )
    expect(d.answers.name).toBe('Sunday Bakery')
    expect(d.answers.oneLiner).toBe('Mine')
  })

  it('switching provider drops the stash handle', () => {
    const k = run(toGoals(), { type: 'next' }, { type: 'setContentWants', wants: true }, { type: 'keyChecked', provider: 'fal', result: { status: 'valid', stashId: 'ks_1', last4: '4f2a' } })
    expect(k.content).toMatchObject({ provider: 'fal', keySource: 'stash', stashId: 'ks_1', last4: '4f2a' })
    const o = r(k, { type: 'setProvider', provider: 'openai' })
    expect(o.content.stashId).toBeUndefined()
    expect(o.content.keySource).toBeNull()
  })

  it('key check: valid is used, unknown waits for Use anyway, invalid keeps nothing, forget drops it', () => {
    const c = run(toGoals(), { type: 'next' }, { type: 'setContentWants', wants: true })
    const u = r(c, { type: 'keyChecked', provider: 'fal', result: { status: 'unknown', stashId: 'ks_2', last4: 'abcd' } })
    expect(u.content.keySource).toBeNull()
    expect(u.content.stashId).toBe('ks_2')
    expect(planInput(u, CTX).keys.fal).toBe(false)
    const a = r(u, { type: 'keyUseAnyway' })
    expect(a.content.keySource).toBe('stash')
    expect(planInput(a, CTX).keys.fal).toBe(true)
    const f = r(a, { type: 'keyForget' })
    expect(f.content.stashId).toBeUndefined()
    expect(f.content.keySource).toBeNull()
    const inv = r(c, { type: 'keyChecked', provider: 'fal', result: { status: 'invalid', stashId: 'ks_3', last4: 'zzzz' } })
    expect(inv.content.stashId).toBeUndefined()
    expect(inv.content.keySource).toBeNull()
    expect(r(c, { type: 'keyUseAnyway' })).toBe(c)
  })

  it('Shared keys count only when the founder wants content', () => {
    const c = r(toGoals(), { type: 'next' })
    const shared: PlanInputContext = { ...CTX, sharedKeys: { FAL_KEY: true } }
    expect(planInput(c, shared).keys.fal).toBe(false)
    const w = run(c, { type: 'setContentWants', wants: true }, { type: 'useSharedKey', provider: 'fal' })
    expect(planInput(w, shared).keys).toEqual({ fal: true, openai: false })
    expect(w.content.keySource).toBe('shared')
    // without a content goal the keys don't matter
    expect(planInput(r(w, { type: 'setAnswers', patch: { goals: ['customers'] } }), shared).keys.fal).toBe(false)
  })

  it('planInput: scan only on the code branch; departmentsOn from consent or flags', () => {
    const d = run(fresh(), { type: 'chooseCode', hasCode: false }, { type: 'setScan', scan: { repos: [], stack: ['Rails'] } })
    expect(planInput(d, CTX).scan).toBeUndefined()
    expect(planInput(r(d, { type: 'chooseCode', hasCode: true }), CTX).scan).toEqual({ repos: [], stack: ['Rails'] })
    const off = r(d, { type: 'setEnableFlags', on: false })
    expect(planInput(off, CTX).departmentsOn).toBe(false)
    expect(planInput(off, { ...CTX, flagsOn: true }).departmentsOn).toBe(true)
    expect(planInput(d, CTX).tz).toBe('Europe/Lisbon')
  })
})

describe('plan: swap respects `edited`, stale handling', () => {
  const atPlan = (): OnboardingDraft => {
    const p = run(toGoals(), { type: 'setAnswers', patch: { goals: ['customers'] } }, { type: 'next' })
    return r(p, { type: 'templatePlan', plan: planFor(p), inputsHash: draftInputsHash(p, CTX) })
  }
  const agentPlan = (d: OnboardingDraft): OnboardingPlan => ({ ...d.plan!.value, summary: 'Tailored by Claude for Sunday Bakery.' })

  it('an unedited plan is swapped for the agent plan', () => {
    const d = atPlan()
    expect(d.plan!.source).toBe('template')
    const res = receiveAgentPlan(d, agentPlan(d), draftInputsHash(d, CTX), CTX)
    expect(res.offer).toBeNull()
    expect(res.stale).toBe(false)
    expect(res.draft.plan).toMatchObject({ source: 'agent', edited: false })
    expect(res.draft.plan!.value.summary).toMatch(/Tailored/)
  })

  it('an edited plan is kept and the agent plan is offered; Use it replaces it', () => {
    const d = atPlan()
    const edited = r(d, { type: 'editPlan', plan: { ...d.plan!.value, summary: 'Mine.' } })
    expect(edited.plan!.edited).toBe(true)
    const res = receiveAgentPlan(edited, agentPlan(d), draftInputsHash(edited, CTX), CTX)
    expect(res.draft).toBe(edited)
    expect(res.offer!.summary).toMatch(/Tailored/)
    const used = r(edited, { type: 'useOfferedPlan', plan: res.offer!, inputsHash: draftInputsHash(edited, CTX) })
    expect(used.plan).toMatchObject({ source: 'agent', edited: false })
  })

  it('an agent plan for answers that have since changed is ignored', () => {
    const d = atPlan()
    const hash = draftInputsHash(d, CTX)
    const changed = r(d, { type: 'setAnswers', patch: { audience: 'Offices in Lisbon' } })
    const res = receiveAgentPlan(changed, agentPlan(d), hash, CTX)
    expect(res.stale).toBe(true)
    expect(res.draft).toBe(changed)
  })

  it('a template plan never replaces an edited plan', () => {
    const d = atPlan()
    const edited = r(d, { type: 'editPlan', plan: { ...d.plan!.value, summary: 'Mine.' } })
    const changed = r(edited, { type: 'setAnswers', patch: { products: 'Bread' } })
    expect(r(changed, { type: 'templatePlan', plan: planFor(changed), inputsHash: draftInputsHash(changed, CTX) })).toBe(changed)
  })

  it('freshness: fresh → stale (template re-renders) / staleEdited (Rebuild or Keep)', () => {
    const d = atPlan()
    expect(planFreshness(fresh(), CTX)).toBe('none')
    expect(planFreshness(d, CTX)).toBe('fresh')
    const changed = r(d, { type: 'setAnswers', patch: { products: 'Bread' } })
    expect(planFreshness(changed, CTX)).toBe('stale')
    expect(shouldRerequestAgentPlan(changed, CTX)).toBe(false) // a template plan is just re-rendered
    const rerendered = r(changed, { type: 'templatePlan', plan: planFor(changed), inputsHash: draftInputsHash(changed, CTX) })
    expect(planFreshness(rerendered, CTX)).toBe('fresh')

    const editedChanged = run(d, { type: 'editPlan', plan: { ...d.plan!.value, summary: 'Mine.' } }, { type: 'setAnswers', patch: { products: 'Bread' } })
    expect(planFreshness(editedChanged, CTX)).toBe('staleEdited')
    const kept = r(editedChanged, { type: 'keepPlan', inputsHash: draftInputsHash(editedChanged, CTX) })
    expect(planFreshness(kept, CTX)).toBe('fresh')
    expect(kept.plan!.value.summary).toBe('Mine.')
    expect(kept.plan!.edited).toBe(true)
    const rebuilt = r(editedChanged, { type: 'rebuildPlan', plan: planFor(editedChanged), inputsHash: draftInputsHash(editedChanged, CTX) })
    expect(rebuilt.plan).toMatchObject({ source: 'template', edited: false })
    expect(planFreshness(rebuilt, CTX)).toBe('fresh')
  })

  it('an unedited agent plan whose answers changed is re-requested', () => {
    const d = atPlan()
    const swapped = receiveAgentPlan(d, agentPlan(d), draftInputsHash(d, CTX), CTX).draft
    const changed = r(swapped, { type: 'setAnswers', patch: { products: 'Bread' } })
    expect(shouldRerequestAgentPlan(changed, CTX)).toBe(true)
    // the template stands in while the new call runs
    const t = r(changed, { type: 'templatePlan', plan: planFor(changed), inputsHash: draftInputsHash(changed, CTX) })
    expect(t.plan!.source).toBe('template')
  })

  it('the hash follows the keys and consent the plan depends on', () => {
    const d = atPlan()
    expect(draftInputsHash(d, CTX)).not.toBe(draftInputsHash(r(d, { type: 'setEnableFlags', on: false }), CTX))
    expect(draftInputsHash(d, CTX)).toBe(draftInputsHash({ ...d, updatedAt: '2030-01-01T00:00:00.000Z' }, CTX))
  })

  it('rejects a plan that fails the schema', () => {
    const d = atPlan()
    const bad = { ...d.plan!.value, version: 2 } as unknown as OnboardingPlan
    expect(r(d, { type: 'editPlan', plan: bad })).toBe(d)
    expect(receiveAgentPlan(d, bad, draftInputsHash(d, CTX), CTX).stale).toBe(true)
  })
})

describe('draft persistence (§3.1)', () => {
  const store = new Map<string, unknown>()
  const save = (k: string, v: unknown): void => void store.set(k, JSON.parse(JSON.stringify(v)))
  const load = <T,>(k: string, fallback: T): T => (store.has(k) ? (store.get(k) as T) : fallback)
  beforeEach(() => store.clear())
  afterEach(() => vi.useRealTimers())

  it('round-trips a valid draft', () => {
    const d = toGoals()
    expect(writeDraft(save, d, NOW)).toBe(true)
    expect(loadDraft(load, NOW)).toEqual({ ...d, updatedAt: NOW.toISOString() })
  })

  it('rejects a bad version', () => {
    const json = { ...JSON.parse(serializeDraft(fresh())!), v: 2 }
    expect(parseDraft(json, NOW)).toBeNull()
    expect(parseDraft({ ...json, v: undefined }, NOW)).toBeNull()
  })

  it('rejects a bad shape', () => {
    const json = JSON.parse(serializeDraft(fresh())!)
    expect(parseDraft({ ...json, step: 'nowhere' }, NOW)).toBeNull()
    expect(parseDraft({ ...json, extra: 1 }, NOW)).toBeNull()
    expect(parseDraft({ ...json, answers: { ...json.answers, name: 5 } }, NOW)).toBeNull()
    expect(parseDraft({ ...json, content: { ...json.content, key: 'sk-live-123' } }, NOW)).toBeNull()
    expect(parseDraft('garbage', NOW)).toBeNull()
    expect(parseDraft(null, NOW)).toBeNull()
    expect(parseDraft({ ...json, updatedAt: 'not a date' }, NOW)).toBeNull()
  })

  it('rejects a draft older than 14 days', () => {
    const old = new Date(NOW.getTime() - DRAFT_MAX_AGE_MS - 1000)
    writeDraft(save, fresh(), old)
    expect(loadDraft(load, NOW)).toBeNull()
    const recent = new Date(NOW.getTime() - DRAFT_MAX_AGE_MS + 60_000)
    writeDraft(save, fresh(), recent)
    expect(loadDraft(load, NOW)).not.toBeNull()
  })

  it('stores under principia.onboarding.v1, debounced 300 ms (last write wins), flushable', () => {
    vi.useFakeTimers()
    const spy = vi.fn(save)
    const saver = createDraftSaver(spy, 300, () => NOW)
    saver.save(fresh())
    saver.save(r(fresh(), { type: 'chooseCode', hasCode: false }))
    vi.advanceTimersByTime(299)
    expect(spy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toBe(DRAFT_STORAGE_KEY)
    expect((store.get(DRAFT_STORAGE_KEY) as OnboardingDraft).hasCode).toBe(false)
    saver.save(toGoals())
    expect(saver.pending()).toBe(true)
    saver.flush()
    expect(spy).toHaveBeenCalledTimes(2)
    saver.save(fresh())
    saver.cancel()
    vi.advanceTimersByTime(1000)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('property: the serialized draft never contains a value given to the key actions (only stashId and last4)', () => {
    let seed = 0x5eed
    const rand = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32)
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-:'
    const randKey = (): string => {
      const prefix = rand() < 0.5 ? 'sk-' : 'fal_'
      const n = 20 + Math.floor(rand() * 60)
      let s = prefix
      for (let i = 0; i < n; i++) s += ALPHA[Math.floor(rand() * ALPHA.length)]
      return s
    }
    const statuses: KeyCheckResult['status'][] = ['valid', 'unknown', 'invalid']
    for (let i = 0; i < 300; i++) {
      const key = randKey()
      const status = statuses[i % 3]!
      let d = run(toGoals(), { type: 'next' }, { type: 'setContentWants', wants: true })
      // a careless caller passes the value everywhere it could leak: as last4, as detail, as an extra field
      const result = { status, stashId: `ks_${i}`, last4: rand() < 0.5 ? key : key.slice(-4), detail: key, value: key } as KeyCheckResult
      d = r(d, { type: 'keyChecked', provider: rand() < 0.5 ? 'fal' : 'openai', result })
      if (rand() < 0.5) d = r(d, { type: 'keyUseAnyway' })
      d = r(d, { type: 'setAnswers', patch: { key } as never })
      const json = serializeDraft(d)
      expect(json).not.toBeNull()
      expect(json!).not.toContain(key)
      expect(json!).not.toContain(key.slice(0, 12))
      const back = JSON.parse(json!) as OnboardingDraft
      expect(Object.keys(back.content).sort()).toEqual(expect.arrayContaining(['wants', 'provider', 'keySource', 'vibizInterest']))
      for (const k of Object.keys(back.content)) expect(['wants', 'provider', 'keySource', 'stashId', 'last4', 'vibizInterest']).toContain(k)
      if (back.content.last4) expect(back.content.last4.length).toBeLessThanOrEqual(4)
    }
  })
})

describe('review fixes: branch leakage, launch input, stuck resume', () => {
  const journal = (over: Partial<JournalMeta> = {}): JournalMeta => ({ id: 'j_1', draftId: 'ob_test', mode: 'new', status: 'failed', companyId: 'co_1', companyName: 'Sunday Bakery', steps: [], scheduleRefs: [], updatedAt: '', ...over })
  /** NO branch at Plan with a template plan. */
  const atPlan = (): OnboardingDraft => {
    const d = run(toGoals(), { type: 'toggleGoal', goal: 'website' }, { type: 'next' }, { type: 'next' })
    expect(d.step).toBe('plan')
    return r(d, { type: 'templatePlan', plan: planFor(d), inputsHash: draftInputsHash(d, CTX) })
  }

  it('"Not yet" after visiting Connect drops the repos, GitHub pick and scan', () => {
    const c = run(
      fresh(),
      { type: 'chooseCode', hasCode: true },
      { type: 'next' },
      { type: 'setRepos', repos: [{ kind: 'local', path: '/Users/a/acme-web' }] },
      { type: 'setGithub', github: { fullName: 'acme/web', parentDir: '/Users/a/Projects' } },
      { type: 'back' },
      { type: 'chooseCode', hasCode: false }
    )
    expect(c.hasCode).toBe(false)
    expect(c.repos).toEqual([])
    expect(c.github).toBeUndefined()
    expect(c.scan).toBeUndefined()
  })

  it('launchInput: null without a plan; no code facts on the no-code branch; key only when content is wanted and in use', () => {
    expect(launchInput(toGoals(), CTX)).toBeNull()
    const d = atPlan()
    const li = launchInput({ ...d, repos: [{ kind: 'local', path: '/x' }], github: { fullName: 'a/b', parentDir: '/p' } }, CTX)!
    expect(li).not.toBeNull()
    expect(li.repos).toEqual([])
    expect(li.github).toBeUndefined()
    expect(li.key).toBeNull()
    expect(li.answers.name).toBe('Sunday Bakery')
    const stashed = { ...d, content: { wants: true, provider: 'fal' as const, keySource: 'stash' as const, stashId: 'ks_1', last4: '4f2a', vibizInterest: false } }
    expect(launchInput(stashed, CTX)!.key).toEqual({ name: 'FAL_KEY', stashId: 'ks_1' })
    // "Not now", or an unknown check not yet kept with "Use anyway": nothing is saved
    expect(launchInput({ ...stashed, content: { ...stashed.content, wants: false } }, CTX)!.key).toBeNull()
    expect(launchInput({ ...stashed, content: { ...stashed.content, keySource: null } }, CTX)!.key).toBeNull()
    expect(launchInput({ ...d, answers: { ...d.answers, name: '  ' } }, CTX)).toBeNull()
  })

  it('reconcileLaunchDraft: running/failed journal keeps the Launch step, done closes, discarded or unknown returns to Plan', () => {
    const launching = r(atPlan(), { type: 'launchStarted', journalId: 'j_1' })
    expect(launching.step).toBe('launching')
    expect(reconcileLaunchDraft(launching, journal({ status: 'running' }))).toBe(launching)
    expect(reconcileLaunchDraft(launching, journal({ status: 'failed' }))!.step).toBe('failed')
    expect(reconcileLaunchDraft(launching, journal({ status: 'done' }))).toBeNull()
    const discarded = reconcileLaunchDraft(launching, journal({ status: 'discarded' }))!
    expect(discarded.step).toBe('plan')
    expect(discarded.journalId).toBeUndefined()
    expect(canGoBack(discarded)).toBe(true)
    const unknown = reconcileLaunchDraft(launching, null)!
    expect(unknown.step).toBe('plan')
    expect(unknown.history).not.toContain('plan')
    // another draft's journal is not this one's
    expect(reconcileLaunchDraft(launching, journal({ id: 'j_9', draftId: 'ob_other', status: 'running' }))!.step).toBe('plan')
    const q = toGoals()
    expect(reconcileLaunchDraft(q, null)).toBe(q)
    expect(reconcileLaunchDraft({ ...launching, step: 'ready' }, null)).toBeNull()
  })
})

// ---------- store wiring ----------

const ls = new Map<string, string>()
const progressListeners = new Map<string, (p: unknown) => void>()
const settingsUpdates: Record<string, unknown>[] = []
const keyCalls: unknown[] = []
let status: OnboardingStatus | null = null
let planImpl: (req: { requestId: string; input: unknown; useAgent: boolean }) => Promise<{ plan: OnboardingPlan; source: 'agent' | 'template' }> = async () => {
  throw new Error('no plan')
}
const CO = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, sortOrder: 0, slug: id, color: 'var(--series-1)', system: null, archivedAt: null, repoIds: [], createdAt: '', updatedAt: '', ...extra })
let companies = [CO('co_personal', 'Personal', { system: 'personal' })]
const fakeHive = {
  company: { list: vi.fn(async () => companies), overview: vi.fn(async () => []) },
  tasks: { list: vi.fn(async () => []) },
  settings: { update: vi.fn(async (p: Record<string, unknown>) => (settingsUpdates.push(p), p)) },
  memory: { overview: vi.fn(async () => null) },
  onboarding: {
    status: vi.fn(async () => status),
    key: vi.fn(async (req: unknown) => void keyCalls.push(req)),
    plan: vi.fn((req: { requestId: string; input: unknown; useAgent: boolean }) => planImpl(req)),
    cancelPlan: vi.fn(async () => undefined)
  },
  on: (e: string, cb: (p: unknown) => void) => {
    progressListeners.set(e, cb)
    return () => progressListeners.delete(e)
  },
  send: () => undefined
}

type Store = typeof import('./store')
let m: Store
const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0))
const SETTINGS = { onboardingDone: false, experimental: {} } as unknown as import('@shared/types').Settings

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { hive: fakeHive, addEventListener: () => undefined, dispatchEvent: () => true }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k)
  }
  m = await import('./store')
})

describe('store: onboarding slice', () => {
  beforeEach(async () => {
    ls.clear()
    settingsUpdates.length = 0
    keyCalls.length = 0
    status = null
    companies = [CO('co_personal', 'Personal', { system: 'personal' })]
    m.discardOnboarding()
    m.setState({ onboarding: null, onboardingDraft: null, onboardingOffer: null, newCompanyOpen: false, ready: true, settings: { ...SETTINGS }, repos: [], view: { name: 'home' }, activeCompanyId: 'all', toasts: [] })
    await m.refreshCompanies()
  })

  it('openNewCompany opens the flow in new mode with a fresh draft; openQuickCompany opens the old sheet', () => {
    m.openNewCompany()
    const s = m.getState()
    expect(s.onboarding).toEqual({ open: true, mode: 'new', resumable: false })
    expect(s.onboardingDraft!.step).toBe('start')
    expect(s.newCompanyOpen).toBe(false)
    m.openQuickCompany()
    expect(m.getState().onboarding).toBeNull()
    expect(m.getState().newCompanyOpen).toBe(true)
    m.closeNewCompany()
  })

  it('closeOnboarding saves the draft and toasts; reopening resumes it with the banner', () => {
    m.openNewCompany()
    m.onboardingDispatch({ type: 'chooseCode', hasCode: false })
    m.onboardingDispatch({ type: 'next' })
    m.onboardingDispatch({ type: 'setAnswers', patch: { name: 'Sunday Bakery' } })
    expect(m.closeOnboarding()).toBe(true)
    expect(m.getState().onboarding).toBeNull()
    expect(m.getState().toasts.at(-1)!.text).toBe('Saved. Pick up where you left off from + New company.')
    const stored = JSON.parse(ls.get(DRAFT_STORAGE_KEY)!) as OnboardingDraft
    expect(stored.answers.name).toBe('Sunday Bakery')
    // a new session: the in-memory draft is gone, the stored one resumes
    m.setState({ onboardingDraft: null })
    m.openNewCompany()
    expect(m.getState().onboarding!.resumable).toBe(true)
    expect(m.getState().onboardingDraft!.step).toBe('name')
    m.continueOnboarding()
    expect(m.getState().onboarding!.resumable).toBe(false)
  })

  it('Start over forgets the stashed key and starts fresh', () => {
    m.openNewCompany()
    m.setState({ onboardingDraft: { ...m.getState().onboardingDraft!, step: 'content', content: { wants: true, provider: 'fal', keySource: 'stash', stashId: 'ks_9', last4: '4f2a', vibizInterest: false } } })
    m.startOverOnboarding()
    expect(keyCalls).toEqual([{ op: 'forget', stashIds: ['ks_9'] }])
    expect(m.getState().onboardingDraft!.step).toBe('start')
  })

  it('first run: Esc does nothing; "I\'ll explore on my own" sets onboardingDone and clears the draft', async () => {
    m.openOnboarding('first')
    expect(m.closeOnboarding()).toBe(false)
    expect(m.getState().onboarding!.open).toBe(true)
    await m.skipOnboarding()
    expect(m.getState().onboarding).toBeNull()
    expect(m.getState().onboardingDraft).toBeNull()
    expect(settingsUpdates).toContainEqual({ onboardingDone: true })
    expect(JSON.parse(ls.get(DRAFT_STORAGE_KEY) ?? 'null')).toBeNull()
  })

  it('close is refused while launching or failed', () => {
    m.openNewCompany()
    m.setState({ onboardingDraft: { ...m.getState().onboardingDraft!, step: 'launching' } })
    expect(m.closeOnboarding()).toBe(false)
    m.setState({ onboardingDraft: { ...m.getState().onboardingDraft!, step: 'failed' } })
    expect(m.closeOnboarding()).toBe(false)
  })

  it('after boot: an existing user (main reports data, or status unknown) is never put through the first-run flow', async () => {
    // main unreachable: no status, no flow
    status = null
    await m.detectOnboarding()
    expect(m.getState().onboarding).toBeNull()
    // main found data (sessions, runs, keys…) even though this renderer sees no repos and Personal only
    status = { firstRun: false, journal: null, providers: [], claudeCli: false, flags: {}, sharedKeys: { FAL_KEY: false, OPENAI_API_KEY: false, FIRECRAWL_API_KEY: false }, gh: 'missing', defaultCloneDir: '/p', waitlistUrl: null }
    await m.detectOnboarding()
    expect(m.getState().onboarding).toBeNull()
    expect(m.isFirstRun()).toBe(false)
  })

  it('after boot: first run opens in first mode once per session; repos or more companies do not', async () => {
    status = { firstRun: true, journal: null, providers: [], claudeCli: false, flags: {}, sharedKeys: { FAL_KEY: false, OPENAI_API_KEY: false, FIRECRAWL_API_KEY: false }, gh: 'missing', defaultCloneDir: '/p', waitlistUrl: null }
    m.setState({ repos: [{ id: 'r1' } as never] })
    await m.detectOnboarding()
    expect(m.getState().onboarding).toBeNull()
    m.setState({ repos: [] })
    await m.detectOnboarding()
    expect(m.getState().onboarding!.mode).toBe('first')
    m.discardOnboarding()
    await m.detectOnboarding()
    expect(m.getState().onboarding).toBeNull()
  })

  it('after boot: a failed journal opens at the Launch step with its recorded steps', async () => {
    status = {
      firstRun: false,
      journal: { id: 'j_1', draftId: 'ob_x', mode: 'new', status: 'failed', companyId: 'co_new', companyName: 'Sunday Bakery', steps: [{ name: 'company', status: 'done', created: [] }, { name: 'schedules', status: 'failed', created: [], error: 'Setup was interrupted' }, { name: 'finish', status: 'pending', created: [] }], scheduleRefs: [], updatedAt: '' },
      providers: [],
      claudeCli: false,
      flags: {},
      sharedKeys: { FAL_KEY: false, OPENAI_API_KEY: false, FIRECRAWL_API_KEY: false },
      gh: 'missing',
      defaultCloneDir: '/Users/a/Projects',
      waitlistUrl: null
    }
    await m.detectOnboarding()
    const s = m.getState()
    expect(s.onboarding).toMatchObject({ open: true, mode: 'new' })
    expect(s.onboardingDraft).toMatchObject({ step: 'failed', journalId: 'j_1' })
    expect(s.onboardingDraft!.answers.name).toBe('Sunday Bakery')
    expect(s.onboardingStatus).toBe(status)
    expect(Object.keys(s.onboardingProgress.steps).sort()).toEqual(['company', 'schedules'])
    expect(s.onboardingProgress.steps.schedules!.error).toBe('Setup was interrupted')
  })

  it('progress events feed the live list; a failure moves the draft to failed', () => {
    m.openNewCompany()
    m.setState({ onboardingDraft: { ...m.getState().onboardingDraft!, step: 'launching', journalId: 'j_2' } })
    const emit = (e: ProgressEvent): void => progressListeners.get('onboarding:progress')!(e)
    m.wireOnboardingEvents()
    expect(progressListeners.has('onboarding:progress')).toBe(true)
    emit({ journalId: 'j_2', step: 'company', status: 'done', label: 'Company' })
    progressListeners.get('onboarding:cloneProgress')!({ journalId: 'j_2', fullName: 'acme/web', percent: 40, line: 'Receiving objects: 40%' })
    expect(m.getState().onboardingProgress.steps.company!.status).toBe('done')
    expect(m.getState().onboardingProgress.clone!.percent).toBe(40)
    emit({ journalId: 'j_2', step: 'schedules', status: 'failed', label: 'Schedules', error: 'bad cron' })
    expect(m.getState().onboardingDraft!.step).toBe('failed')
  })

  it('closing on Ready (+ New company) lands on the new company Board', async () => {
    companies = [CO('co_new', 'Sunday Bakery'), CO('co_personal', 'Personal', { system: 'personal' })]
    m.openNewCompany()
    m.setState({ onboardingDraft: { ...m.getState().onboardingDraft!, step: 'ready', journalId: 'j_ready' } })
    status = { firstRun: false, journal: { id: 'j_ready', draftId: m.getState().onboardingDraft!.id, mode: 'new', status: 'done', companyId: 'co_new', companyName: 'Sunday Bakery', steps: [], scheduleRefs: [], updatedAt: '' }, providers: [], claudeCli: false, flags: {}, sharedKeys: { FAL_KEY: false, OPENAI_API_KEY: false, FIRECRAWL_API_KEY: false }, gh: 'missing', defaultCloneDir: '/p', waitlistUrl: null }
    expect(m.closeOnboarding()).toBe(true)
    await flush()
    await flush()
    const s = m.getState()
    expect(s.onboarding).toBeNull()
    expect(s.onboardingDraft).toBeNull()
    expect(s.activeCompanyId).toBe('co_new')
    expect(s.view).toEqual({ name: 'tasks' })
  })

  it('finishOnboarding enters the company and lands on Home or the Board', async () => {
    companies = [CO('co_new', 'Sunday Bakery'), CO('co_personal', 'Personal', { system: 'personal' })]
    m.openOnboarding('first')
    await m.finishOnboarding('co_new', 'board')
    const s = m.getState()
    expect(s.onboarding).toBeNull()
    expect(s.onboardingDraft).toBeNull()
    expect(s.activeCompanyId).toBe('co_new')
    expect(s.view).toEqual({ name: 'tasks' })
    expect(s.settings!.onboardingDone).toBe(true)
    await m.finishOnboarding('co_new', 'home')
    expect(m.getState().view).toEqual({ name: 'home' })
  })

  it('finishOnboarding re-reads onboarding:status, so the launched milestone sees the finished journal at once', async () => {
    companies = [CO('co_new', 'Sunday Bakery'), CO('co_personal', 'Personal', { system: 'personal' })]
    m.setState({ onboardingStatus: null })
    status = { firstRun: false, journal: { id: 'j_done', draftId: 'd_1', mode: 'new', status: 'done', companyId: 'co_new', companyName: 'Sunday Bakery', steps: [], scheduleRefs: [], updatedAt: '' }, providers: [], claudeCli: false, flags: {}, sharedKeys: { FAL_KEY: false, OPENAI_API_KEY: false, FIRECRAWL_API_KEY: false }, gh: 'missing', defaultCloneDir: '/p', waitlistUrl: null }
    await m.finishOnboarding('co_new', 'home')
    await flush()
    expect(m.getState().onboardingStatus?.journal).toMatchObject({ status: 'done', companyId: 'co_new' })
  })

  it('requestOnboardingPlan swaps an unedited plan and offers next to an edited one', async () => {
    m.openNewCompany()
    for (const a of [{ type: 'chooseCode', hasCode: false }, { type: 'next' }, { type: 'setAnswers', patch: { name: 'Sunday Bakery', goals: ['customers'] } }, { type: 'next' }, { type: 'next' }, { type: 'next' }, { type: 'next' }] as OnboardingAction[]) m.onboardingDispatch(a)
    const d = m.getState().onboardingDraft!
    expect(d.step).toBe('plan')
    const ctx = m.onboardingPlanContext()
    const tpl = planFor(d, ctx)
    m.onboardingDispatch({ type: 'templatePlan', plan: tpl, inputsHash: draftInputsHash(d, ctx) })
    planImpl = async () => ({ plan: { ...tpl, summary: 'Tailored.' }, source: 'agent' })
    expect(await m.requestOnboardingPlan()).toBe('swap')
    expect(m.getState().onboardingDraft!.plan).toMatchObject({ source: 'agent', edited: false })
    m.onboardingDispatch({ type: 'editPlan', plan: { ...tpl, summary: 'Mine.' } })
    planImpl = async () => ({ plan: { ...tpl, summary: 'Tailored again.' }, source: 'agent' })
    expect(await m.requestOnboardingPlan()).toBe('offer')
    expect(m.getState().onboardingOffer!.summary).toBe('Tailored again.')
    expect(m.getState().onboardingDraft!.plan!.value.summary).toBe('Mine.')
    m.useOfferedOnboardingPlan()
    expect(m.getState().onboardingDraft!.plan!.value.summary).toBe('Tailored again.')
    expect(m.getState().onboardingOffer).toBeNull()
  })

  it('a newer plan request supersedes an older one', async () => {
    m.openNewCompany()
    for (const a of [{ type: 'chooseCode', hasCode: false }, { type: 'next' }, { type: 'setAnswers', patch: { name: 'X', goals: ['customers'] } }, { type: 'next' }, { type: 'next' }, { type: 'next' }, { type: 'next' }] as OnboardingAction[]) m.onboardingDispatch(a)
    const d = m.getState().onboardingDraft!
    const tpl = planFor(d, m.onboardingPlanContext())
    let release!: () => void
    planImpl = () => new Promise((res) => (release = () => res({ plan: { ...tpl, summary: 'Old.' }, source: 'agent' })))
    const first = m.requestOnboardingPlan()
    const r1 = release
    planImpl = async () => ({ plan: { ...tpl, summary: 'New.' }, source: 'agent' })
    expect(await m.requestOnboardingPlan()).toBe('swap')
    expect(fakeHive.onboarding.cancelPlan).toHaveBeenCalled()
    r1()
    expect(await first).toBe('stale')
    expect(m.getState().onboardingDraft!.plan!.value.summary).toBe('New.')
    await flush()
  })

  it('a stash the draft drops (provider switch) is forgotten in main; Discard forgets it too', () => {
    m.openNewCompany()
    m.setState({ onboardingDraft: { ...m.getState().onboardingDraft!, step: 'content', content: { wants: true, provider: 'fal', keySource: 'stash', stashId: 'ks_1', last4: '4f2a', vibizInterest: false } } })
    m.onboardingDispatch({ type: 'setProvider', provider: 'openai' })
    expect(keyCalls).toEqual([{ op: 'forget', stashIds: ['ks_1'] }])
    m.setState({ onboardingDraft: { ...m.getState().onboardingDraft!, content: { wants: true, provider: 'openai', keySource: 'stash', stashId: 'ks_2', vibizInterest: false } } })
    m.discardOnboarding()
    expect(keyCalls).toContainEqual({ op: 'forget', stashIds: ['ks_2'] })
  })

  it('a saved draft stuck on the live list resumes at Plan when main has no journal for it', async () => {
    m.openNewCompany()
    m.setState({ onboardingDraft: { ...m.getState().onboardingDraft!, step: 'launching', history: ['start', 'name', 'about', 'voice', 'goals', 'plan'], journalId: 'j_gone' } })
    expect(m.closeOnboarding()).toBe(false)
    m.setState({ onboarding: null })
    status = { firstRun: false, journal: null, providers: [], claudeCli: false, flags: {}, sharedKeys: { FAL_KEY: false, OPENAI_API_KEY: false, FIRECRAWL_API_KEY: false }, gh: 'missing', defaultCloneDir: '/p', waitlistUrl: null }
    m.openNewCompany()
    await flush()
    expect(m.getState().onboardingDraft!.step).toBe('plan')
    expect(m.closeOnboarding()).toBe(true)
  })

  it('a saved draft whose journal is done closes instead of resuming (the company exists)', async () => {
    m.openNewCompany()
    const id = m.getState().onboardingDraft!.id
    m.setState({ onboardingDraft: { ...m.getState().onboardingDraft!, step: 'launching', journalId: 'j_done' }, onboarding: null })
    status = { firstRun: false, journal: { id: 'j_done', draftId: id, mode: 'new', status: 'done', companyId: 'co_new', companyName: 'Sunday Bakery', steps: [], scheduleRefs: [], updatedAt: '' }, providers: [], claudeCli: false, flags: {}, sharedKeys: { FAL_KEY: false, OPENAI_API_KEY: false, FIRECRAWL_API_KEY: false }, gh: 'missing', defaultCloneDir: '/p', waitlistUrl: null }
    m.openNewCompany()
    await flush()
    expect(m.getState().onboarding).toBeNull()
    expect(m.getState().onboardingDraft).toBeNull()
  })

  it('a failed journal with no saved draft resumes under the journal\'s draft id', async () => {
    status = { firstRun: false, journal: { id: 'j_7', draftId: 'ob_from_journal', mode: 'new', status: 'failed', companyId: 'co_new', steps: [], scheduleRefs: [], updatedAt: '' }, providers: [], claudeCli: false, flags: {}, sharedKeys: { FAL_KEY: false, OPENAI_API_KEY: false, FIRECRAWL_API_KEY: false }, gh: 'missing', defaultCloneDir: '/p', waitlistUrl: null }
    await m.detectOnboarding()
    expect(m.getState().onboardingDraft).toMatchObject({ id: 'ob_from_journal', journalId: 'j_7', step: 'failed' })
  })

  it('an offered plan is dropped once the answers change; a launch cancels the plan call', async () => {
    m.openNewCompany()
    for (const a of [{ type: 'chooseCode', hasCode: false }, { type: 'next' }, { type: 'setAnswers', patch: { name: 'Sunday Bakery', goals: ['customers'] } }, { type: 'next' }, { type: 'next' }, { type: 'next' }, { type: 'next' }] as OnboardingAction[]) m.onboardingDispatch(a)
    const d = m.getState().onboardingDraft!
    const ctx = m.onboardingPlanContext()
    const tpl = planFor(d, ctx)
    m.onboardingDispatch({ type: 'templatePlan', plan: tpl, inputsHash: draftInputsHash(d, ctx) })
    m.onboardingDispatch({ type: 'editPlan', plan: { ...tpl, summary: 'Mine.' } })
    planImpl = async () => ({ plan: { ...tpl, summary: 'Tailored.' }, source: 'agent' })
    expect(await m.requestOnboardingPlan()).toBe('offer')
    m.onboardingDispatch({ type: 'setEnableFlags', on: false })
    expect(m.getState().onboardingOffer).toBeNull()
    // a template answer for the old inputs is not applied
    let release!: () => void
    planImpl = () => new Promise((res) => (release = () => res({ plan: { ...tpl, summary: 'Old template.' }, source: 'template' })))
    const pending = m.requestOnboardingPlan(false)
    const rel = release
    m.onboardingDispatch({ type: 'setEnableFlags', on: true })
    rel()
    expect(await pending).toBe('stale')
    expect(m.getState().onboardingDraft!.plan!.value.summary).toBe('Mine.')
    fakeHive.onboarding.cancelPlan.mockClear()
    planImpl = () => new Promise(() => undefined)
    void m.requestOnboardingPlan()
    m.onboardingDispatch({ type: 'launchStarted', journalId: 'j_3' })
    expect(m.getState().onboardingDraft!.step).toBe('launching')
    expect(fakeHive.onboarding.cancelPlan).toHaveBeenCalled()
    expect(m.getState().onboardingPlanPending).toBe(false)
  })
})

describe('withoutUserinfo', () => {
  it('drops credentials from typed clone links and keeps ssh users', async () => {
    const { withoutUserinfo } = await import('./onboarding')
    expect(withoutUserinfo('https://me:ghp_secret@github.com/a/b.git')).toBe('https://github.com/a/b.git')
    expect(withoutUserinfo('ssh://git:tok@github.com/a/b')).toBe('ssh://git@github.com/a/b')
    expect(withoutUserinfo('ssh://git@github.com/a/b')).toBe('ssh://git@github.com/a/b')
    expect(withoutUserinfo('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
    expect(withoutUserinfo('https://github.com/a/b')).toBe('https://github.com/a/b')
  })
})

describe('§2 S0: three ways to start a new company', () => {
  const BRIEF = 'Sunday Bakery\nSourdough for offices in Lisbon.'
  it('From a prompt: Start → Brief → (read by Claude) Plan, the brief in the plan and launch inputs', () => {
    let d = run(fresh(), { type: 'chooseStart', start: 'prompt' })
    expect(d).toMatchObject({ start: 'prompt', hasCode: false })
    expect(canContinue(d)).toBe(true)
    d = r(d, { type: 'next' })
    expect(d.step).toBe('brief')
    expect(canContinue(d)).toBe(false)
    d = r(d, { type: 'setBrief', brief: BRIEF })
    expect(canContinue(d)).toBe(true)
    expect(hasProgress(d)).toBe(true)
    d = r(d, { type: 'briefRead', source: 'agent', answers: { name: 'Sunday Bakery', oneLiner: 'Sourdough for offices', goals: ['customers'] } })
    expect(d.step).toBe('plan')
    expect(d.history).toEqual(['start', 'brief'])
    expect(d.answers).toMatchObject({ name: 'Sunday Bakery', oneLiner: 'Sourdough for offices', goals: ['customers'] })
    expect(planInput(d, CTX).brief).toBe(BRIEF)
    d = r(d, { type: 'templatePlan', plan: planFor(d), inputsHash: draftInputsHash(d, CTX) })
    expect(launchInput(d, CTX)?.brief).toBe(BRIEF)
    // the brief is part of what the plan was made for
    expect(draftInputsHash(r(r(d, { type: 'back' }), { type: 'setBrief', brief: `${BRIEF} More.` }), CTX)).not.toBe(draftInputsHash(d, CTX))
    expect(parseDraft(JSON.parse(serializeDraft(d)!), NOW)).toMatchObject({ start: 'prompt', brief: BRIEF })
  })

  it('From a prompt, not read by Claude (or no name): Name with what could be read, then the guided questions', () => {
    let d = run(fresh(), { type: 'chooseStart', start: 'prompt' }, { type: 'next' }, { type: 'setBrief', brief: BRIEF })
    d = r(d, { type: 'briefRead', source: 'template', answers: { name: 'Sunday Bakery' } })
    expect(d.step).toBe('name')
    expect(d.answers.name).toBe('Sunday Bakery')
    expect(d.brief).toBe(BRIEF)
    expect(r(d, { type: 'next' }).step).toBe('about')
    expect(r(d, { type: 'back' }).step).toBe('brief')
    const noName = run(fresh(), { type: 'chooseStart', start: 'prompt' }, { type: 'next' }, { type: 'setBrief', brief: 'x' }, { type: 'briefRead', source: 'agent', answers: {} })
    expect(noName.step).toBe('name')
  })

  it('From a repo: Start → Connect → Plan when the scan found a name, else Name → Plan', () => {
    let d = run(fresh(), { type: 'chooseStart', start: 'repo' })
    expect(d).toMatchObject({ start: 'repo', hasCode: true })
    d = run(d, { type: 'next' }, { type: 'setRepos', repos: [{ kind: 'local', path: '/Users/me/acme' }] })
    expect(d.step).toBe('connect')
    const named = run(d, { type: 'setAnswers', patch: { name: 'Acme' } }, { type: 'next' })
    expect(named.step).toBe('plan')
    const unnamed = r(d, { type: 'next' })
    expect(unnamed.step).toBe('name')
    expect(run(unnamed, { type: 'setAnswers', patch: { name: 'Acme' } }, { type: 'next' }).step).toBe('plan')
    // "No code after all" hands over to the guided questions
    const skipped = r(d, { type: 'skipConnect' })
    expect(skipped).toMatchObject({ step: 'name', start: 'guided', hasCode: false })
    expect(run(skipped, { type: 'setAnswers', patch: { name: 'Acme' } }, { type: 'next' }).step).toBe('about')
  })

  it('Guided is the old flow; choosing a way again from Start drops what From a repo picked', () => {
    const g = run(fresh(), { type: 'chooseStart', start: 'guided' })
    expect(canContinue(g)).toBe(false)
    expect(run(g, { type: 'chooseCode', hasCode: false }, { type: 'next' }).step).toBe('name')
    const repo = run(fresh(), { type: 'chooseStart', start: 'repo' }, { type: 'setRepos', repos: [{ kind: 'local', path: '/Users/me/acme' }] })
    expect(r(repo, { type: 'chooseStart', start: 'prompt' })).toMatchObject({ hasCode: false, repos: [] })
    // a briefRead off the Brief step is ignored
    expect(r(g, { type: 'briefRead', source: 'agent', answers: { name: 'X' } })).toBe(g)
  })
})
