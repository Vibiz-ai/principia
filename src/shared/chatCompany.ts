/**
 * "Start a company from this chat": a chat (an interactive claude session with the `hive` server) hears the founder
 * say they want a new project / company / business, ASKS whether to set it up as a Principia company, and only after
 * a yes calls `principia_propose_company`. Nothing is created by the call: Principia shows a confirmation card (name,
 * brief and logo editable), and confirming opens the existing onboarding "From a prompt" (Brief → Plan → Launch)
 * prefilled with it. The tool answers the chat with the outcome (opened / declined / expired) so the agent can go on.
 *
 * Shared and pure (no Node, no DOM): the tool schema, argument normalization, the brief the onboarding gets, the
 * session hints, and the generated emblem logo (white line art, no warm colours) used when no repo logo is found.
 */

export const CHAT_COMPANY_TOOL = 'principia_propose_company' as const
export type ChatCompanyTool = typeof CHAT_COMPANY_TOOL
export const isChatCompanyTool = (name: string): name is ChatCompanyTool => name === CHAT_COMPANY_TOOL

export const PROPOSAL_LIMITS = { name: 80, brief: 6000, repo: 2048, website: 2048 } as const
/** How long the tool call waits for the founder's decision (the card stays until then). */
export const PROPOSAL_WAIT_S = 600
/** One open card per chat; a second call while one is open is refused. */
export const MAX_OPEN_PER_SESSION = 1

/** The tool's JSON schema (the `hive` MCP server lists it for claude chats). */
export const CHAT_COMPANY_TOOL_DEF = {
  name: CHAT_COMPANY_TOOL,
  description:
    'Offers to set up a NEW Principia company (its own Passport, departments, agents, first tasks and logo) from what the user said in this chat. ' +
    'Only after you asked "Want me to set this up as a new Principia company?" and the user said yes. Creates nothing by itself: Principia shows the user a confirmation card, ' +
    'and on confirm opens the company onboarding prefilled with your brief, where the user reviews the plan before anything is launched. Waits for the decision and returns it.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: PROPOSAL_LIMITS.name, description: 'The company or project name, if the user gave one. Omit when unknown (Principia asks).' },
      brief: {
        type: 'string',
        minLength: 10,
        maxLength: PROPOSAL_LIMITS.brief,
        description:
          'A founder-style brief from this conversation, in plain words: what it is, what it sells or does, for whom, where, goals for the first weeks, tone. Only what the user said or agreed to; no invented facts.'
      },
      repo: { type: 'string', maxLength: PROPOSAL_LIMITS.repo, description: 'Optional: an absolute folder path on this Mac, or a git clone URL (https://, ssh://, git@), of the code for it.' },
      website: { type: 'string', maxLength: PROPOSAL_LIMITS.website, description: 'Optional: its website, if it has one.' }
    },
    required: ['brief'],
    additionalProperties: false
  }
} as const

export const CHAT_COMPANY_SERVER_INSTRUCTIONS =
  `${CHAT_COMPANY_TOOL}: when the user says they want to start a new project, company, business, startup or side project, first ASK "Want me to set this up as a new Principia company?". ` +
  'Call the tool only after they agree, with a brief of what they told you. It opens a confirmation card in Principia and returns whether they opened the onboarding or declined. Never call it twice for the same idea.'

/** Appended to an interactive claude session's system prompt (with the `hive` server attached). */
export const CHAT_COMPANY_HINT =
  'When the user says they want to start a new project, company, business, startup or side project (not a task inside the current one), ask once: ' +
  `"Want me to set this up as a new Principia company?" (Principia then plans its departments, agents, first tasks and a logo). Only after a yes, call mcp__hive__${CHAT_COMPANY_TOOL} with a brief of what they said ` +
  '(name if known, what it is, for whom, goals; a repo path or URL and website if mentioned). If they decline, carry on normally and do not ask again for the same idea.'

