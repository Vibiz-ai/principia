/**
 * What the onboarding buttons do (docs/ONBOARDING.md §2, §4, §7): the Next orchestration (site read on Name, plan
 * tailoring when leaving Goals), the launch / retry / skip / discard calls and the Ready step's start. The state
 * itself lives in the store (state/store.ts) and the pure reducer (state/onboarding.ts); this module only sequences
 * IPC calls around them. Keys never pass through here: KeyField sends its value straight to `onboarding:key`.
 */
import type { BriefResult, LaunchResult, LaunchStepName, OnboardingDraft, OnboardingStatus, ProgressEvent, SoftLaunchStep } from '@shared/onboarding'
import { LAUNCH_STEP_LABELS, SOFT_LAUNCH_STEPS } from '@shared/onboarding'
import { briefFallback } from '@shared/onboardingBrief'
import { inputsHash } from '@shared/onboardingPlan'
import { confirmNative, errorMessage, hive } from '../../lib/hive'
import { draftInputsHash, launchInput, planInput, reconcileLaunchDraft } from '../../state/onboarding'
import {
  discardOnboarding,
  finishOnboarding,
  flushOnboardingDraft,
  getState,
  onboardingDispatch,
  onboardingPlanContext,
  requestOnboardingPlan,
  refreshOnboardingStatus,
  setState,
  updateSettings,
  toast
} from '../../state/store'
import { useSyncExternalStore } from 'react'
import { instagramHandle, siteFetchUrl } from './model'

// ---------- flow-local state (not in the app store: transient, never persisted) ----------

export interface FlowLocal {
  /** The Name step's site read is in flight (About shows "Reading your site…"). */
  siteReading: boolean
  /** A launch call that threw after the journal existed (shown on the failed step). */
  launchError: string | null
  /** The last launch result (Ready step: company id and the created schedules). */
  result: LaunchResult | null
  /**
   * VOICE.md §8: the launch ceremony is up (Start now in playful tone, after start() resolved). Its CTA, Skip or Esc
   * calls finishCeremony(), the existing close + enterCompany path.
   */
  ceremony: { companyId: string } | null
  /** "From a prompt": onboarding:brief is reading the brief (the Brief step shows it and holds its button). */
  briefReading: boolean
}
let local: FlowLocal = { siteReading: false, launchError: null, result: null, ceremony: null, briefReading: false }
const listeners = new Set<() => void>()
export function setLocal(patch: Partial<FlowLocal>): void {
  local = { ...local, ...patch }
  listeners.forEach((l) => l())
}
export function getLocal(): FlowLocal {
  return local
}
export function useFlowLocal<T>(sel: (s: FlowLocal) => T): T {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => sel(local),
    () => sel(local)
  )
}

// ---------- small shared bits ----------

/** Installed non-shell adapters (onboarding:status, else the providers the app already detected). */
export function installedAdapters(status: OnboardingStatus | null = getState().onboardingStatus): string[] {
  if (status?.providers?.length) return status.providers.filter((p) => p.installed && p.adapter !== 'shell').map((p) => p.adapter)
  return getState()
    .providers.filter((p) => p.available && p.id !== 'shell')
    .map((p) => p.id)
}

/** The Claude CLI is there (plan tailoring, "Tailor with Claude"). */
export function hasClaudeCli(status: OnboardingStatus | null = getState().onboardingStatus): boolean {
  if (status) return !!status.claudeCli
  return getState().providers.some((p) => p.id === 'claude' && p.available)
}

export function openLink(url: string): void {
  void hive.app.openExternal({ url }).catch(() => toast('Couldn’t open the link.', 'error'))
}

// ---------- plan tailoring (§6.2) ----------

/** The answers hash the last automatic agent request was made for: entering Plan re-asks only when it changed. */
let lastAgentHash: string | null = null

/** Ask main for a tailored plan for the current answers (needs the Claude CLI). */
export function tailorPlan(): void {
  const d = getState().onboardingDraft
  if (!d || !hasClaudeCli()) return
  lastAgentHash = draftInputsHash(d, onboardingPlanContext())
  void requestOnboardingPlan(true)
}

/** Entering Plan: re-ask once when the answers changed since the last automatic request (keys added on Content). */
export function maybeRetailor(): void {
  const s = getState()
  const d = s.onboardingDraft
  if (!d || s.onboardingPlanPending || !hasClaudeCli()) return
  const ctx = onboardingPlanContext()
  const hash = draftInputsHash(d, ctx)
  if (lastAgentHash === hash) return
  if (d.plan && d.plan.source === 'agent' && d.plan.inputsHash === hash) return
  // only automatic when a request was already made for an earlier version of these answers (left Goals)
  if (lastAgentHash === null) return
  tailorPlan()
}

/** Test seam. */
export function resetTailorMemory(): void {
  lastAgentHash = null
}

