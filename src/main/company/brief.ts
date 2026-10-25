/**
 * PLANS.md §1: task briefs, main's side. Pure edits (editSection, setCriterion, decide…), the store writes (BriefStore:
 * the brief and proof live in the task JSON, written with a json_set so a task in flight keeps its run), the short
 * prompt block a task turn carries in place of the raw description, proof validation, and the run-end handoff fill.
 *
 * Nothing here ever nags: no tool is required, a turn is never failed or re-woken for a missing brief edit. When a turn
 * that reported ends without a handoff edit, Principia writes the handoff from the report summary (by 'system').
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { HiveError } from '../../shared/errors'
import { BRIEF_LIMITS, BRIEF_PROMPT_LIMITS, briefOf, proofOf, type BriefAuthor, type BriefCriterion, type BriefSection, type CriterionState, type EditableSection, type ProofKind, type TaskBrief, type TaskProof } from '../../shared/plans'
import type { BoardTask } from '../../shared/company'
import type { CompanyStore } from './index'
import { briefSchema, proofSchema } from './briefSchemas'

const fail = (message: string): never => { throw new HiveError('bad_request', message) }
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s
const uid = (p: string) => `${p}${randomBytes(4).toString('hex')}`

// ---------- pure edits ----------

function revise(b: TaskBrief, section: BriefSection, by: BriefAuthor, at: string): TaskBrief {
  return { ...b, revisions: [...b.revisions, { at, by, section }].slice(-BRIEF_LIMITS.revisions) }
}
const nextCriterionId = (b: TaskBrief) => `c${b.criteria.reduce((n, c) => Math.max(n, Number(c.id.replace(/^c/, '')) || 0), 0) + 1}`
const nextQuestionId = (b: TaskBrief) => `q${b.questions.reduce((n, c) => Math.max(n, Number(c.id.replace(/^q/, '')) || 0), 0) + 1}`
const lines = (text: string) => text.split('\n').map(l => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s*/i, '').trim()).filter(Boolean)

