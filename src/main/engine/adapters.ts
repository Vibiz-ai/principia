/**
 * Provider adapters (SPEC 7.1, A3, A6, A7, A8). Each adapter only builds argv + parses output;
 * spawning, env and persistence live in the runner.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { MemoryGrant } from '../../shared/engine'
import type { AdapterId, AgentProfile } from '../../shared/types'
import { AUTHOR_HINT } from './authoring'
import { claudeMcpAttach, codexMcpAttach, geminiMcpAttach, type McpAttachment } from './memory'
import {
  createClaudeParser,
  createCodexParser,
  createCursorParser,
  createGeminiParser,
  createTextParser,
  eventToChunk,
  type StreamParser
} from './parse'
import {
  HOOKS_VERIFIED,
  claudeHooksAttach,
  cursorHooksAttach,
  geminiHooksAttach,
  type HooksAttachOptions,
  type HooksAttachResult,
  type LiveSpawn
} from './live/attach'
import { claudeInitialize, claudeUserMessage } from './live/claudeControl'
import { uuid } from './util'

export const artifactsHint = (artifactsDir: string, keyNames: string[] = []): string =>
  `Save files you create for the user (images, video, audio, html, pdf, reports) in $ARTIFACTS_DIR (${artifactsDir}).` +
  (keyNames.length
    ? `\nAPI keys from Hive › Keys are already set as environment variables: ${keyNames.join(', ')}. Use them as $NAME in commands and scripts; never print their values or look for them anywhere else.`
    : '')

/** Appended to the headless claude system prompt when hivemem's ask_user is attached (LIVE.md §4.2). */
export const ASK_USER_HINT =
  'If you need a decision from the user, call the `ask_user` tool (mcp__hivemem__ask_user); do not guess.'

export interface HeadlessRequest {
  profile: AgentProfile | null
  prompt: string
  artifactsDir: string
  /** Vault key names present in the child env (artifactsHint names them). */
  keyNames?: string[]
  /** Resume this conversation (check retry of a resumable target). */
  resumeId: string | null
  /** Shell to use for the shell adapter. */
  shell: string
  /** Memory MCP args from `mcpAttach` (CONTRACT 11.4). Placed by the adapter; [] / absent = no memory. */
  mcpArgs?: string[]
  /** hivemem's ask_user is attached to this spawn (claude: system-prompt hint). */
  askUser?: boolean
  /** Per-spawn hook args from `hooksAttach` (cursor: --plugin-dir). */
  hookArgs?: string[]
  /** Blocking hook gates are injected (verified adapters, permissionMode 'default'): run the CLI unattended. */
  gated?: boolean
  /**
   * SLACK.md §9.2: one more system instruction (the untrusted-Slack-text sentence). claude appends it to
   * --append-system-prompt (new conversations only); the executor prefixes the prompt for the other CLIs.
   */
  systemNote?: string
  /**
   * SLACK.md SA2: the step works on untrusted Slack text. claude runs with `--permission-mode dontAsk` (anything that
   * would prompt is denied, never routed to a person and never bypassed), without the tools that run code, write
   * files or reach the web, and with only Hive's own MCP servers; the profile's permission flags are dropped.
   */
  restricted?: boolean
  /**
   * SLACK.md §9.6: local image files from the triggering Slack thread (run artifacts). claude: `--add-dir` of their
   * folder so even a restricted step can Read them; codex: one `-i <file>` each. The prompt lists the paths.
   */
  images?: string[]
}
export interface HeadlessInvocation {
  args: string[]
  /** The conversation id this step belongs to (claude: --session-id / --resume uuid). */
  agentSessionId: string | null
  /**
   * Full-duplex stdin (LIVE.md §3.1): lines written right after spawn; stdin then stays open for control responses
   * until the executor closes it. Absent = stdin is /dev/null (A8).
   */
  stdin?: { protocol: 'claude-control'; lines: string[] }
}
export interface InteractiveRequest {
  profile: AgentProfile
  artifactsDir: string
  /** Vault key names present in the child env (artifactsHint names them). */
  keyNames?: string[]
  resumeId: string | null
  /** New conversation id to use when not resuming (default: a fresh uuid). */
  sessionId?: string | null
  /** Skip permission prompts in the interactive pane. Independent of profile.permissionMode (which governs headless steps). */
  bypass?: boolean
  /** Memory MCP args from `mcpAttach`. claude puts them first. */
  mcpArgs?: string[]
  /** Scoped memory + company Passport context. Does not initiate a user turn. */
  memoryBrief?: string
  /** Per-spawn hook args from `hooksAttach` (claude: --settings <file>; cursor: --plugin-dir). */
  hookArgs?: string[]
  /** The `hive` authoring server is attached (claude: AUTHOR_HINT appended to --append-system-prompt, new conversations only). */
  authorHint?: boolean
  /** SLACK.md §12.3: first user message (claude: positional prompt, the session starts working on it). */
  initialPrompt?: string
  /** DEPARTMENTS.md §9: more folders the pane may read and edit (claude and codex `--add-dir`). Absolute paths only. */
  addDirs?: string[]
}

