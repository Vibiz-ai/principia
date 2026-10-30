/**
 * AGENT CHAT: talking with an agent is a real, standing chat with it (one per agent per company, resumed across
 * restarts), run on the agent's own CLI and profile. This module is the agent's side of that chat's system prompt
 * (pure): who it is (persona, role, department, instructions), how it works (autonomy), and how a chat with the founder
 * differs from a board task. Principia's team context (teammates, recent work) is appended by the orchestrator. Pure.
 */

import { REPLY_STYLE } from './replyStyle'

/** Words that decide what an agent asks before doing. First match wins, role before department. */
const ASK_BEFORE: [RegExp, string][] = [
  [/support|customer|reception|front desk|office|liaison|inbox|reply|responder|patient/i, 'replying'],
  [/\bads?\b|advert|campaign|paid|media buy|finance|budget|spend|account/i, 'spending'],
  [/content|writer|copy|social|instagram|brand|marketing|blog|seo|newsletter|editor|post/i, 'posting'],
  [/develop|engineer|\bdev\b|\bcode\b|coder|\bqa\b|\btest|devops|frontend|backend|software/i, 'merging'],
  [/report|analyst|research|insight|data/i, 'sending anything out'],
  [/ops|operation|fulfil|logistic|supply|inventory|order/i, 'ordering']
]

/**
 * One phrase per agent, shared by Team, the agent page and onboarding. An agent with autonomy 'auto' "Acts on its
 * own"; every other agent "Asks before {what its role would do in the world}", or "Asks before acting".
 */
export function autonomyPhrase(o: { auto: boolean; role?: string | null; department?: string | null }): string {
  if (o.auto) return 'Acts on its own'
  for (const src of [o.role, o.department]) {
    if (!src) continue
    for (const [re, verb] of ASK_BEFORE) if (re.test(src)) return `Asks before ${verb}`
  }
  return 'Asks before acting'
}

export interface AgentChatBriefInput {
  /** the persona name ("Vitruvius"), else the role */
  name: string
  /** the seat's role label ("Lead Developer") */
  role: string
  company: string
  department: string | null
  personality?: string | null
  bio?: string | null
  /** the founder's standing instructions for this agent (≤ 4000) */
  instructions: string
  auto: boolean
  /** a code company: the agent works in a repository */
  code?: boolean
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** Data text: a `</principia-…>` inside it cannot close the block it sits in. */
const data = (s: string): string => s.replace(/<(\/?)principia-/gi, '<$1principia‐')
const attr = (s: string): string => data(s).replace(/["\n\r]/g, ' ').slice(0, 120)

/** The agent's block of its chat's system prompt (~1,500 chars plus its instructions). */
export function agentChatBrief(i: AgentChatBriefInput): string {
  const who = i.name && i.name !== i.role ? `${i.name}, the ${i.role}` : `the ${i.role}`
  const autonomy = autonomyPhrase({ auto: i.auto, role: i.role, department: i.department })
  const lines = [
    `<principia-agent name="${attr(i.name)}" role="${attr(i.role)}"${i.department ? ` department="${attr(i.department)}"` : ''} company="${attr(i.company)}">`,
    `You are ${data(who)} at ${data(i.company)}${i.department ? ` (${data(i.department)})` : ''}, one of the company's agents in Principia.`,
    ...(i.personality?.trim() ? [`Personality: ${data(clip(i.personality.trim(), 200))}`] : []),
    ...(i.bio?.trim() ? [`About you: ${data(clip(i.bio.trim(), 500))}`] : []),
    ...(i.instructions.trim() ? ['Your standing instructions from the founder:', data(clip(i.instructions.trim(), 4000))] : []),
    `How you work: ${autonomy}.`,
    '</principia-agent>',
    '',
    '<principia-agent-chat>',
    `This is your own chat with the founder. Talk as ${data(i.name || i.role)}, in plain words, and answer here.`,
    '- Questions, quick checks and small jobs: just do them here with your tools and say what you did. For deep or parallel work you may start your own helper subagents: start them in the foreground (never run_in_background) and wait for them in the same turn, several at once when they can work in parallel, so the founder gets your answer without having to nudge you.',
    '- When you do one of your own board tasks here, move it yourself with task_update: in_progress when you start, then in_review with a short note of what you did once it is done (the founder approves it; never mark it done). Then it will not be started again.',
    '- Bigger work that should be tracked, or that a teammate should do: put it on the board yourself with your Principia task tools (assigned to you or to the right teammate), then say so in one line. Never file a task for small talk, thanks or a plain go-ahead ("do it", "ok"): a go-ahead means continue what you proposed.',
    autonomy === 'Acts on its own'
      ? '- You may act on your own, but say what you did.'
      : `- ${autonomy.replace(/^Asks/, 'Ask the founder here')}, and wait for a yes.`,
    ...(i.code ? ['- Code work: keep changes on a branch and say what changed; never push to the main branch without the founder\'s yes.'] : []),
    '- No run report block is needed in this chat.',
    REPLY_STYLE,
    '</principia-agent-chat>'
  ]
  return lines.join('\n')
}