/** task_brief_edit / the inspector: replace or append one section. Criteria and questions take one item per line. */
export function editSection(b: TaskBrief, section: EditableSection, mode: 'replace' | 'append', text: string, by: BriefAuthor, at: string): TaskBrief {
  const t = text.trim()
  let out: TaskBrief
  switch (section) {
    case 'goal': case 'context': case 'handoff': {
      const max = section === 'goal' ? BRIEF_LIMITS.goal : section === 'context' ? BRIEF_LIMITS.context : BRIEF_LIMITS.handoff
      const v = mode === 'append' && b[section].trim() ? `${b[section].trim()}\n\n${t}` : t
      if (v.length > max) fail(`The ${section} is limited to ${max} characters`)
      out = { ...b, [section]: v }
      break
    }
    case 'criteria': {
      const items = lines(t)
      if (!items.length && mode === 'append') fail('Write the criterion')
      for (const i of items) if (i.length > BRIEF_LIMITS.criterion) fail(`A criterion is limited to ${BRIEF_LIMITS.criterion} characters`)
      let criteria: BriefCriterion[]
      if (mode === 'append') {
        criteria = [...b.criteria]
        for (const text of items) criteria.push({ id: nextCriterionId({ ...b, criteria }), text, state: 'open' })
      } else {
        // a criterion kept word for word keeps its state
        criteria = []
        for (const text of items) {
          const same = b.criteria.find(c => c.text === text)
          criteria.push(same ?? { id: nextCriterionId({ ...b, criteria: [...b.criteria, ...criteria] }), text, state: 'open' })
        }
      }
      if (criteria.length > BRIEF_LIMITS.criteria) fail(`At most ${BRIEF_LIMITS.criteria} criteria`)
      out = { ...b, criteria }
      break
    }
    case 'questions': {
      const items = lines(t)
      if (!items.length && mode === 'append') fail('Write the question')
      const base = mode === 'append' ? [...b.questions] : []
      for (const text of items) base.push(mode === 'replace' ? (b.questions.find(q => q.text === text) ?? { id: nextQuestionId({ ...b, questions: [...b.questions, ...base] }), text: clip(text, BRIEF_LIMITS.question) }) : { id: nextQuestionId({ ...b, questions: base }), text: clip(text, BRIEF_LIMITS.question) })
      if (base.length > BRIEF_LIMITS.questions) fail(`At most ${BRIEF_LIMITS.questions} open questions`)
      out = { ...b, questions: base }
      break
    }
  }
  // saving what is already there (Edit goal, then Enter) is no revision (QA: 'Revisions · 3' with no change)
  if (JSON.stringify(out[section]) === JSON.stringify(b[section])) return b
  return revise(out, section, by, at)
}
/** A criterion by id (c3), by its 1-based number, or by its exact text. */
function findCriterion(b: TaskBrief, ref: string): BriefCriterion {
  const r = ref.trim()
  const byId = b.criteria.find(c => c.id === r || c.id === `c${r}`)
  if (byId) return byId
  const byText = b.criteria.find(c => c.text.toLowerCase() === r.toLowerCase())
  return byText ?? fail(`No criterion "${clip(r, 60)}". Known: ${b.criteria.map(c => c.id).join(', ') || 'none (add one with task_brief_edit section criteria)'}`)
}
/** task_criterion: deferred and not_done need a reason, so the next agent and the founder know why. */
export function setCriterion(b: TaskBrief, ref: string, state: CriterionState, reason: string | undefined, by: BriefAuthor, at: string): TaskBrief {
  const why = reason?.trim() ?? ''
  if ((state === 'deferred' || state === 'not_done') && !why) fail(`A ${state === 'deferred' ? 'deferred' : 'not done'} criterion needs a reason: say why in "reason".`)
  if (why.length > BRIEF_LIMITS.reason) fail(`The reason is limited to ${BRIEF_LIMITS.reason} characters`)
  const c = findCriterion(b, ref)
  const next: BriefCriterion = { id: c.id, text: c.text, state, ...(why && state !== 'open' ? { reason: why } : {}) }
  return revise({ ...b, criteria: b.criteria.map(x => x.id === c.id ? next : x) }, 'criteria', by, at)
}
export function removeCriterion(b: TaskBrief, ref: string, by: BriefAuthor, at: string): TaskBrief {
  const c = findCriterion(b, ref)
  return revise({ ...b, criteria: b.criteria.filter(x => x.id !== c.id) }, 'criteria', by, at)
}
/** task_decide: a decision always carries its why. */
export function decide(b: TaskBrief, text: string, why: string, by: BriefAuthor, at: string): TaskBrief {
  const t = text.trim(), w = why.trim()
  if (!t) fail('Write the decision')
  if (!w) fail('Say why: a decision without its reason does not help the next agent')
  if (t.length > BRIEF_LIMITS.decision || w.length > BRIEF_LIMITS.why) fail(`A decision and its why are limited to ${BRIEF_LIMITS.decision} characters each`)
  return revise({ ...b, decisions: [...b.decisions, { text: t, why: w, by, at }].slice(-BRIEF_LIMITS.decisions) }, 'decisions', by, at)
}
export function answerQuestion(b: TaskBrief, id: string, answer: string, by: BriefAuthor, at: string): TaskBrief {
  const q = b.questions.find(x => x.id === id) ?? fail('No such question')
  return revise({ ...b, questions: b.questions.map(x => x.id === q.id ? { ...x, answer: clip(answer.trim(), BRIEF_LIMITS.answer) } : x) }, 'questions', by, at)
}

/**
 * The founder edited the task's Description after the task got a brief: the brief's Context follows it, so the edit
 * reaches the inspector and the agent (one source of truth). Unchanged text writes no revision.
 */
export function contextFromDescription(b: TaskBrief, description: string, at: string): TaskBrief {
  const text = clip(description.trim(), BRIEF_LIMITS.context)
  if (text === b.context.trim()) return b
  return revise({ ...b, context: text }, 'context', 'human', at)
}
/** Why the Board does not start a plan task by itself (CompanyStore.startTask; the Board's Run now goes through the pilot). */
export function planStartRefusal(t: Pick<BoardTask, 'identifier' | 'plan'>): string {
  return t.plan?.role === 'milestone'
    ? `${t.identifier} holds a plan milestone; it does not run. Start one of its tasks from the plan.`
    : `${t.identifier} belongs to a plan. Start it from the plan (or Run now), so it runs in its milestone's worktree.`
}

// ---------- the prompt block ----------

/** Data text: a `</principia-…>` inside it cannot close the block it sits in. */
const data = (s: string) => s.replace(/<(\/?)principia-/gi, '<$1principia‐')
/** One short paragraph of habits; the footer's "You cannot mark tasks done" stays where it is. */
export const BRIEF_HABITS =
  'Keep this brief true as you work: each time you choose between options, record it with task_decide (with its why); tick a criterion with task_criterion when it holds (a deferred or not-done one needs a reason); attach proof with task_attach_proof. Before task_report, rewrite the handoff with task_brief_edit (section handoff): what you did, what is left, what the next agent must know.'

/**
 * What a task turn carries of the brief: the goal, a capped context, the OPEN criteria only (counts for the rest), the
 * last 5 decisions, unanswered questions and the handoff. Sized on purpose (PLANS.md risk 1); the agent reads the whole
 * brief with task_get when it needs it.
 */
