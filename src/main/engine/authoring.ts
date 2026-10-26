/**
 * Authoring, engine side (AUTHORING.md §1.1, §3, §5; PO1, PO3, PO4, PO7). Pure helpers, no Node or electron imports:
 *  - the stop-if output contract (`detectHalt`),
 *  - the authoring-only checks main runs on top of `validateWorkflow` for agent-written drafts (PO4),
 *  - the inputs a pre-allowed run may not change (PO3),
 *  - the `hive` server attach constants for interactive claude sessions (PO1, PO7),
 *  - the node/templating/contract text `hive_workflow_schema` teaches, plus the §3.4 worked example.
 * Main's AUTHORING_SCHEMA / EXAMPLES (src/shared/authoring.ts) should reuse these so the teaching text never drifts
 * from what this engine actually runs.
 */
import type { AdapterId, NotifyNode, ValidationError, WorkflowDraft, WorkflowNode } from '../../shared/types'
import { isCommandField, nodeTexts, parseRefs } from './templates'

// ---------- stop-if (AUTHORING.md §5) ----------

const HALT = /^\s*HIVE_STOP:\s*(.{1,500}?)\s*$/

/**
 * The reason when the LAST non-empty line of `output` is `HIVE_STOP: <reason>`, else null. Markdown wrappers are
 * tolerated: trailing lines of only backticks are skipped, and `*` / `` ` `` are stripped before matching
 * (`**HIVE_STOP:** reason`, `` `HIVE_STOP: reason` ``).
 */
export function detectHalt(output: string | null | undefined): string | null {
  if (!output) return null
  const lines = output.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]!.trim()
    if (!raw || /^`+$/.test(raw)) continue
    const m = HALT.exec(raw.replace(/[*`]/g, ''))
    const reason = m?.[1]?.trim()
    return reason ? reason : null
  }
  return null
}

/** Node types whose passed output may stop the run (rooms, checks and notify never do). */
export const HALT_NODE_TYPES: readonly WorkflowNode['type'][] = ['agent', 'shell', 'wait']

// ---------- authoring checks (PO3, PO4) ----------

/**
 * PO4: in an agent-authored draft, `{{node.output}}` / `{{node.transcript}}` inside a shell, wait or check command is
 * an error. Templates are raw text substitution, so model output (a PR body, a review) pasted into a command is code
 * execution of whatever its author wrote. Data passes through a file in $ARTIFACTS_DIR instead.
 */
export function authoringErrors(draft: WorkflowDraft): ValidationError[] {
  const errs: ValidationError[] = []
  for (const n of Array.isArray(draft?.nodes) ? draft.nodes : []) {
    if (!n || typeof n !== 'object') continue
    for (const { field, text } of nodeTexts(n)) {
      if (!isCommandField(n, field)) continue
      for (const r of parseRefs(text)) {
        if (r.kind !== 'node') continue
        errs.push({
          path: n.id,
          message: `Node "${n.id}": ${r.raw} in a command runs another step's output as shell code; write it to a file in $ARTIFACTS_DIR and read the file instead`
        })
      }
    }
  }
  return errs
}

/** PO3 / PO4: input names referenced in any command field (shell, wait, command check). Sorted, unique. */
export function commandInputs(draft: WorkflowDraft): string[] {
  const out = new Set<string>()
  for (const n of Array.isArray(draft?.nodes) ? draft.nodes : []) {
    if (!n || typeof n !== 'object') continue
    for (const { field, text } of nodeTexts(n)) {
      if (!isCommandField(n, field)) continue
      for (const r of parseRefs(text)) if (r.kind === 'input') out.add(r.name)
    }
  }
  return [...out].sort()
}

/**
 * PO3: a standing run permission may start the run without a card only when every input used in a command is absent or
 * equal to its saved default. Returns the offending input names ([] = allowed).
 */
export function inputsNeedingApproval(draft: WorkflowDraft, inputs: Record<string, string> | null | undefined): string[] {
  const given = inputs ?? {}
  const defaults = new Map((draft?.inputs ?? []).map((i) => [i.name, i.default ?? '']))
  return commandInputs(draft).filter((name) => name in given && given[name] !== defaults.get(name))
}

