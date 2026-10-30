/**
 * ORCHESTRATOR.md §1.2: the run report contract v1. An agent on any harness delivers it in one of two ways:
 *
 * 1. a trailing fenced `principia-run-report` JSON block (only whitespace may follow its closing fence);
 * 2. a JSON file at $PRINCIPIA_RUN_REPORT (the executor sets it per step), for agents that write files more reliably
 *    than they format their last message.
 *
 * Parsing is lenient about shape (missing lists are empty, extra keys are ignored, long text is clipped) and strict
 * about place: a block that is not at the end of the output is no report. The report is data: nothing in it is ever
 * run as an instruction, and Principia decides what each field may cause (apply.ts).
 */
import fs from 'node:fs'
import { z } from 'zod'
import { RUN_REPORT_FENCE, RUN_REPORT_LIMITS as L, type RunReport } from '../../shared/orchestrator'

/** Output tail the parser looks at (the block is at the end; a huge transcript is never scanned whole). */
const TAIL = 64 * 1024
/** A report file larger than this is ignored. */
export const REPORT_FILE_MAX = 64 * 1024

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const text = (max: number) => z.string().transform((s) => clip(s.trim(), max))
const list = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((xs) => xs.flatMap((x) => {
      const r = item.safeParse(x)
      return r.success ? [r.data as z.infer<T>] : []
    }).slice(0, max))

const reportSchema = z.object({
  v: z.literal(1).optional(),
  outcome: z.enum(['review', 'blocked', 'answered', 'progress']),
  summary: text(L.summary).refine((s) => s.length > 0, 'summary is empty'),
  evidence: list(text(L.evidenceItem), L.evidence),
  followUps: list(
    z.object({
      title: text(L.title).refine((s) => s.length > 0),
      goal: text(L.goal).default(''),
      departmentKey: z.string().trim().min(1).max(80).optional().catch(undefined),
      agentHandle: z.string().trim().min(1).max(80).optional().catch(undefined),
      blocksCurrent: z.boolean().optional().catch(undefined)
    }),
    L.followUps
  ),
  handoff: z
    .object({
      departmentKey: z.string().trim().min(1).max(80).optional().catch(undefined),
      agentHandle: z.string().trim().min(1).max(80).optional().catch(undefined),
      why: text(L.why).refine((s) => s.length > 0)
    })
    .refine((h) => !!h.departmentKey || !!h.agentHandle)
    .optional()
    .catch(undefined),
  questions: list(
    z.object({
      to: z.string().trim().min(1).max(80),
      question: text(L.question).refine((s) => s.length > 0),
      why: text(L.why).default(''),
      blocking: z.boolean().default(false).catch(false)
    }),
    L.questions
  ),
  facts: list(z.object({ text: text(L.fact).refine((s) => s.length > 0), topic: text(L.topic).optional().catch(undefined) }), L.facts),
  blockers: list(
    z.object({
      text: text(L.blocker).refine((s) => s.length > 0),
      needs: z.enum(['decision', 'access', 'money', 'connection']).catch('decision'),
      connectionId: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/).optional().catch(undefined)
    }),
    L.blockers
  ),
  suggestions: list(
    z.object({
      kind: z.enum(['routine', 'connection', 'task']),
      text: text(L.suggestion).refine((s) => s.length > 0),
      cron: z.string().trim().max(100).optional().catch(undefined),
      connectionId: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/).optional().catch(undefined)
    }),
    L.suggestions
  ),
  answers: list(z.object({ ref: z.string().trim().regex(/^m[0-9a-z]{1,12}$/i), text: text(L.answer).refine((s) => s.length > 0) }), L.answers),
  recurring: z
    .object({
      playbook: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9-]{0,40}$/).optional().catch(undefined),
      why: text(L.recurringWhy).refine((s) => s.length > 0)
    })
    .optional()
    .catch(undefined)
})

/** A parsed object as a RunReport, or null (wrong shape). */
export function toRunReport(json: unknown): RunReport | null {
  const r = reportSchema.safeParse(json)
  if (!r.success) return null
  const d = r.data
  return {
    v: 1,
    outcome: d.outcome,
    summary: d.summary,
    evidence: d.evidence.filter(Boolean),
    followUps: d.followUps.map((f) => ({ title: f.title, goal: f.goal, ...(f.departmentKey ? { departmentKey: f.departmentKey.toLowerCase() } : {}), ...(f.agentHandle ? { agentHandle: f.agentHandle } : {}), ...(f.blocksCurrent ? { blocksCurrent: true } : {}) })),
    ...(d.handoff ? { handoff: { ...(d.handoff.departmentKey ? { departmentKey: d.handoff.departmentKey.toLowerCase() } : {}), ...(d.handoff.agentHandle ? { agentHandle: d.handoff.agentHandle } : {}), why: d.handoff.why } } : {}),
    questions: d.questions,
    facts: d.facts.map((f) => ({ text: f.text, ...(f.topic ? { topic: f.topic } : {}) })),
    blockers: d.blockers.map((b) => ({ text: b.text, needs: b.needs, ...(b.connectionId ? { connectionId: b.connectionId } : {}) })),
    suggestions: d.suggestions.map((s) => ({ kind: s.kind, text: s.text, ...(s.cron ? { cron: s.cron } : {}), ...(s.connectionId ? { connectionId: s.connectionId } : {}) })),
    answers: d.answers.map((a) => ({ ref: a.ref.toLowerCase(), text: a.text })),
    ...(d.recurring ? { recurring: { ...(d.recurring.playbook ? { playbook: d.recurring.playbook } : {}), why: d.recurring.why } } : {})
  }
}