export function briefPromptBlock(t: Pick<BoardTask, 'description'> & { brief?: TaskBrief | null; proof?: TaskProof[] }): string {
  const b = briefOf(t)
  const L = BRIEF_PROMPT_LIMITS
  const out: string[] = []
  if (b.goal.trim()) out.push(`Goal: ${data(clip(b.goal.trim(), L.goal))}`)
  out.push('Context:', data(clip(b.context.trim(), L.context)) || '(none)')
  const open = b.criteria.filter(c => c.state === 'open')
  if (b.criteria.length) {
    const rest = b.criteria.length - open.length
    out.push('', `Acceptance criteria still open${rest ? ` (${rest} already settled)` : ''}:`)
    for (const c of open) out.push(`- [${c.id}] ${data(clip(c.text, L.criterion))}`)
    if (!open.length) out.push('- (none open)')
  }
  const recent = b.decisions.slice(-L.decisions)
  if (recent.length) {
    out.push('', 'Recent decisions:')
    for (const d of recent) out.push(`- ${data(clip(d.text, L.decision))} (why: ${data(clip(d.why, L.decision))})`)
  }
  const qs = b.questions.filter(q => !q.answer).slice(0, L.questions)
  if (qs.length) { out.push('', 'Open questions:'); for (const q of qs) out.push(`- ${data(clip(q.text, L.criterion))}`) }
  const answered = b.questions.filter(q => q.answer).slice(-L.questions)
  if (answered.length) { out.push('', 'Answered:'); for (const q of answered) out.push(`- ${data(clip(q.text, L.criterion))} → ${data(clip(q.answer!, L.criterion))}`) }
  if (b.handoff.trim()) out.push('', 'Notes for the next agent:', data(clip(b.handoff.trim(), L.handoff)))
  const proof = proofOf(t)
  if (proof.length) out.push('', `Proof attached: ${proof.length} (${[...new Set(proof.map(p => p.kind))].join(', ')})`)
  out.push('', BRIEF_HABITS)
  return out.join('\n')
}

/**
 * task_report's nudge: what this turn has not written to the brief yet (the handoff, any decision). Empty when it did.
 * Advice only: the report stands either way, and at run end Principia writes a missing handoff from the summary.
 */
export function briefReminder(t: { brief?: TaskBrief | null; description: string }, since: string | null, by: BriefAuthor): string {
  const b = briefOf(t)
  const mine = (section: BriefSection) => b.revisions.some(r => r.section === section && r.by === by && (!since || r.at >= since))
  const missing: string[] = []
  if (!mine('handoff')) missing.push('rewrite the handoff with task_brief_edit (section handoff, mode replace): what you did, what is left, what the next agent must know')
  if (!mine('decisions')) missing.push('record each choice you made with task_decide (text and why)')
  return missing.length ? `Before you end the turn: ${missing.join('; and ')}.` : ''
}

// ---------- proof ----------

/** File names that never leave the machine as proof (keys, env files, credentials). */
const SECRET_NAME = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i
const SECRET_DIR = /(^|\/)(\.ssh|\.aws|\.gnupg|\.config\/gcloud)(\/|$)/i
const IMAGE = /\.(png|jpe?g|gif|webp)$/i
const real = (p: string): string | null => { try { return fs.realpathSync(p) } catch { return null } }
const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/**
 * The ref of one proof, checked. Links: http(s) only. Files and screenshots: an existing file inside one of `roots` (the
 * task's worktree, its run's artifacts), never a secret-looking name; a relative path resolves against the first root that has it.
 * Test results and graphs: text (a command and its result, a mermaid graph), length-capped. `redact` runs on every ref.
 */
export function checkProofRef(kind: ProofKind, ref: string, roots: readonly string[], redact: (s: string) => string): string {
  const r = ref.trim()
  if (!r) fail('Give the proof a ref (a path, a link or the test output)')
  if (kind === 'link') {
    if (!/^https?:\/\/\S+$/i.test(r)) fail('A link must be an http(s) URL')
    return clip(redact(r), BRIEF_LIMITS.proofRef)
  }
  if (kind === 'test' || kind === 'graph') {
    // a test result or graph may also point at a file in the worktree; otherwise it is the text itself
    if (!/^(\/|\.\/|\.\.\/)/.test(r)) return clip(redact(r), BRIEF_LIMITS.proofRef)
  }
  const real0 = roots.map(real).filter((x): x is string => !!x)
  if (!real0.length) fail("This task has no worktree or artifacts folder yet: attach links or test output instead of files")
  // a relative path is the agent's: it resolves against the first root that has it (the worktree it works in comes first)
  const abs = path.isAbsolute(r) ? r : (real0.map(root => path.resolve(root, r)).find(x => fs.existsSync(x)) ?? path.resolve(real0[0], r))
  const p = real(abs) ?? fail(`No such file: ${clip(r, 200)}`)
  if (!real0.some(root => inside(root, p))) fail("Proof files must come from this task's worktree or its run's artifacts folder")
  if (SECRET_NAME.test(p) || SECRET_DIR.test(p)) fail('That file looks like a secret; it cannot be attached as proof')
  let st: fs.Stats
  try { st = fs.statSync(p) } catch { return fail(`No such file: ${clip(r, 200)}`) }
  if (!st.isFile()) fail('Attach a file, not a folder')
  if (kind === 'screenshot' && !IMAGE.test(p)) fail('A screenshot must be a .png, .jpg, .gif or .webp file')
  return clip(redact(p), BRIEF_LIMITS.proofRef)
}
export const isImageRef = (ref: string) => IMAGE.test(ref)