// ---------- Next (§2, §3) ----------

/** The site read behind the Name step's Continue (§5.3); failures are quiet (the field is still saved). */
let siteSeq = 0
function readSite(raw: string): Promise<void> {
  const url = siteFetchUrl(raw)
  if (!url) return Promise.resolve()
  const seq = ++siteSeq
  setLocal({ siteReading: true })
  return hive.onboarding
    .fetchSite({ url })
    .then((site) => {
      if (seq !== siteSeq) return
      onboardingDispatch({ type: 'setSite', site })
      onboardingDispatch({ type: 'applyPrefill' })
    })
    .catch(() => undefined)
    .finally(() => {
      if (seq === siteSeq) setLocal({ siteReading: false })
    })
}

/**
 * The primary button on a question step. Name → (website typed) site read in the background; Goals → plan tailoring
 * starts in the background (§2 S4); Plan → launch.
 */
export function next(): void {
  const d = getState().onboardingDraft
  if (!d) return
  if (d.step === 'plan') return void launch()
  if (d.step === 'brief') return void readBrief()
  // From a repo: the scan's answers first, so a found name skips the Name step
  if (d.step === 'connect' && d.start === 'repo') onboardingDispatch({ type: 'applyPrefill' })
  if (d.step === 'name') {
    const handle = instagramHandle(d.answers.siteUrl)
    if (handle) onboardingDispatch({ type: 'setAnswers', patch: { instagram: handle, siteUrl: '' } })
    else if (d.answers.siteUrl.trim()) void readSite(d.answers.siteUrl)
  }
  onboardingDispatch({ type: 'next' })
  const after = getState().onboardingDraft
  if (d.step === 'goals' && after && after.step !== 'goals') tailorPlan()
  // From a repo goes straight to Plan: tailor it from the scan right away
  else if (d.start === 'repo' && after?.step === 'plan') tailorPlan()
}

// ---------- From a prompt (§2 S0b) ----------

let briefSeq = 0

/**
 * The Brief step's primary: main reads the answers out of the brief (Claude when installed, else the deterministic
 * fallback). Read by Claude with a name → Plan, tailored with the brief; otherwise → Name with what could be read, the
 * brief kept, so nothing is lost.
 */
export async function readBrief(): Promise<void> {
  const d = getState().onboardingDraft
  if (!d || d.step !== 'brief' || !d.brief?.trim() || local.briefReading) return
  const seq = ++briefSeq
  const requestId = `${d.id}-b${seq}`
  setLocal({ briefReading: true })
  let res: BriefResult
  try {
    res = await hive.onboarding.brief({ requestId, brief: d.brief })
  } catch {
    res = { answers: briefFallback(d.brief), source: 'template', fallbackReason: 'exit' }
  }
  if (seq !== briefSeq) return
  setLocal({ briefReading: false })
  const cur = getState().onboardingDraft
  // closed meanwhile (Esc saves the draft): the answer waits for nothing; Build my plan asks again on return
  if (!cur || cur.step !== 'brief' || !getState().onboarding?.open) return
  onboardingDispatch({ type: 'briefRead', answers: res.answers, source: res.source })
  const after = getState().onboardingDraft
  if (!after) return
  // the site read changes the plan's inputs: on the way to Plan it lands first, so the tailored plan is not made stale
  const site = after.answers.siteUrl.trim() && !instagramHandle(after.answers.siteUrl) ? readSite(after.answers.siteUrl) : null
  if (after.step === 'plan') {
    if (site) await site
    if (getState().onboardingDraft?.step === 'plan') tailorPlan()
  } else toast(res.fallbackReason === 'no-cli' ? 'Install Claude Code to read a brief for you. We filled in what we could; check the name.' : 'We filled in what we could from your brief. Check the name and carry on.')
}

/** Brief step "Answer questions instead": the no-model read, then the guided questions (the brief stays in the draft). */
export function skipBrief(): void {
  const d = getState().onboardingDraft
  if (!d || d.step !== 'brief') return
  cancelBriefRead()
  onboardingDispatch({ type: 'briefRead', answers: briefFallback(d.brief ?? ''), source: 'template' })
}

/** Back or close while the brief is being read: the call is killed and its answer ignored. */
export function cancelBriefRead(): void {
  const d = getState().onboardingDraft
  const seq = briefSeq++
  if (!local.briefReading) return
  setLocal({ briefReading: false })
  if (d) void hive.onboarding?.cancelBrief?.({ requestId: `${d.id}-b${seq}` })?.catch?.(() => undefined)
}

export function back(): void {
  if (getState().onboardingDraft?.step === 'brief') cancelBriefRead()
  onboardingDispatch({ type: 'back' })
}

// ---------- launch (§7) ----------

let launching = false