export interface Adapter {
  id: AdapterId
  label: string
  /** Executable name looked up on the login PATH (shell: absolute $SHELL). */
  bin: string
  installHint: string
  versionArgs: string[]
  /** Env vars stripped from the child unless profile.useApiKeyAuth (SPEC A6). */
  authEnv: string[]
  /** true = check retries resume the conversation with only the feedback. */
  canResume: boolean
  headless(req: HeadlessRequest): HeadlessInvocation
  interactive(req: InteractiveRequest): HeadlessInvocation
  /** `cwd` lets gemini learn project agent names (.gemini/agents/*.md). */
  createParser(opts?: { cwd?: string }): StreamParser
  /**
   * Memory (MEMORY.md 7): how this CLI reaches the hivemem MCP server for one grant, without touching user
   * config. Absent = no MCP renderer. Only used when MCP_VERIFIED[id] (otherwise the brief-only transport).
   */
  mcpAttach?(grant: MemoryGrant, opts?: { askUser?: boolean }): McpAttachment
  /**
   * Live hooks (LIVE.md §3.5): per-spawn files in the live dir + args/env. Absent = no hooks (codex, shell).
   * gemini's result also carries hivemem (`opts.mcp`), superseding mcpAttach's separate settings file.
   */
  hooksAttach?(live: LiveSpawn, opts: HooksAttachOptions): HooksAttachResult
}

/** Blocking gates are used only on verified adapters, for profiles that want prompts (LIVE.md §3.3, §3.4). */
export const usesGate = (id: AdapterId, p: AgentProfile | null): boolean =>
  HOOKS_VERIFIED[id] && (id === 'gemini' || id === 'cursor') && (p?.permissionMode ?? 'bypass') === 'default'

/**
 * Headless gemini/cursor step whose profile wants prompts but whose permission hooks are not verified yet: its
 * approvals never reach Hive (honest degradation, LIVE.md D5). The step says so instead of leaving the user waiting.
 */
export const unroutedAsksNotice = (id: AdapterId, p: AgentProfile | null): string | null =>
  (id === 'gemini' || id === 'cursor') && (p?.permissionMode ?? 'bypass') === 'default' && !HOOKS_VERIFIED[id]
    ? `Permission prompts from ${id === 'gemini' ? 'Gemini' : 'Cursor'} steps aren't routed to Hive yet, so they never show up as Needs you. Use bypass in the profile or run it interactively.`
    : null

/** SA2: built-in tools a restricted (Slack-driven) claude step never gets. Deny rules beat any user allow rule. */
export const RESTRICTED_DENIED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'PowerShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent'
] as const
/** Profile extraArgs that would widen a restricted step's permissions; dropped (with their values). */
const PERMISSION_FLAGS: Record<string, 'none' | 'one' | 'many'> = {
  '--dangerously-skip-permissions': 'none',
  '--allow-dangerously-skip-permissions': 'none',
  '--restricted': 'none',
  '--strict-mcp-config': 'none',
  '--permission-mode': 'one',
  '--permission-prompt-tool': 'one',
  '--permission-prompts': 'one',
  '--settings': 'one',
  '--setting-sources': 'one',
  '--allowedTools': 'many',
  '--allowed-tools': 'many',
  '--disallowedTools': 'many',
  '--disallowed-tools': 'many',
  '--tools': 'many',
  '--add-dir': 'many',
  '--mcp-config': 'many',
  '--plugin-dir': 'many'
}
/** extraArgs minus every permission-widening flag (and its values; `--flag=value` too). Pure. */
export function stripPermissionArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), true] : [a, false]
    const kind = PERMISSION_FLAGS[flag]
    if (!kind) {
      out.push(a)
      continue
    }
    if (inline || kind === 'none') continue
    if (kind === 'one') {
      i++
      continue
    }
    while (i + 1 < args.length && !args[i + 1]!.startsWith('-')) i++
  }
  return out
}
/** SA2 flags for a restricted claude step: placed before --session-id/--resume (variadic --disallowedTools). */
const restrictedClaudeArgs = (): string[] => ['--permission-mode', 'dontAsk', '--strict-mcp-config', '--disallowedTools', RESTRICTED_DENIED_TOOLS.join(',')]