/** Codex panes have no `hive` tools: they suggest the button instead. */
export const CHAT_COMPANY_CODEX_HINT =
  'You are running inside Principia. When the user says they want to start a new project, company, business or side project (not a task inside the current one), ask once whether they want it set up as a new Principia company. ' +
  'If yes, write a short brief (name, what it is, for whom, first goals) and tell them to click "New company from chat" at the top of this chat (or + New company → From a prompt) and paste it; Principia then plans its departments, agents, first tasks and logo.'

// ---------- proposals ----------

export type ProposalRepo = { kind: 'local'; path: string } | { kind: 'url'; url: string }
export type ProposalStatus = 'pending' | 'accepted' | 'declined' | 'expired'
export interface CompanyProposal {
  id: string
  /** the chat that proposed it; null = opened from the "New company from chat" button */
  sessionId: string | null
  sessionTitle: string | null
  name: string
  brief: string
  repo: ProposalRepo | null
  website: string | null
  status: ProposalStatus
  createdAt: string
  /** set when decided */
  decidedAt: string | null
}
/** chatCompany:decide. `accept` with the (edited) name and brief; the logo choice stays in the renderer. */
export interface ProposalDecision {
  id: string
  accept: boolean
  name?: string
  brief?: string
}
/** What the tool returns to the chat. */
export interface ProposalToolResult {
  status: ProposalStatus | 'busy'
  name?: string
  note: string
}

const CLONE_URL = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/i
const one = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** The repo argument: an absolute path or a clone URL; `~/` paths are expanded with `home`. Anything else is dropped. */
export function parseProposalRepo(raw: unknown, home?: string): ProposalRepo | null {
  const s = one(raw, PROPOSAL_LIMITS.repo)
  if (!s) return null
  if (CLONE_URL.test(s)) return { kind: 'url', url: s }
  if (/^github\.com\/[\w.-]+\/[\w.-]+/i.test(s)) return { kind: 'url', url: `https://${s.replace(/\/+$/, '')}` }
  if (s.startsWith('~/') && home) return { kind: 'local', path: `${home.replace(/\/+$/, '')}/${s.slice(2)}`.replace(/\/+$/, '') || '/' }
  if (s.startsWith('/') && !s.split('/').includes('..')) return { kind: 'local', path: s.length > 1 ? s.replace(/\/+$/, '') : s }
  return null
}

/** A plausible website (http(s) or a bare host); else null. */
export function parseWebsite(raw: unknown): string | null {
  const s = one(raw, PROPOSAL_LIMITS.website)
  if (!s) return null
  if (/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(s)) return s
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return s
  return null
}

export type ProposalArgs = Pick<CompanyProposal, 'name' | 'brief' | 'repo' | 'website'>
/** The tool's arguments, checked (main is the authority; the server only checks shape). */
export function normalizeProposalArgs(raw: unknown, home?: string): { ok: true; value: ProposalArgs } | { ok: false; error: string } {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const brief = typeof a.brief === 'string' ? a.brief.replace(/\r\n?/g, '\n').trim().slice(0, PROPOSAL_LIMITS.brief) : ''
  if (brief.length < 10) return { ok: false, error: 'brief is required: describe the company from this chat in a few sentences' }
  return { ok: true, value: { name: one(a.name, PROPOSAL_LIMITS.name), brief, repo: parseProposalRepo(a.repo, home), website: parseWebsite(a.website) } }
}

/**
 * The text the onboarding's Brief step gets: the name on its own first line (the no-model reader takes a short first
 * line as the name), the brief, then the website. A brief that already starts with the name is not repeated.
 */
export function proposalBrief(p: Pick<CompanyProposal, 'name' | 'brief' | 'website'>): string {
  const name = p.name.trim()
  let body = p.brief.trim()
  const out: string[] = []
  if (name && !body.toLowerCase().startsWith(name.toLowerCase())) out.push(name)
  if (body) out.push(body)
  const site = p.website?.trim()
  if (site && !body.includes(site)) out.push(`Website: ${site}`)
  body = out.join('\n')
  return body.slice(0, 20_000)
}

