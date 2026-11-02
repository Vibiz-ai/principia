/**
 * "Start a company from this chat" (shared/chatCompany.ts): what the confirmation card's buttons do.
 *
 * Confirm: (ask before replacing a half-done setup) → inspect the repo folder / find the clone folder → tell main
 * (the chat's waiting tool call gets "Opened onboarding for X") → open the onboarding "From a prompt" seeded with
 * the brief → scan the repo → read the brief (Claude) → the Plan step, where the founder reviews departments, agents
 * and tasks before launching. The logo choice rides in the draft and is applied once the launch is done (actions.ts).
 * Decline: main answers the chat "declined"; nothing else happens.
 */
import type { CompanyProposal } from '@shared/chatCompany'
import type { FolderCandidate } from '@shared/onboarding'
import { seedFor, type CardEdits } from '../../lib/chatCompany'
import { confirmNative, errorMessage, hive } from '../../lib/hive'
import { chatSeedBlocker, getState, hasSavedOnboarding, onboardingDispatch, openOnboardingFromChat, refreshOnboardingStatus, toast, upsertChatProposal } from '../../state/store'
import { readBrief } from './actions'

let busy = false

/** The card's primary. true when the onboarding opened. */
export async function confirmChatCard(p: CompanyProposal, edits: CardEdits): Promise<boolean> {
  if (busy) return false
  const blocked = chatSeedBlocker()
  if (blocked) {
    toast(blocked, 'error')
    return false
  }
  busy = true
  try {
    if (hasSavedOnboarding()) {
      const ok = await confirmNative({
        message: 'Replace the company you were setting up?',
        detail: 'Its answers are discarded. Nothing was created yet.',
        confirmLabel: 'Replace'
      })
      if (!ok) return false
    }
    let candidate: FolderCandidate | null = null
    let cloneDir: string | null = null
    if (p.repo?.kind === 'local') candidate = (await hive.onboarding.inspectFolders({ paths: [p.repo.path] }).catch(() => [] as FolderCandidate[]))[0] ?? null
    else if (p.repo?.kind === 'url') cloneDir = (await refreshOnboardingStatus())?.defaultCloneDir ?? null
    const { seed, skipped } = seedFor(p, edits, { candidate, cloneDir })
    try {
      await hive.chatCompany.decide({ id: p.id, accept: true, ...(seed.name ? { name: seed.name } : {}), brief: edits.brief })
    } catch {
      // the chat stopped waiting (expired, restarted): the founder still asked for it, so the setup opens anyway
      upsertChatProposal({ ...p, status: 'expired' })
    }
    if (!openOnboardingFromChat(seed)) {
      toast(chatSeedBlocker() ?? 'Couldn’t open the company setup.', 'error')
      return false
    }
    if (skipped) toast(skipped)
    void startFromChat()
    return true
  } finally {
    busy = false
  }
}

/** "Not now": the chat is told the founder declined. */
export async function declineChatCard(p: CompanyProposal): Promise<void> {
  try {
    upsertChatProposal(await hive.chatCompany.decide({ id: p.id, accept: false }))
  } catch (e) {
    upsertChatProposal({ ...p, status: 'expired' })
    const msg = errorMessage(e)
    if (!/already|gone/i.test(msg)) toast(msg, 'error')
  }
}

/** After seeding: the repo's read-only scan (so the plan knows the code), then the brief read that leads to Plan. */
export async function startFromChat(): Promise<void> {
  const d = getState().onboardingDraft
  if (!d?.fromChat || d.step !== 'brief') return
  if (d.repos.length) {
    try {
      const res = await hive.onboarding.scan({ paths: d.repos.map((r) => r.path) })
      const cur = getState().onboardingDraft
      if (cur?.id === d.id && cur.step === 'brief') onboardingDispatch({ type: 'setScan', scan: res.summary })
    } catch {
      /* the plan works without the scan */
    }
  }
  const cur = getState().onboardingDraft
  if (cur?.id === d.id && cur.step === 'brief') await readBrief()
}