/** Headless steps cannot answer prompts, so they follow the profile (default bypass). */
const bypass = (p: AgentProfile | null): boolean => (p?.permissionMode ?? 'bypass') === 'bypass'
/** Interactive panes can ask: bypass only when the user turned it on (Settings › Agents). */
const ibypass = (req: InteractiveRequest): boolean => req.bypass === true
/**
 * claude interactive, bypass off: start in the normal asking mode for this spawn only (a flag, never a global config
 * edit), so a user-level `defaultMode` (e.g. auto/acceptEdits) does not silently skip the prompts Hive surfaces as
 * Needs you. A profile's own extraArgs choosing a mode wins.
 */
const claudeInteractiveMode = (req: InteractiveRequest): string[] => {
  if (ibypass(req)) return ['--dangerously-skip-permissions']
  const ex = extra(req.profile)
  return ex.includes('--permission-mode') || ex.includes('--dangerously-skip-permissions') ? [] : ['--permission-mode', 'default']
}
const model = (p: AgentProfile | null, flag: string): string[] => (p?.model ? [flag, p.model] : [])
const extra = (p: AgentProfile | null): string[] => p?.extraArgs ?? []
/** claude `--add-dir <dir>…` for the folders holding the Slack thread images (absolute paths only). */
const imageDirArgs = (images: string[] | undefined): string[] => {
  const dirs = [...new Set((images ?? []).filter((f) => isAbsolute(f)).map((f) => dirname(f)))]
  return dirs.length ? ['--add-dir', ...dirs] : []
}

/** `--add-dir` for a chat's extra folders: claude takes them variadic ('many'), codex one per flag ('each'). Absolute, de-duplicated. */
export const addDirArgs = (dirs: string[] | undefined, form: 'many' | 'each'): string[] => {
  const list = [...new Set((dirs ?? []).filter((d) => isAbsolute(d) && !d.startsWith('-')))]
  if (!list.length) return []
  return form === 'many' ? ['--add-dir', ...list] : list.flatMap((d) => ['--add-dir', d])
}

/** Positional prompt that starts with '-' would be read as a flag. */
const positional = (s: string): string => (s.startsWith('-') ? ` ${s}` : s)
/**
 * claude `--append-system-prompt` only when starting a conversation. A `--resume` turn continues a conversation that
 * already worked under these hints (ARTIFACTS_DIR is still in its env, ask_user and memory tools still describe
 * themselves, the memory brief is never repeated on resume), so re-sending them only re-bills the tokens on every
 * resume and check retry (docs/research/LANDSCAPE.md quick win).
 */
const resumeSafeAppend = (resumeId: string | null, text: string): string[] => (resumeId ? [] : ['--append-system-prompt', text])
/**
 * PROACTIVE.md §4: an interactive pane passes its system text on resume too. claude (2.1.310) snapshots the system
 * prompt on a conversation's first request and reuses it on resume, so a resumed pane keeps its own; the text passed
 * now only takes effect where no snapshot is used (after a compaction, or --system-prompt-snapshot off), which is
 * exactly where skipping it lost the Passport, the chat brief and the Principia rules. A resume costs one spawn, not
 * one per turn. The SessionStart hook (live/attach.ts) re-adds the rules as context on resume and compaction.
 */
const paneAppend = (text: string): string[] => (text.trim() ? ['--append-system-prompt', text] : [])
const withHint = (req: HeadlessRequest): string => `${artifactsHint(req.artifactsDir, req.keyNames)}\n\n${req.prompt}`

