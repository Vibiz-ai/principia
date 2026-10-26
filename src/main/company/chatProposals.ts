/**
 * "Start a company from this chat" (shared/chatCompany.ts): main's side of `principia_propose_company`.
 *
 * - `propose` (the broker, for a chat session): checks the arguments, opens ONE pending proposal for that session,
 *   emits it to the renderer (the confirmation card) and waits for the founder's decision, the wait ending, or the
 *   agent canceling. Nothing is created here: confirming only opens the onboarding in the renderer.
 * - `decide` (chatCompany:decide): accept (with the edited name and brief) or decline; answers the waiting call.
 * - `openLocal` (the "New company from chat" button, codex panes): a card with no waiting call.
 * No Electron imports (testable with fakes).
 */
import {
  MAX_OPEN_PER_SESSION,
  PROPOSAL_LIMITS,
  PROPOSAL_WAIT_S,
  normalizeProposalArgs,
  proposalResult,
  type CompanyProposal,
  type ProposalDecision,
  type ProposalToolResult
} from '../../shared/chatCompany'
import { HiveError } from '../../shared/errors'

export interface ChatProposalDeps {
  emit(p: CompanyProposal): void
  /** the session's title (shown on the card), null when unknown */
  sessionTitle(sessionId: string): string | null
  home?: string
  now?: () => number
  newId?: () => string
  /** how long a call waits for the decision (ms); default PROPOSAL_WAIT_S */
  waitMs?: number
  /** brings the window forward / notifies (best effort) */
  attention?(p: CompanyProposal): void
}

/** Decided proposals are kept briefly (a late chatCompany:list still shows the outcome), then dropped. */
const KEEP_DECIDED = 20

export class ChatProposals {
  private items = new Map<string, CompanyProposal>()
  private waiters = new Map<string, (p: CompanyProposal) => void>()
  private seq = 0

  constructor(private d: ChatProposalDeps) {}

  private now(): string {
    return new Date(this.d.now?.() ?? Date.now()).toISOString()
  }
  private id(): string {
    return this.d.newId?.() ?? `cpr_${Date.now().toString(36)}${(++this.seq).toString(36)}`
  }

  list(): CompanyProposal[] {
    return [...this.items.values()].filter((p) => p.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  get(id: string): CompanyProposal | null {
    return this.items.get(id) ?? null
  }

  /** The tool call. Resolves with what the chat is told. */
  async propose(sessionId: string, rawArgs: unknown, signal?: AbortSignal): Promise<ProposalToolResult> {
    const args = normalizeProposalArgs(rawArgs, this.d.home)
    if (!args.ok) throw new Error(args.error)
    const open = this.list().filter((p) => p.sessionId === sessionId)
    if (open.length >= MAX_OPEN_PER_SESSION) {
      return { status: 'busy', name: open[0]!.name, note: 'A company card from this chat is already waiting in Principia. Wait for the user to decide; do not call again.' }
    }
    const p: CompanyProposal = {
      id: this.id(),
      sessionId,
      sessionTitle: this.d.sessionTitle(sessionId),
      ...args.value,
      status: 'pending',
      createdAt: this.now(),
      decidedAt: null
    }
    this.put(p)
    this.d.attention?.(p)
    const decided = await new Promise<CompanyProposal>((resolve) => {
      const done = (x: CompanyProposal) => {
        clearTimeout(timer)
        this.waiters.delete(p.id)
        resolve(x)
      }
      this.waiters.set(p.id, done)
      const timer = setTimeout(() => done(this.close(p.id, 'expired')), this.d.waitMs ?? PROPOSAL_WAIT_S * 1000)
      ;(timer as { unref?: () => void }).unref?.()
      if (signal?.aborted) done(this.close(p.id, 'expired'))
      signal?.addEventListener('abort', () => done(this.close(p.id, 'expired')), { once: true })
    })
    return proposalResult(decided)
  }

  /** The "New company from chat" button: a card nobody waits on. */
  openLocal(input: { sessionId: string | null; name?: string; brief?: string }): CompanyProposal {
    const p: CompanyProposal = {
      id: this.id(),
      sessionId: input.sessionId,
      sessionTitle: input.sessionId ? this.d.sessionTitle(input.sessionId) : null,
      name: (input.name ?? '').trim().slice(0, PROPOSAL_LIMITS.name),
      brief: (input.brief ?? '').trim().slice(0, PROPOSAL_LIMITS.brief),
      repo: null,
      website: null,
      status: 'pending',
      createdAt: this.now(),
      decidedAt: null
    }
    this.put(p)
    return p
  }

  /** The card's buttons. Accepting keeps the founder's edits; the waiting call gets the outcome. */
  decide(req: ProposalDecision): CompanyProposal {
    const p = this.items.get(req.id)
    if (!p) throw new HiveError('not_found', 'That company card is gone')
    if (p.status !== 'pending') throw new HiveError('conflict', `That company card was already ${p.status}`)
    if (req.accept) {
      const name = typeof req.name === 'string' ? req.name.replace(/\s+/g, ' ').trim().slice(0, PROPOSAL_LIMITS.name) : p.name
      const brief = typeof req.brief === 'string' ? req.brief.trim().slice(0, PROPOSAL_LIMITS.brief) : p.brief
      if (!brief && !name) throw new HiveError('bad_request', 'Add a name or a few words about the company first')
      this.items.set(p.id, { ...p, name, brief })
    }
    const out = this.close(p.id, req.accept ? 'accepted' : 'declined')
    this.waiters.get(p.id)?.(out)
    return out
  }

  private close(id: string, status: 'accepted' | 'declined' | 'expired'): CompanyProposal {
    const p = this.items.get(id)!
    if (p.status !== 'pending') return p
    const out: CompanyProposal = { ...p, status, decidedAt: this.now() }
    this.put(out)
    return out
  }

  private put(p: CompanyProposal): void {
    this.items.set(p.id, p)
    const decided = [...this.items.values()].filter((x) => x.status !== 'pending')
    for (const x of decided.slice(0, Math.max(0, decided.length - KEEP_DECIDED))) this.items.delete(x.id)
    this.d.emit(p)
  }
}