/**
 * The body of the trailing fenced block of `output` whose info string is one of `names`, or null. The last opening
 * fence wins; its body runs to a closing fence (same character, at least as long) that only whitespace follows.
 * Shared by the task report (reportHarvest.ts) and the run report.
 */
export function trailingFence(output: string | null | undefined, names: readonly string[]): { name: string; body: string } | null {
  if (!output) return null
  const tail = output.length > TAIL ? output.slice(-TAIL) : output
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')
  const open = [...tail.matchAll(new RegExp(`(^|\\n)[ \\t]*(\`{3,}|~{3,})[ \\t]*(${alt})[ \\t]*\\r?\\n`, 'g'))].pop()
  if (!open) return null
  const fence = open[2]
  const body = tail.slice(open.index! + open[0].length)
  const close = new RegExp(`\\r?\\n[ \\t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*\\s*$`).exec(body)
  if (!close) return null
  return { name: open[3], body: body.slice(0, close.index) }
}

/** The trailing `principia-run-report` block of an agent's output, or null (missing, not at the end, not JSON, wrong shape). */
export function parseRunReport(output: string | null | undefined): RunReport | null {
  const f = trailingFence(output, [RUN_REPORT_FENCE])
  if (!f) return null
  try {
    return toRunReport(JSON.parse(f.body))
  } catch {
    return null
  }
}

/** The report file of one step ($PRINCIPIA_RUN_REPORT), or null (absent, too big, not JSON, wrong shape). */
export function readRunReportFile(file: string): RunReport | null {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > REPORT_FILE_MAX) return null
    const raw = fs.readFileSync(file, 'utf8').trim()
    // a file holding the fenced block instead of bare JSON is accepted too
    const json = raw.startsWith('{') ? raw : (trailingFence(raw, [RUN_REPORT_FENCE])?.body ?? '')
    return json ? toRunReport(JSON.parse(json)) : null
  } catch {
    return null
  }
}

/** The board's view of a run report (task.report): review or blocked, with its summary and evidence. */
export function boardOutcome(r: RunReport): { outcome: 'review' | 'blocked'; summary: string; evidence: string[] } {
  return { outcome: r.outcome === 'blocked' ? 'blocked' : 'review', summary: r.summary, evidence: r.evidence }
}

/**
 * The footer every non-shell company step ends its prompt with (ORCHESTRATOR.md §1.2). Plain about what Principia does
 * with each field, so the agent only reports and Principia acts. `resumed`: the conversation already holds the full
 * contract, a one-line reminder is enough.
 */
export function reportFooter(opts: { resumed: boolean; reportPath: string | null }): string {
  if (opts.resumed) return `Principia: end this turn with your ${RUN_REPORT_FENCE} block again (same shape as before).`
  const file = opts.reportPath ? ` If you prefer, write the same JSON to the file named in $PRINCIPIA_RUN_REPORT instead.` : ''
  return [
    '<principia-report-contract>',
    `End your final message with a fenced ${RUN_REPORT_FENCE} block holding one JSON object. Principia reads it after your run and acts on it for you: it posts your update to the team, files follow-up tasks, hands the task on, asks teammates your questions, sends facts to the founder for review and puts blockers in front of the founder. You do not need tools for any of that.${file}`,
    '```' + RUN_REPORT_FENCE,
    '{"v":1,"outcome":"review|blocked|answered|progress","summary":"what you did, in plain words","evidence":["file, link or check"],',
    ' "followUps":[{"title":"…","goal":"…","agentHandle":"optional @teammate who should do it","departmentKey":"optional","blocksCurrent":false}],',
    ' "handoff":{"departmentKey":"or agentHandle","why":"…"},',
    ' "questions":[{"to":"@handle from Your teammates, @department or founder","question":"…","why":"…","blocking":false}],',
    ' "answers":[{"ref":"m1c","text":"your answer to a teammate\'s question in your inbox"}],',
    ' "facts":[{"text":"a durable fact worth remembering","topic":"optional note name"}],',
    ' "blockers":[{"text":"…","needs":"decision|access|money|connection","connectionId":"optional"}],',
    ' "suggestions":[{"kind":"routine|connection|task","text":"…"}],',
    ' "recurring":{"playbook":"ads-watch|social-rhythm|site-watch|release-digest|support-triage|revenue-brief|outreach-followups","why":"…"}}',
    '```',
    'Use "recurring" whenever the work you did should keep running on its own (ads you launched or drafted, posts you published, a site you deployed, a support inbox you answered). Then end your summary with one plain line telling the founder what you would keep doing on autopilot, for example: "Once these ads run, I can keep them on autopilot: check them every day and refresh the creatives based on what performs." Principia offers the founder to turn it on, with levels and limits. Nothing is turned on without their yes.',
    'Write "summary" for the founder, who did not watch you work and reads only its first line in the chat: start with one sentence in everyday words saying what changed or what you found, and what happens next (for example "The sign-in button works again; nothing else changed." or "Nothing changed yet: I am waiting for PR-40 to merge."). No file paths, function names or tool jargon in that sentence; put those in "evidence". After it, give each point its own short paragraph with a blank line between them, and if the founder has to do or decide something, end with it on its own line starting "Next step:".',
    'A blocker that only waits for another task on the board is not the founder\'s: name that task by its id in the blocker\'s text ("Waiting on PR-40 to merge"), and Principia waits for it and wakes you once it is done, instead of putting it in Needs you.',
    'Leave out what you have nothing for. A blocking question to a teammate brings their answer back to you on your next turn, so it needs no blocker as well. Only whitespace may follow the block. If you were told to end with a principia-task-report block, use this one instead: it carries the same fields and more. If you already did something with a tool (posted, filed a task, asked someone), Principia will not do it twice.',
    '</principia-report-contract>'
  ].join('\n')
}