// ---------- the `hive` server attach (AUTHORING.md §1.1, PO1, PO7) ----------

export const AUTHOR_SERVER_NAME = 'hive'

/** Every tool of the `hive` server (PO2: no hive_schedule_create). Main's broker whitelists the same names. */
export const AUTHOR_TOOLS = [
  'hive_workflow_schema',
  'hive_repos_list',
  'hive_profiles_list',
  'hive_workflow_list',
  'hive_workflow_get',
  'hive_workflow_validate',
  'hive_workflow_create',
  'hive_workflow_update',
  'hive_workflow_run',
  'hive_draft_status',
  'hive_run_get'
] as const

/**
 * PO1 + PO7: interactive claude and codex sessions only (codex 0.163 verified: -c mcp_servers overrides). Headless steps never get the `hive` server (a hostile PR diff fed to a
 * headless reviewer must not be one prompt injection away from proposing or running workflows), and the other CLIs get
 * no renderer until a spike proves their transport.
 */
export const authorAttachable = (adapter: AdapterId, mode: 'interactive' | 'headless'): boolean =>
  (adapter === 'claude' || adapter === 'codex') && mode === 'interactive'

/** codex panes: AUTHOR_HINT in its own tool naming (`hive` server tools, no mcp__ prefix), inside developer_instructions. */
export const CODEX_AUTHOR_HINT =
  "You are running inside Principia. When the user asks for a workflow, automation, routine or schedule, build it with the hive server's tools (hive_workflow_schema, then hive_workflow_create) instead of describing steps for them to click; they approve the card in Principia."


/** Appended to the interactive claude system prompt (new conversations only) when `hive` is attached. */
export const AUTHOR_HINT =
  'You are running inside Hive. When the user asks for a workflow, automation, routine or schedule, build it with the mcp__hive__* tools instead of describing steps for them to click.'

// ---------- what hive_workflow_schema teaches (AUTHORING.md §3.2) ----------

export const AUTHORING_NODE_DOCS = {
  common:
    "id: lowercase slug unique; label; after: [ids]; cwd: repo id | absolute path | '{{inputs.repo}}' | null (scratch); timeoutMin 1-1440; memory: off|read|read-write; isolate?: 'worktree' (runs in the run's git worktree; needs workflow.worktree)",
  agent: "profileId (id or 'claude'|'codex'|'gemini'|'cursor'), prompt. Output = the agent's final message.",
  room: "participants [{profileId, label}] >= 2, topic, rounds 1-10, final 'last'|'summary'. Agents debate in turns.",
  check:
    "target: an agent node id; reviewer = profileId (agent reviewer, criteria required, must end with 'VERDICT: PASS' or 'VERDICT: FAIL') OR command (exit 0 = PASS). after defaults to [target] and may also name nodes downstream of the target (e.g. a wait node): on FAIL the loop body (target + every node between target and check) re-runs in order with the feedback given to the target, up to maxRetries 0-5. This is how you build loops. The target must be an agent node.",
  shell: 'command run with $SHELL -lc in cwd. Output = trimmed stdout. Non-zero exit fails the run.',
  wait: "command re-run every intervalSec (5-3600) until it exits 0 (until 'exit0') or its stdout matches pattern (until 'match', JS regex, multiline) within timeoutMin; onTimeout 'fail'|'continue'. Output = last attempt's stdout.",
  notify:
    'title, message (templated), slack: {"kind":"me"} (DM to the person the user picked in Settings › Notifications; you cannot set it) | {"kind":"channel","channel":"C…"} (the bot must be in it) | null (Mac notification only). Always posts a macOS notification too. Slack problems never fail the step (it passes with a note). Output = the message sent. Cannot be isolated.'
} as const