// ---------- the store ----------

export class BriefStore {
  constructor(private readonly c: () => CompanyStore, private readonly now: () => Date = () => new Date()) {}
  private get db() { return this.c().store.db }
  /** Writes brief and/or proof into the task JSON, nothing else (a task in flight keeps its run and status). */
  write(taskId: string, patch: { brief?: TaskBrief; proof?: TaskProof[]; description?: string }): BoardTask {
    const t = this.c().task(taskId)
    const brief = patch.brief ? briefSchema.parse(patch.brief) : undefined
    const proof = patch.proof ? patch.proof.map(p => proofSchema.parse(p)) : undefined
    const sets: string[] = []; const args: unknown[] = []
    if (brief) { sets.push("'$.brief',json(?)"); args.push(JSON.stringify(brief)) }
    if (proof) { sets.push("'$.proof',json(?)"); args.push(JSON.stringify(proof)) }
    if (patch.description !== undefined) { sets.push("'$.description',?"); args.push(patch.description) }
    if (!sets.length) return t
    this.db.prepare(`UPDATE company_tasks SET data=json_set(data,${sets.join(',')},'$.updatedAt',?) WHERE id=?`).run(...args, this.now().toISOString(), t.id)
    return this.c().task(t.id)
  }
  /** One edit of the brief: fn gets the current brief (old rows: the description as Context). */
  edit(taskId: string, fn: (b: TaskBrief, at: string) => TaskBrief): BoardTask {
    return this.db.transaction(() => {
      const t = this.c().task(taskId)
      const before = briefOf(t)
      const brief = fn(before, this.now().toISOString())
      if (brief === before) return t
      // the Context is the description from now on: the edit form and the agent read the same text
      return this.write(taskId, { brief, ...(brief.context !== before.context ? { description: brief.context } : {}) })
    })()
  }
  attach(taskId: string, p: { kind: ProofKind; title: string; ref: string }, by: BriefAuthor): { task: BoardTask; proof: TaskProof } {
    return this.db.transaction(() => {
      const t = this.c().task(taskId)
      const list = proofOf(t)
      if (list.length >= BRIEF_LIMITS.proof) fail(`At most ${BRIEF_LIMITS.proof} proofs per task`)
      const at = this.now().toISOString()
      const proof: TaskProof = { id: uid('pf_'), kind: p.kind, title: clip(p.title.trim() || p.kind, BRIEF_LIMITS.proofTitle), ref: p.ref, by, at }
      const b = briefOf(t)
      const task = this.write(taskId, { proof: [...list, proof], brief: { ...b, revisions: [...b.revisions, { at, by, section: 'proof' as const }].slice(-BRIEF_LIMITS.revisions) } })
      return { task, proof }
    })()
  }
  /**
   * Run end: a turn that reported but did not rewrite the handoff gets one written from its report summary, by
   * 'system'. Nothing else happens (no error, no wake, no re-run). `since`: the run's start.
   */
  fillHandoff(taskId: string, since: string): boolean {
    let t: BoardTask
    try { t = this.c().task(taskId) } catch { return false }
    const summary = t.report?.summary?.trim()
    if (!summary) return false
    const b = briefOf(t)
    if (b.revisions.some(r => r.section === 'handoff' && r.by !== 'system' && r.at >= since)) return false
    const evidence = (t.report?.evidence ?? []).slice(0, 8).map(e => `- ${clip(e, 300)}`)
    const text = clip([summary, ...(evidence.length ? ['', 'Evidence:', ...evidence] : [])].join('\n'), BRIEF_LIMITS.handoff)
    if (b.handoff.trim() === text) return false
    this.edit(taskId, (cur, at) => editSection(cur, 'handoff', 'replace', text, 'system', at))
    return true
  }
}