function progressFrom(res: Pick<LaunchResult, 'journalId' | 'steps'>): Partial<Record<LaunchStepName, ProgressEvent>> {
  const out: Partial<Record<LaunchStepName, ProgressEvent>> = {}
  for (const st of res.steps) {
    if (st.status === 'pending') continue
    out[st.name] = { journalId: res.journalId, step: st.name, status: st.status, label: LAUNCH_STEP_LABELS[st.name], ...(st.error ? { error: st.error } : {}) }
  }
  return out
}

function applyResult(res: LaunchResult): void {
  setLocal({ result: res, launchError: null })
  setState((s) => ({
    onboardingProgress: {
      journalId: res.journalId,
      steps: { ...(s.onboardingProgress.journalId === res.journalId ? s.onboardingProgress.steps : {}), ...progressFrom(res) },
      clone: s.onboardingProgress.journalId === res.journalId ? s.onboardingProgress.clone : null
    }
  }))
  onboardingDispatch({ type: 'launchStarted', journalId: res.journalId })
  if (res.status === 'done') applyChatLogo(getState().onboardingDraft, res.companyId)
  if (res.status === 'done') onboardingDispatch({ type: 'launchDone', journalId: res.journalId })
  else if (res.status === 'failed') onboardingDispatch({ type: 'launchFailed', journalId: res.journalId })
  else if (res.status === 'discarded') discardOnboarding()
  flushOnboardingDraft()
}

/**
 * A company started from a chat (shared/chatCompany.ts): the emblem picked on the card, once it exists. With a repo
 * (`keepDetected`) the repo's own logo wins when one was found. Once per draft; failures keep the initial.
 */
const logoApplied = new Set<string>()
function applyChatLogo(d: OnboardingDraft | null, companyId: string | null): void {
  const logo = d?.fromChat?.logo
  if (!d || !logo || !companyId || logoApplied.has(d.id)) return
  logoApplied.add(d.id)
  void hive.company
    .setLogo({ id: companyId, pick: { kind: 'emblem', variant: logo.variant, keepDetected: logo.keepDetected } })
    .then((res) => res && setState((s) => ({ companyLogos: { ...s.companyLogos, [companyId]: res } })))
    .catch(() => undefined)
}

async function runLaunch(call: () => Promise<LaunchResult>, d: OnboardingDraft): Promise<void> {
  launching = true
  try {
    applyResult(await call())
  } catch (e) {
    const cur = getState().onboardingDraft
    if (cur && !cur.journalId && !getState().onboardingProgress.journalId) {
      // main refused before anything was created (preflight): back to Plan with the reason
      const back = reconcileLaunchDraft(cur, null)
      if (back) setState({ onboardingDraft: back })
      flushOnboardingDraft()
      toast(errorMessage(e), 'error')
    } else {
      // the journal may be known only from progress events: keep it, so Retry resumes and Discard undoes it in main
      const journalId = cur?.journalId ?? d.journalId ?? getState().onboardingProgress.journalId
      onboardingDispatch({ type: 'launchFailed', ...(journalId ? { journalId } : {}) })
      setLocal({ launchError: errorMessage(e) })
    }
  } finally {
    launching = false
  }
}

/** Plan's primary ("Create Sunday Bakery") and Retry: start the launch, or resume the draft's journal. */
export async function launch(): Promise<void> {
  const d = getState().onboardingDraft
  if (!d || launching) return
  const input = launchInput(d, onboardingPlanContext())
  if (!input) {
    toast(d.plan ? 'Something in the plan can’t be created. Check the names and try again.' : 'The plan isn’t ready yet.', 'error')
    return
  }
  setLocal({ launchError: null })
  if (d.step === 'plan') {
    setState({ onboardingProgress: { journalId: null, steps: {}, clone: null } })
    onboardingDispatch({ type: 'next' })
  } else {
    onboardingDispatch({ type: 'launchResumed' })
  }
  flushOnboardingDraft()
  await runLaunch(() => hive.onboarding.launch({ ...(d.journalId ? { journalId: d.journalId } : {}), draftId: d.id, input }), d)
}

/** Retry needs the answers; a draft rebuilt from a journal alone (another Mac session lost them) can only Discard. */
export function canRetry(d: OnboardingDraft): boolean {
  return !!launchInput(d, onboardingPlanContext())
}

export function isSoftStep(step: LaunchStepName): step is SoftLaunchStep {
  return (SOFT_LAUNCH_STEPS as readonly string[]).includes(step)
}

/** "Continue without this" (soft steps only). */
export async function skipStep(step: LaunchStepName): Promise<void> {
  const d = getState().onboardingDraft
  const journalId = d?.journalId ?? getState().onboardingProgress.journalId
  if (!d || !journalId || launching || !isSoftStep(step)) return
  setLocal({ launchError: null })
  onboardingDispatch({ type: 'launchResumed' })
  await runLaunch(() => hive.onboarding.skipStep({ journalId, step }), d)
}