export const AUTHORING_TEMPLATING = {
  syntax:
    '{{inputs.NAME}}, {{NODE.output}}, {{NODE.transcript}} (rooms), {{ARTIFACTS_DIR}}, {{WORKTREE_DIR}}, {{WORKTREE_BRANCH}}, and in Slack-triggered runs {{trigger.text|thread|channel|channel_id|ts|thread_ts|user|user_id|permalink}} (empty otherwise). Nothing else; no filters, no expressions. Substitution is raw text.',
  dependencies: 'Referencing {{x.output}} makes the node run after x automatically.',
  commands:
    'Never put {{NODE.output}}, {{NODE.transcript}} or {{trigger.*}} inside a shell, wait or check command (validation error): have the agent write the value to a file in $ARTIFACTS_DIR and read the file in the command. {{inputs.X}} in a command is allowed and shown to the user as "executed as shell" (but an input fed from {{trigger.*}} may not be used in a command).',
  env: 'Steps also get $ARTIFACTS_DIR, $HIVE_RUN_ID, $HIVE_REPOS, and in isolated nodes $HIVE_WORKTREE, $HIVE_WORKTREE_BRANCH.'
} as const

export const AUTHORING_CONTRACTS = {
  stop: "Any agent, shell or wait node may end the whole run early as 'nothing to do' by making the LAST non-empty line of its output exactly: HIVE_STOP: <short reason>. The run ends passed, later nodes are skipped, the user is not notified. Use it right after a scan step.",
  verdict: 'Agent reviewers (check) must end with VERDICT: PASS or VERDICT: FAIL; the text above it is the feedback.',
  artifacts: 'Files for the user go in $ARTIFACTS_DIR. Steps of one run share it, so it is also how steps pass data to commands.',
  git: "In a worktree, check PRs out detached (gh pr checkout <n> --detach) and push explicitly (git push origin HEAD:refs/heads/<branch>). Pushes to the default branch or the worktree base, and remote branch deletes, are blocked."
} as const

/** A notify node without the removed `imessage` field (SLACK.md SA3; the field leaves the type with the contract commit). */
const slackNotify = (n: Omit<NotifyNode, 'imessage'>): NotifyNode => n as NotifyNode

/**
 * §3.4 worked example (the Superlog shape), as Claude writes it: profile shorthand ('claude', 'codex') and editor
 * defaults are normalized by main before validation. `repo_example0` is a placeholder the agent replaces with a real id
 * from hive_repos_list.
 */