export const claudeAdapter: Adapter = {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',
  installHint: 'npm i -g @anthropic-ai/claude-code',
  versionArgs: ['--version'],
  authEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  canResume: true,
  /**
   * LIVE.md §3.1 / CONTRACT §12.4: the prompt goes on stdin as a stream-json user message after `initialize`; stdin
   * stays open for `control_request can_use_tool` answers (permission prompts routed to Hive).
   */
  headless(req) {
    const id = req.resumeId ?? uuid()
    return {
      agentSessionId: id,
      args: [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        // variadic --mcp-config/--allowedTools: always followed by --resume/--session-id, never the prompt
        ...(req.mcpArgs ?? []),
        ...(req.restricted ? restrictedClaudeArgs() : []),
        // variadic --add-dir too: the thread images' folder (§9.6), still before --resume/--session-id
        ...imageDirArgs(req.images),
        ...(req.resumeId ? ['--resume', id] : ['--session-id', id]),
        ...model(req.profile, '--model'),
        ...(req.restricted
          ? []
          : bypass(req.profile)
            ? ['--dangerously-skip-permissions']
            : ['--permission-mode', 'default', '--permission-prompt-tool', 'stdio']),
        ...resumeSafeAppend(
          req.resumeId,
          [req.askUser ? `${artifactsHint(req.artifactsDir, req.keyNames)}\n${ASK_USER_HINT}` : artifactsHint(req.artifactsDir, req.keyNames), req.systemNote?.trim() ?? '']
            .filter(Boolean)
            .join('\n\n')
        ),
        ...(req.restricted ? stripPermissionArgs(extra(req.profile)) : extra(req.profile))
      ],
      stdin: { protocol: 'claude-control', lines: [claudeInitialize(), claudeUserMessage(req.prompt)] }
    }
  },
  interactive(req) {
    const id = req.resumeId ?? req.sessionId ?? uuid()
    return {
      agentSessionId: id,
      args: [
        ...(req.hookArgs ?? []),
        ...(req.mcpArgs ?? []),
        // variadic, like --mcp-config: always followed by --resume / --session-id
        ...addDirArgs(req.addDirs, 'many'),
        ...(req.resumeId ? ['--resume', id] : ['--session-id', id]),
        // the positional first message sits right after a single-value flag, never after a variadic one
        ...(req.initialPrompt?.trim() ? [positional(req.initialPrompt)] : []),
        ...model(req.profile, '--model'),
        ...claudeInteractiveMode(req),
        ...paneAppend([artifactsHint(req.artifactsDir, req.keyNames), req.authorHint ? AUTHOR_HINT : '', req.memoryBrief?.trim() ?? ''].filter(Boolean).join('\n\n')),
        ...extra(req.profile)
      ]
    }
  },
  createParser: () => createClaudeParser(),
  mcpAttach: claudeMcpAttach,
  hooksAttach: claudeHooksAttach
}