/** Discard: confirm, undo in main, close. Folders and clones stay on disk. */
export async function discard(): Promise<void> {
  const d = getState().onboardingDraft
  if (!d || launching) return
  const name = d.answers.name.trim() || 'this business'
  const ok = await confirmNative({
    message: `Archive ${name} and undo what was set up?`,
    detail: 'Your folders and clones stay on disk.',
    confirmLabel: 'Discard',
    destructive: true
  })
  if (!ok) return
  // a journal known only from progress events still has things to undo: never just forget it locally
  const journalId = d.journalId ?? getState().onboardingProgress.journalId
  try {
    if (journalId) await hive.onboarding.discard({ journalId })
    discardOnboarding()
    toast(`Discarded ${name}. Your folders and clones stay on disk.`)
  } catch (e) {
    toast(errorMessage(e), 'error')
  }
}

/**
 * Ready step: Start now (autopilot on, ticked schedules on by their plan refs, auto agents raised) → company Home; I'll review first →
 * nothing turned on → the Board.
 * `ceremony` (Start now in playful tone): once start resolves, the launch ceremony plays instead of closing; it lands
 * on Home through finishCeremony(). Plain tone and I'll review first never pass it.
 */
export async function start(opts: { autopilot: boolean; scheduleRefs: string[]; ceremony?: boolean }): Promise<boolean> {
  const d = getState().onboardingDraft
  const res = local.result
  const journalId = d?.journalId ?? res?.journalId
  const companyId = res?.companyId ?? getState().onboardingStatus?.journal?.companyId ?? null
  if (!journalId || !companyId) {
    toast('Couldn’t find the new company. Open it from the rail.', 'error')
    return false
  }
  if (opts.autopilot) {
    try {
      await hive.onboarding.start({ journalId, autopilot: true, scheduleRefs: opts.scheduleRefs })
    } catch (e) {
      toast(errorMessage(e), 'error')
      return false
    }
  }
  if (opts.autopilot && opts.ceremony) {
    // the draft and the result stay until the ceremony ends: it shows the team from them
    setLocal({ ceremony: { companyId } })
    return true
  }
  setLocal({ result: null, ceremony: null })
  await finishOnboarding(companyId, opts.autopilot ? 'home' : 'board')
  return true
}

/** The company of this launch's journal, or null when the journal on hand belongs to another setup. */
function journalCompany(journalId: string | undefined, j = getState().onboardingStatus?.journal): string | null {
  return journalId && j && j.id === journalId ? (j.companyId ?? null) : null
}

/**
 * Five doors step 5 (design §6.7): the Ready step's one action. Nothing starts here: the new company opens on Home,
 * whose first card asks "Your team is ready. Start the first week?" (components/home/FirstRunCards). The journal and
 * the schedules ticked on Ready wait in settings.firstWeek until that question is answered.
 */
export async function landOnHome(opts: { scheduleRefs: string[] }): Promise<boolean> {
  const d = getState().onboardingDraft
  const res = local.result
  const journalId = d?.journalId ?? res?.journalId
  // the launch result, else the journal of THIS launch only (a stale journal from another setup never names the company)
  let companyId = res && res.journalId === journalId ? res.companyId : journalCompany(journalId)
  if (!companyId && journalId) companyId = journalCompany(journalId, (await refreshOnboardingStatus().catch(() => null))?.journal)
  if (!journalId || !companyId) {
    toast('Couldn’t find the new company. Open it from the rail.', 'error')
    return false
  }
  try {
    await updateSettings({ firstWeek: { ...(getState().settings?.firstWeek ?? {}), [companyId]: { journalId, scheduleRefs: opts.scheduleRefs.slice(0, 8) } } })
  } catch {
    /* Home then shows no first-week card; each task still waits in To do with Start */
  }
  setLocal({ result: null, ceremony: null })
  await finishOnboarding(companyId, 'home')
  return true
}

let finishing = false
/** The ceremony's CTA ("Go to Sunday Bakery"), Skip and Esc: the same close + enterCompany as Start now. Once. */
export async function finishCeremony(): Promise<void> {
  const c = local.ceremony
  if (!c || finishing) return
  finishing = true
  try {
    // finishOnboarding closes the flow synchronously before its first await, so the Ready step never flashes back
    const done = finishOnboarding(c.companyId, 'home')
    setLocal({ result: null, ceremony: null })
    await done
  } finally {
    finishing = false
  }
}

/** The current draft's plan input hash (the Plan step's template dispatch). */
export function currentInputs(d: OnboardingDraft): { input: ReturnType<typeof planInput>; hash: string } {
  const input = planInput(d, onboardingPlanContext())
  return { input, hash: inputsHash(input) }
}