export const PR_ROUNDUP_EXAMPLE: WorkflowDraft = {
  name: 'PR roundup',
  description:
    'Claude and Codex review open PRs, the best candidate is fixed in a worktree until tests pass, Codex review comments are addressed, and you get a Slack DM summary.',
  inputs: [{ name: 'repo', label: 'Repository', type: 'repo', default: 'repo_example0' }],
  worktree: { repo: '{{inputs.repo}}' },
  nodes: [
    {
      id: 'scan',
      type: 'shell',
      label: 'List open PRs',
      after: [],
      cwd: '{{inputs.repo}}',
      timeoutMin: 30,
      memory: 'off',
      command:
        "prs=$(gh pr list --state open --limit 30 --json number,title,author,headRefName,reviewDecision,updatedAt,url)\nif [ \"$(printf '%s' \"$prs\" | jq length)\" = 0 ]; then echo 'HIVE_STOP: no open PRs'; exit 0; fi\nprintf '%s\\n' \"$prs\""
    },
    {
      id: 'review_claude',
      type: 'agent',
      label: 'Claude review',
      after: [],
      cwd: '{{inputs.repo}}',
      timeoutMin: 30,
      memory: 'read',
      profileId: 'claude',
      prompt:
        'Open PRs (JSON):\n{{scan.output}}\n\nFor each PR run `gh pr diff <number>` and review it. Output a markdown table: number | risk (low/med/high) | top issue | fix effort (S/M/L). Do not modify files.'
    },
    {
      id: 'review_codex',
      type: 'agent',
      label: 'Codex review',
      after: [],
      cwd: '{{inputs.repo}}',
      timeoutMin: 30,
      memory: 'read',
      profileId: 'codex',
      prompt:
        'Open PRs (JSON):\n{{scan.output}}\n\nFor each PR run `gh pr diff <number>` and review it independently. Output a markdown table: number | risk | top issue | fix effort. Do not modify files.'
    },
    {
      id: 'roundup',
      type: 'agent',
      label: 'Roundup + pick',
      after: [],
      cwd: null,
      timeoutMin: 30,
      memory: 'read',
      profileId: 'claude',
      prompt:
        'Two reviews of the same open PRs:\n\nClaude:\n{{review_claude.output}}\n\nCodex:\n{{review_codex.output}}\n\nWrite a short roundup (one line per PR). Then pick the ONE PR most worth fixing now and end with a line `PICK: <number>`. If no PR needs a fix, end with `HIVE_STOP: nothing worth fixing` instead.'
    },
    {
      id: 'fix',
      type: 'agent',
      label: 'Fix picked PR',
      after: [],
      cwd: null,
      timeoutMin: 45,
      memory: 'read-write',
      isolate: 'worktree',
      profileId: 'claude',
      prompt:
        'You are in a dedicated git worktree ($HIVE_WORKTREE). From this roundup:\n{{roundup.output}}\n\ntake the PR in the PICK line, write just its number to $ARTIFACTS_DIR/pr.txt, run `gh pr checkout <number> --detach` here, and fix the top issues the reviews found. Commit with clear messages. Do not push. End with a summary of what you changed.'
    },
    {
      id: 'tests',
      type: 'check',
      label: 'Tests pass',
      after: ['fix'],
      cwd: null,
      timeoutMin: 30,
      memory: 'off',
      isolate: 'worktree',
      target: 'fix',
      profileId: null,
      command: 'npm test --silent',
      criteria: '',
      maxRetries: 3
    },
    {
      id: 'push',
      type: 'shell',
      label: 'Push',
      after: ['tests'],
      cwd: null,
      timeoutMin: 30,
      memory: 'off',
      isolate: 'worktree',
      command:
        'n=$(cat "$ARTIFACTS_DIR/pr.txt"); b=$(gh pr view "$n" --json headRefName -q .headRefName); git push origin "HEAD:refs/heads/$b" && gh pr view "$n" --json url -q .url'
    },
    {
      id: 'wait_codex',
      type: 'wait',
      label: 'Wait for Codex review',
      after: ['push'],
      cwd: null,
      timeoutMin: 45,
      memory: 'off',
      isolate: 'worktree',
      command:
        'gh pr view "$(cat "$ARTIFACTS_DIR/pr.txt")" --json reviews,comments -q \'[.reviews[], .comments[] | select(.author.login | test("codex"; "i"))] | length\'',
      until: 'match',
      pattern: '^[1-9][0-9]*\\s*$',
      intervalSec: 60,
      onTimeout: 'continue'
    },
    {
      id: 'address',
      type: 'agent',
      label: 'Address Codex comments',
      after: ['wait_codex'],
      cwd: null,
      timeoutMin: 45,
      memory: 'read',
      isolate: 'worktree',
      profileId: 'claude',
      prompt:
        "The PR number is in $ARTIFACTS_DIR/pr.txt. Read its Codex review comments (`gh pr view <n> --comments`, `gh api repos/{owner}/{repo}/pulls/<n>/comments`). Fix the valid ones, reply briefly to the ones you disagree with, commit and push with `git push origin HEAD:refs/heads/<the PR's headRefName>`. If there were no Codex comments, say so. End with a 3-line summary."
    },
    slackNotify({
      id: 'text_me',
      type: 'notify',
      label: 'Text me',
      after: [],
      cwd: null,
      timeoutMin: 1,
      memory: 'off',
      title: 'PR roundup',
      message: '{{roundup.output}}\n\nPushed: {{push.output}}\nCodex follow-up: {{address.output}}',
      slack: { kind: 'me' }
    })
  ]
}

// ---------- Slack (SLACK.md §9.5): the `slack` topic of hive_workflow_schema ----------
// The text lives in src/shared/authoring.ts (AUTHORING_SCHEMA.slack) so hive_workflow_schema serves exactly it.
export { AUTHORING_SLACK, SLACK_TRIGGER_EXAMPLES } from '../../shared/authoring'