/** The tool result for a decided (or timed out) proposal. */
export function proposalResult(p: Pick<CompanyProposal, 'status' | 'name'>): ProposalToolResult {
  const name = p.name.trim() || 'the new company'
  switch (p.status) {
    case 'accepted':
      return {
        status: 'accepted',
        name,
        note: `Opened onboarding for ${name} in Principia. The user reviews the brief, the departments, agents and first tasks there and launches it; nothing is created until they do. Tell them it is open and continue the conversation.`
      }
    case 'declined':
      return { status: 'declined', name, note: 'The user declined. Do not propose it again for this idea; carry on in the chat.' }
    case 'expired':
      return { status: 'expired', name, note: 'No decision in time; the card was closed. Do not call again unless the user asks.' }
    default:
      return { status: 'pending', name, note: 'The card is still waiting in Principia. Do not call again.' }
  }
}

// ---------- the generated emblem (white line art, VOICE.md §5.6) ----------

export const EMBLEM_VARIANTS = ['arch', 'ring', 'tablet'] as const
export type EmblemVariant = (typeof EMBLEM_VARIANTS)[number]
export const isEmblemVariant = (v: unknown): v is EmblemVariant => (EMBLEM_VARIANTS as readonly unknown[]).includes(v)

/** One or two letters for the monogram (first letters of the first two words; A-Z and digits only). */
export function monogram(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  if (!words.length) return 'P'
  if (words.length === 1) return words[0]!.slice(0, 1)
  return `${words[0]![0]}${words[1]![0]}`
}

const STROKE = '#FFFFFF'
const FONT = "Cinzel, 'Trajan Pro', Georgia, 'Times New Roman', serif"

/**
 * A square 128-unit SVG: white strokes and a white serif monogram on a transparent ground (the coin reads it as
 * `plain` line art). Deterministic for (name, variant). Only letters A-Z / digits reach the text node.
 */
export function emblemSvg(name: string, variant: EmblemVariant = 'arch'): string {
  const m = monogram(name)
  const size = m.length > 1 ? 40 : 54
  const line = (d: string, w = 3) => `<path d="${d}" fill="none" stroke="${STROKE}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
  let art: string
  let ty: number
  switch (variant) {
    case 'ring':
      art = `<circle cx="64" cy="64" r="56" fill="none" stroke="${STROKE}" stroke-width="3"/><circle cx="64" cy="64" r="47" fill="none" stroke="${STROKE}" stroke-width="1.5" stroke-dasharray="1.5 5" stroke-linecap="round"/>`
      ty = 64
      break
    case 'tablet':
      art = `<rect x="14" y="22" width="100" height="84" rx="4" fill="none" stroke="${STROKE}" stroke-width="3"/>${line('M24 32 H104 M24 96 H104', 1.5)}`
      ty = 64
      break
    default:
      // a Roman arch: two pillars and a round head, a keystone, the monogram under the arch
      art = `${line('M22 112 V58 A42 42 0 0 1 106 58 V112')}${line('M34 112 V60 A30 30 0 0 1 94 60 V112', 1.5)}${line('M14 112 H114')}${line('M60 16 L64 26 L68 16', 2)}`
      ty = 82
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">${art}` +
    `<text x="64" y="${ty}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-weight="600" font-size="${variant === 'arch' ? size - 10 : size}" letter-spacing="1" fill="${STROKE}">${m}</text></svg>`
  )
}

/** The emblem as a data: URL (previews in the card). */
export function emblemDataUrl(name: string, variant: EmblemVariant = 'arch'): string {
  // ASCII only (the monogram is A-Z / digits), so btoa is safe
  return `data:image/svg+xml;base64,${btoa(emblemSvg(name, variant))}`
}