export const codexAdapter: Adapter = {
  id: 'codex',
  label: 'Codex',
  bin: 'codex',
  installHint: 'npm i -g @openai/codex',
  versionArgs: ['--version'],
  authEnv: ['OPENAI_API_KEY'],
  canResume: false,
  headless(req) {
    return {
      agentSessionId: null,
      args: [
        'exec',
        // -i is variadic: each image sits before --json, never right before the positional prompt
        ...(req.images ?? []).flatMap((f) => ['-i', f]),
        '--json',
        '--skip-git-repo-check',
        ...(req.mcpArgs ?? []),
        ...(bypass(req.profile) ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
        ...model(req.profile, '-m'),
        ...extra(req.profile),
        positional(withHint(req))
      ]
    }
  },
  interactive(req) {
    return {
      agentSessionId: null,
      args: [
        // Keep Codex output in xterm's normal buffer so Hive retains scrollback.
        '--no-alt-screen',
        // Per-process context only: never modify the user's global Codex configuration.
        // A profile's explicit extraArgs overrides remain authoritative below.
        // codex never resumes a pane (canResume false): every spawn is a new conversation that needs its instructions
        ...(req.memoryBrief?.trim() ? ['-c', `developer_instructions=${JSON.stringify(req.memoryBrief)}`] : []),
        ...(req.mcpArgs ?? []),
        ...(ibypass(req) ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
        ...addDirArgs(req.addDirs, 'each'),
        ...model(req.profile, '-m'),
        ...extra(req.profile),
        ...(req.initialPrompt?.trim() ? [positional(req.initialPrompt)] : [])
      ]
    }
  },
  createParser: createCodexParser,
  mcpAttach: codexMcpAttach
}

export const cursorAdapter: Adapter = {
  id: 'cursor',
  label: 'Cursor Agent',
  bin: 'cursor-agent',
  installHint: 'curl https://cursor.com/install -fsS | bash',
  versionArgs: ['--version'],
  authEnv: [],
  canResume: false,
  /** LIVE.md §3.4. `--force` only for bypass profiles, or with a verified blocking gate (never unverified). */
  headless(req) {
    return {
      agentSessionId: null,
      args: [
        '-p',
        '--output-format',
        'stream-json',
        ...(bypass(req.profile) || req.gated ? ['--force'] : []),
        ...model(req.profile, '--model'),
        ...(req.hookArgs ?? []),
        ...extra(req.profile),
        positional(withHint(req))
      ]
    }
  },
  interactive(req) {
    return {
      agentSessionId: null,
      args: [...(req.hookArgs ?? []), ...(ibypass(req) ? ['--force'] : []), ...model(req.profile, '--model'), ...extra(req.profile)]
    }
  },
  createParser: () => createCursorParser(),
  hooksAttach: cursorHooksAttach
}

export const geminiAdapter: Adapter = {
  id: 'gemini',
  label: 'Gemini CLI',
  bin: 'gemini',
  installHint: 'npm i -g @google/gemini-cli',
  versionArgs: ['--version'],
  authEnv: [],
  canResume: false,
  /** LIVE.md §3.3. Hooks + hivemem come through env GEMINI_CLI_SYSTEM_SETTINGS_PATH (hooksAttach). */
  headless(req) {
    return {
      agentSessionId: null,
      args: [
        '-o',
        'stream-json',
        ...(bypass(req.profile) ? ['--yolo'] : req.gated ? ['--approval-mode', 'yolo'] : ['--approval-mode', 'default']),
        ...model(req.profile, '-m'),
        ...extra(req.profile),
        '-p',
        positional(withHint(req))
      ]
    }
  },
  interactive(req) {
    return {
      agentSessionId: null,
      args: [...(ibypass(req) ? ['--yolo'] : []), ...model(req.profile, '-m'), ...extra(req.profile)]
    }
  },
  createParser: (opts) => createGeminiParser({ agentNames: geminiAgentNames(opts?.cwd) }),
  mcpAttach: geminiMcpAttach,
  hooksAttach: (live, opts) => geminiHooksAttach(live, opts)
}

/** Custom gemini subagent names from `.gemini/agents/*.md` in cwd and ~ (read-only listing). */
export function geminiAgentNames(cwd?: string): string[] {
  const out: string[] = []
  for (const base of [cwd, homedir()]) {
    if (!base) continue
    const dir = join(base, '.gemini', 'agents')
    try {
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) if (f.endsWith('.md')) out.push(f.slice(0, -3))
    } catch {
      /* unreadable: built-ins only */
    }
  }
  return out
}

/** `$SHELL -lc <command>`; the prompt IS the command. Deterministic steps (npm test). */
export const shellAdapter: Adapter = {
  id: 'shell',
  label: 'Shell',
  bin: '$SHELL',
  installHint: 'Set $SHELL (e.g. /bin/zsh)',
  versionArgs: ['--version'],
  authEnv: [],
  canResume: false,
  headless(req) {
    return { agentSessionId: null, args: [...extra(req.profile), '-lc', req.prompt] }
  },
  interactive(req) {
    return { agentSessionId: null, args: ['-l', ...extra(req.profile)] }
  },
  createParser: createTextParser
}

export const DEFAULT_ADAPTERS: Record<AdapterId, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  gemini: geminiAdapter,
  shell: shellAdapter
}

/**
 * Human-readable transcript of a step log: replays the raw stdout lines through the adapter's
 * parser and renders the same normalized chunks the live view streams. The runner's
 * `$ cmd` / `# cwd:` header is dropped.
 */
export function readableLog(adapterId: AdapterId, raw: string): string {
  const adapter = DEFAULT_ADAPTERS[adapterId] ?? shellAdapter
  const parser = adapter.createParser()
  const lines = raw.split('\n')
  let i = 0
  if (lines[0]?.startsWith('$ ')) i++
  if (lines[i]?.startsWith('# cwd: ')) i++
  if (i > 0 && lines[i] === '') i++
  let out = ''
  for (; i < lines.length; i++) {
    for (const ev of parser.line(lines[i]!)) {
      const c = eventToChunk(ev)
      if (c) out += c
    }
  }
  return out
}
