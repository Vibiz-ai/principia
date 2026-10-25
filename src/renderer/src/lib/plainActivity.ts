/**
 * Five doors §2.6: LIVE's second line is a sentence, never a raw tool line. The live tracker records what the agent
 * last did as "<Tool> <argument>" (e.g. `Bash cd "/private/tmp/…" && npm test`), which is right for the technical
 * view and wrong for the sidebar. This turns a tool line into words and keeps anything else as it is, on one line.
 */
const base = (p: string): string => {
  const clean = p.trim().replace(/^["']|["']$/g, '')
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? clean
}
const firstArg = (rest: string): string => rest.trim().split(/\s+/)[0] ?? ''

const TOOLS: Record<string, (rest: string) => string> = {
  Bash: () => 'Running a command',
  BashOutput: () => 'Checking a command',
  KillShell: () => 'Stopping a command',
  Read: (r) => (r.trim() ? `Reading ${base(firstArg(r))}` : 'Reading a file'),
  NotebookRead: (r) => (r.trim() ? `Reading ${base(firstArg(r))}` : 'Reading a notebook'),
  Edit: (r) => (r.trim() ? `Editing ${base(firstArg(r))}` : 'Editing a file'),
  MultiEdit: (r) => (r.trim() ? `Editing ${base(firstArg(r))}` : 'Editing a file'),
  NotebookEdit: (r) => (r.trim() ? `Editing ${base(firstArg(r))}` : 'Editing a notebook'),
  Write: (r) => (r.trim() ? `Writing ${base(firstArg(r))}` : 'Writing a file'),
  Grep: () => 'Searching the files',
  Glob: () => 'Looking through the files',
  LS: () => 'Looking through the files',
  WebSearch: () => 'Searching the web',
  WebFetch: () => 'Reading a web page',
  Task: () => 'Working with a helper',
  Agent: () => 'Working with a helper',
  TodoWrite: () => 'Planning the next steps'
}

/** pm-review C7: a company with no code never reads "command" or "file" (Maya's agents are working, not running bash). */
const PLAIN: Record<string, string> = {
  Bash: 'Working on it',
  BashOutput: 'Working on it',
  KillShell: 'Working on it',
  Grep: 'Looking through its notes',
  Glob: 'Looking through its notes',
  LS: 'Looking through its notes'
}

export function plainActivity(line: string | null | undefined, opts: { code?: boolean } = {}): string | null {
  if (!line) return null
  const one = line.replace(/\s+/g, ' ').trim()
  if (!one) return null
  const m = /^([A-Z][A-Za-z]+)(?:\s+(.*))?$/.exec(one)
  if (m && opts.code === false && PLAIN[m[1]!]) return PLAIN[m[1]!]!
  const fn = m ? TOOLS[m[1]] : undefined
  if (fn) return fn(m![2] ?? '')
  // an MCP tool: mcp__server__tool → "Using server"
  const mcp = /^mcp__([^_\s]+(?:_[^_\s]+)*)__\S+/.exec(one)
  if (mcp) return `Using ${mcp[1].replace(/[_-]+/g, ' ')}`
  return one
}
