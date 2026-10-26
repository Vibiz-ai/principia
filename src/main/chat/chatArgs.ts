/**
 * CHAT-UI.md §3.1: the chat's argv is derived from the terminal pane's (claudeAdapter.interactive via
 * engine.providers.interactiveSpawn), so hooks, MCP, add-dirs, the system prompt, the model and the profile's extra
 * args are the same code for both and cannot drift. Pure.
 *
 * Interactive layout: [hooks…, mcp…, --add-dir…, skill…, (--session-id|--resume) <id>, [prompt], --model m,
 *                      (--permission-mode default | --dangerously-skip-permissions), --append-system-prompt t, extra…]
 */

export const STREAM_FLAGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages']

export interface ParsedInteractive {
  /** the conversation id after --session-id / --resume */
  id: string | null
  resumed: boolean
  /** index of --session-id / --resume */
  at: number
  /** the positional first message (Slack "Ask an agent", handoff), already un-escaped */
  prompt: string | null
}

export function parseInteractive(args: readonly string[]): ParsedInteractive {
  const at = args.findIndex((a) => a === '--session-id' || a === '--resume')
  if (at < 0) return { id: null, resumed: false, at: -1, prompt: null }
  const id = args[at + 1] ?? null
  const next = args[at + 2]
  // adapters.positional() prefixes a leading '-' with a space; flags always start with '-'
  const prompt = next !== undefined && !next.startsWith('-') ? (next.startsWith(' -') ? next.slice(1) : next) : null
  return { id, resumed: args[at] === '--resume', at, prompt }
}

/** The interactive argv without its positional first message. */
export function withoutPrompt(args: readonly string[]): string[] {
  const p = parseInteractive(args)
  if (p.at < 0 || p.prompt === null) return [...args]
  return [...args.slice(0, p.at + 2), ...args.slice(p.at + 3)]
}

/** `--session-id X` -> `--resume X` (the conversation exists now). */
export function asResume(args: readonly string[]): string[] {
  const out = [...args]
  const i = out.indexOf('--session-id')
  if (i >= 0) out[i] = '--resume'
  return out
}

/**
 * The chat argv: stream flags first, the positional prompt dropped (it becomes the first user message), and permission
 * prompts routed to our stdio. Bypass (--dangerously-skip-permissions) stays as it is.
 */
export function toChatArgs(interactive: readonly string[]): { args: string[]; prompt: string | null; id: string | null; resumed: boolean } {
  const p = parseInteractive(interactive)
  const base = withoutPrompt(interactive)
  const bypass = base.includes('--dangerously-skip-permissions')
  const args = [...STREAM_FLAGS, ...base]
  if (!bypass && !args.includes('--permission-prompt-tool')) {
    const i = args.indexOf('--permission-mode')
    // right after the mode's value; a profile's own mode (extraArgs) still gets the stdio prompt tool
    if (i >= 0) args.splice(i + 2, 0, '--permission-prompt-tool', 'stdio')
    else args.push('--permission-prompt-tool', 'stdio')
  }
  return { args, prompt: p.prompt, id: p.id, resumed: p.resumed }
}

/** The terminal argv for a hand-off: same flags, resuming the conversation once it exists, no first message. */
export function toTerminalArgs(interactive: readonly string[], conversationStarted: boolean): string[] {
  return conversationStarted ? asResume(withoutPrompt(interactive)) : [...interactive]
}

/** `--session-id X` <-> `--resume X`: the conversation exists (resume) or not yet (session-id). */
export function withConversation(args: readonly string[], started: boolean): string[] {
  const out = [...args]
  const i = out.findIndex((a) => a === '--session-id' || a === '--resume')
  if (i >= 0) out[i] = started ? '--resume' : '--session-id'
  return out
}

const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto'])

/**
 * What the user picked in the chat (model chip, mode chip, "Allow all edits for this chat") carried into the next
 * process: the terminal hand-off, the hand-back and a wake from sleep. Bypass sessions keep their flag.
 */
export function withChoices(args: readonly string[], c: { model?: string | null; permissionMode?: string | null }): string[] {
  const out = [...args]
  const set = (flag: string, value: string): void => {
    const i = out.indexOf(flag)
    if (i >= 0 && out[i + 1] !== undefined && !out[i + 1]!.startsWith('-')) out[i + 1] = value
    else if (i >= 0) out.splice(i + 1, 0, value)
    else {
      // before the system prompt / extra args is fine: flags are order-free for the CLI
      const at = out.findIndex((a) => a === '--session-id' || a === '--resume')
      if (at >= 0) out.splice(at + 2 + (out[at + 2] !== undefined && !out[at + 2]!.startsWith('-') ? 1 : 0), 0, flag, value)
      else out.push(flag, value)
    }
  }
  if (c.model && c.model !== 'default') set('--model', c.model)
  if (c.permissionMode && MODES.has(c.permissionMode) && !out.includes('--dangerously-skip-permissions')) set('--permission-mode', c.permissionMode)
  return out
}

/** CHAT-UI.md §3.7: the chat speaks the stream protocol verified on this CLI version and newer. */
export const CHAT_MIN_VERSION = '2.1.310'

export function versionAtLeast(v: string | null | undefined, min = CHAT_MIN_VERSION): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? '')
  if (!m) return false
  const a = [Number(m[1]), Number(m[2]), Number(m[3])]
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return true
}
