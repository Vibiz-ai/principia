/**
 * Taste capture (Open Passport SPEC.md §4.6, §8.3): what the company's people like and dislike, in general (the
 * `Taste.md` note, `type: taste`) and per department (the department note). A signal names a polarity, a short
 * statement and the example that showed it. The same statement again reinforces the existing line (`x<count>` + 1)
 * instead of adding one. A person's own words are written directly; anything inferred (a task approved or sent back,
 * an agent's memory_taste) becomes a `taste` proposal in the Inbox, so nothing is learned behind the user's back.
 */
import type { IndexDB } from './vault/indexDb'
import type { PassportDepartment, ProposalEvidence, VaultOp } from '../../shared/passport'
import { parseTasteText, formatTasteText, tasteExample, type TasteCategory } from '../../shared/vault/grammar'
import { pathStem } from '../../shared/vault/resolve'
import { departmentNote } from './brief'
import { normText } from '../openPassport'

export const TASTE_NOTE_TITLE = 'Taste'
export const TASTE_LIMITS = { statement: 200, example: 300 }

export interface TasteInput {
  scope: 'company' | { department: PassportDepartment }
  polarity: TasteCategory
  /** the taste as a short statement: "Plain-text launch emails" */
  text: string
  /** a `[[Note]]` or a quote that shows it */
  example: string
}

export interface TastePlan {
  ops: VaultOp[]
  /** the note the line lands on (title), for evidence */
  note: string
  /** the existing line this reinforces, if any */
  reinforces: string | null
  /** `taste:<scope>:<polarity>:<statement>:<example>`: the same signal never files twice */
  key: string
  evidence: ProposalEvidence[]
}

/** One line, no `;` (taste items are joined with `; ` in renders), at most 200 chars. */
export function cleanStatement(text: string): string {
  const t = text.replace(/[\r\n]+/g, ' ').replace(/;/g, ',').replace(/\s+/g, ' ').trim()
  return t.length > TASTE_LIMITS.statement ? `${t.slice(0, TASTE_LIMITS.statement - 1)}…` : t
}

/**
 * The ops for one taste signal: reinforce the live line with the same polarity and statement on the target note, or
 * append a new one (creating `Taste.md` first for company taste). Null when the department has no note to hold it.
 */
export function planTaste(db: IndexDB, companyId: string, input: TasteInput): TastePlan | null {
  const statement = cleanStatement(input.text)
  if (statement.length < 3) return null
  const example = tasteExample(input.example.slice(0, TASTE_LIMITS.example))
  let target: { id: string; path: string; title: string } | null
  if (input.scope === 'company') {
    target = (db.prepare(`SELECT id, path, title FROM mem_note WHERE company_id = ? AND type = 'taste' AND removed_at IS NULL AND status = 'active' ORDER BY path LIMIT 1`).get(companyId) as typeof target | undefined) ?? null
  } else {
    target = departmentNote(db, companyId, input.scope.department)
    if (!target) return null
  }
  const scopeKey = input.scope === 'company' ? 'company' : `department:${input.scope.department.id}`
  const key = `taste:${scopeKey}:${input.polarity}:${normText(statement)}:${normText(example)}`
  const noteName = target ? pathStem(target.path) : TASTE_NOTE_TITLE
  const evidence: ProposalEvidence[] = [{ path: target?.path ?? null, line: null, quote: `${input.polarity}: ${statement} (example: ${example})`, note: noteName }]
  if (target) {
    const rows = db
      .prepare(`SELECT block_id, text FROM mem_fact WHERE company_id = ? AND note_id = ? AND status = 'active' AND lower(category) = ? AND block_id IS NOT NULL ORDER BY line`)
      .all(companyId, target.id, input.polarity) as { block_id: string; text: string }[]
    const want = normText(statement)
    const hit = rows.find((r) => normText(parseTasteText(r.text).statement) === want)
    // a reinforcement is its own signal: the first sighting was a new line, this one counts it again
    if (hit) return { ops: [{ op: 'reinforce', blockId: hit.block_id, example }], note: noteName, reinforces: hit.block_id, key: `${key}:again:${hit.block_id}`, evidence }
  }
  const ops: VaultOp[] = []
  if (!target) ops.push({ op: 'createNote', title: TASTE_NOTE_TITLE, type: 'taste', folder: '', summary: 'What the people of this company like and dislike, in general.' })
  ops.push({ op: 'observe', note: noteName, category: input.polarity, text: formatTasteText({ statement, examples: [example], count: 1 }) })
  return { ops, note: noteName, reinforces: null, key, evidence }
}

/** The proposal title in the Inbox: `Taste: dislikes "Exclamation marks in subject lines"`. */
export function tasteTitle(ops: VaultOp[]): string {
  const obs = ops.find((o): o is Extract<VaultOp, { op: 'observe' }> => o.op === 'observe')
  if (obs) return `Taste: ${obs.category} "${parseTasteText(obs.text).statement}"`
  return ops.some((o) => o.op === 'reinforce') ? 'Taste seen again: reinforce it' : 'Taste'
}

/**
 * A board review turned into a taste signal: approving with a note is a `likes`, sending back is a `dislikes`. The
 * reviewer's note is the statement and the task title the example. Null for notes too short to say anything.
 */
export function reviewSignal(outcome: 'approved' | 'sent_back', note: string, taskTitle: string): { polarity: TasteCategory; text: string; example: string } | null {
  const text = note.replace(/^(approved|sent back)\s*:\s*/i, '').trim()
  if (text.split(/\s+/).filter(Boolean).length < 3) return null
  return { polarity: outcome === 'approved' ? 'likes' : 'dislikes', text, example: taskTitle }
}
