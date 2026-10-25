/**
 * Worktree per run (AUTHORING.md §6, PO5, PO6; CONTRACT §14.3). Implements the engine's WorktreeBridge.
 *
 * Never touches the user's checkout: every git command either runs inside the run's own worktree
 * (<userData>/worktrees/<runId>) or is one of `rev-parse`, `symbolic-ref`, `for-each-ref`, `fetch`, `worktree add|remove|prune`,
 * `branch -D <a branch this run created>` with cwd = the repo. Never checkout/switch/reset/stash/clean/pull/rebase there.
 *
 * Push guard (PO5, PO13): the worktree itself gets a worktree-local `core.hooksPath` -> <userData>/git-hooks/<runId>
 * (`git config --worktree`, which needs `extensions.worktreeConfig=true` in the repo config: the one shared-config key
 * Hive sets; the repo's hooks, its other config and the user's main checkout are never touched), so every git process in
 * that worktree is guarded, Hive-spawned or not. Isolated nodes additionally get GIT_CONFIG_COUNT/KEY_0/VALUE_0 = the same
 * hooksPath and PATH = <that dir>/bin:<login PATH>. The pre-push rejects every push when the run is a dry run
 * (dry_run = true: $HIVE_DRY_RUN=1 or the dir's `dry-run` marker), remote branch deletes, tags, the default branch /
 * worktree base, branches outside the workflow's pushBranches (default hive/*) and non-fast-forward updates, then chains
 * to the repo's own hook; every other hook the repo has is chained through a shim. The bin/ shims refuse git push
 * --no-verify / --force* / +refspec / --delete (and any push in a dry run), -c core.hooksPath and gh pr merge.
 *
 * Run branches (PO14): snapshotRun records refs/heads of every repo a run may touch when it is queued; sweepRun deletes
 * branches created during the run that carry no new unpushed commit; the rest are offered (branches/deleteBranches).
 *
 * Task worktrees (WORKTREE.md): a board task Started into its own worktree owns one row whose run_id is the task id
 * (`task_…`), at <userData>/worktrees/task-<identifier> on `hive/<identifier>-<slug>`. The same hooks dir, shims and
 * worktree-local core.hooksPath guard it; run-only paths (finish, sweepRun, bootRecover) never touch a task row, and a
 * task row is removed only by removeTask (which refuses to drop uncommitted or unpushed work unless told so).
 *
 * Keep/remove (PO6) by work done in this run: commits whose committer date is after `ensure` and that are not reachable
 * from the recorded base sha. On a remote-tracking ref -> kept 'pushed'; uncommitted changes or unpushed new commits ->
 * kept 'dirty'; else removed, together with every local branch created during the run that carries no unpushed commit.
 * No Electron imports (testable in Node).
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { WorktreeBridge } from '../shared/engine'
import type { Id, Repo, Run, RunBranch, RunStatus, RunWorktree, Workflow, WorkflowDraft } from '../shared/types'
import { HiveError } from '../shared/errors'
import { newId } from '../shared/ids'
import { taskBranchName, taskWorktreeDir } from '../shared/taskWork'
import type { DB } from './db'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}
export type GitRunner = (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<GitResult>

/** Default runner: `git` from the login env PATH, 60 s per command, no prompts. */
export function gitRunner(env: () => Record<string, string>): GitRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      execFile(
        'git',
        args,
        {
          cwd: opts.cwd,
          env: { ...env(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
          timeout: opts.timeoutMs ?? 60_000,
          maxBuffer: 8 * 1024 * 1024
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        }
      )
    })
}

/** Hooks git can run during agent work; each one the repo has is chained through a shim (core.hooksPath replaces all). */
export const CHAINED_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'post-rewrite',
  'pre-auto-gc',
  'push-to-checkout',
  'reference-transaction',
  'sendemail-validate'
]

interface Row {
  id: string
  run_id: string
  repo_id: string | null
  repo_path: string
  path: string
  branch: string
  base: string
  base_ref: string | null
  base_sha: string | null
  heads_json: string
  status: string
  kept_reason: string | null
  error: string | null
  created_at: string
  removed_at: string | null
}

const toWorktree = (r: Row): RunWorktree => ({
  id: r.id,
  runId: r.run_id,
  repoId: r.repo_id,
  repoPath: r.repo_path,
  path: r.path,
  branch: r.branch,
  base: r.base,
  status: r.status as RunWorktree['status'],
  keptReason: (r.kept_reason as RunWorktree['keptReason']) ?? null,
  error: r.error,
  createdAt: r.created_at,
  removedAt: r.removed_at
})

/** Absolute paths of the repos a run may touch: the worktree repo and every node cwd (inputs resolved), or the prompt repo. */
export function runRepoPaths(
  store: { getRepo(id: Id): Repo | null; getRunDetail(id: Id): { workflow: WorkflowDraft | null } | null; getWorkflow(id: Id): Workflow | null },
  run: Pick<Run, 'id' | 'target'>
): string[] {
  const out = new Set<string>()
  const add = (v: string | null | undefined): void => {
    let p = (v ?? '').trim()
    if (p.startsWith('repo_')) p = store.getRepo(p)?.path ?? ''
    if (p.startsWith('/')) out.add(p)
  }
  const t = run.target
  if (t.kind === 'prompt') {
    add(t.repoId)
    return [...out]
  }
  const wf = store.getRunDetail(run.id)?.workflow ?? store.getWorkflow(t.workflowId)
  if (!wf) return []
  const inputs: Record<string, string> = {}
  for (const i of wf.inputs) inputs[i.name] = t.inputs?.[i.name] ?? i.default ?? ''
  const res = (v: string | null | undefined): string => (v ?? '').replace(/\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, k: string) => inputs[k] ?? '')
  add(res(wf.worktree?.repo))
  for (const n of wf.nodes) add(res(n.cwd))
  return [...out]
}

/** Toplevel + git common dir of the repo containing `p`, read from the filesystem (sync, no git process). */
export function gitDirsSync(p: string): { top: string; common: string } | null {
  let dir: string
  try {
    dir = fs.realpathSync(p)
  } catch {
    return null
  }
  for (;;) {
    const dotgit = path.join(dir, '.git')
    let st: fs.Stats | null = null
    try {
      st = fs.statSync(dotgit)
    } catch {
      /* not here */
    }
    if (st?.isDirectory()) return { top: dir, common: dotgit }
    if (st?.isFile()) {
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'))
        if (!m) return null
        const gitdir = path.resolve(dir, m[1].trim())
        let common = gitdir
        try {
          common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim())
        } catch {
          /* not a linked worktree */
        }
        return { top: dir, common }
      } catch {
        return null
      }
    }
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** Local branch names from loose refs + packed-refs (sync, so a run's snapshot is taken before any node starts). null = unreadable. */
export function listHeadsSync(common: string): string[] | null {
  const out = new Set<string>()
  try {
    if (fs.existsSync(path.join(common, 'reftable'))) return null
    const walk = (d: string, prefix: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`)
        else if (e.isFile() && !e.name.endsWith('.lock')) out.add(`${prefix}${e.name}`)
      }
    }
    const heads = path.join(common, 'refs', 'heads')
    if (fs.existsSync(heads)) walk(heads, '')
    const packed = path.join(common, 'packed-refs')
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
        const m = /^[0-9a-f]{40,64} refs\/heads\/(.+)$/.exec(line.trim())
        if (m) out.add(m[1])
      }
    }
  } catch {
    return null
  }
  return [...out].sort()
}

interface RefsRow {
  run_id: string
  repo_path: string
  heads_json: string
  created_at: string
  left_json: string | null
  swept_at: string | null
}

/** Lowercase slug for branch names: "PR roundup" -> "pr-roundup". */
export function branchSlug(name: string, max = 40): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return s || 'workflow'
}

/** POSIX single quote for generated hook scripts. */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Default branch globs an isolated node may push to (WorkflowWorktree.pushBranches overrides). */
export const DEFAULT_PUSH_BRANCHES = ['hive/*']
/** A row owned by a board task (WORKTREE.md), not a run. */
export const isTaskOwner = (ownerId: string): boolean => ownerId.startsWith('task_')
const NOT_TASK = "run_id NOT LIKE 'task\\_%' ESCAPE '\\'"
const GLOB_RE = /^[A-Za-z0-9._/*-]{1,100}$/

/**
 * The generated pre-push (PO5). `protect` = branch names never pushed to; `allow` = branch globs that may be pushed
 * (`*` matches anything, `/` included); `chain` = the repo's own hooks dir (absolute or relative to the worktree root).
 * Blocks: remote deletes, non-branch refs (tags), protected branches, branches outside `allow`, and non-fast-forward
 * (force) updates, including a remote tip this clone does not have.
 */
export function prePushScript(protect: string[], chain: string | null, allow: string[] = DEFAULT_PUSH_BRANCHES, dryRunFile: string | null = null): string {
  const globs = allow.filter((g) => GLOB_RE.test(g))
  const lines = [
    '#!/bin/sh',
    '# Hive push guard (AUTHORING.md PO5). Generated per run; never written into the repository.',
    'input=$(cat)',
    ...dryRunLines(dryRunFile, 'echo "Hive push guard: this run is a dry run (dry_run = true): every git push is blocked." >&2; exit 1'),
    `protect=${q(protect.join(' '))}`,
    `allow=${q(globs.join(' '))}`,
    'printf "%s\\n" "$input" | while read -r lref lsha rref rsha; do',
    '  [ -z "$rref" ] && continue',
    '  case "$lsha" in *[!0]*) ;; *) echo "Hive push guard: deleting the remote branch ${rref#refs/heads/} is blocked." >&2; exit 1 ;; esac',
    '  case "$rref" in refs/heads/*) ;; *) echo "Hive push guard: only branches can be pushed from a Hive worktree (not $rref)." >&2; exit 1 ;; esac',
    '  b=${rref#refs/heads/}',
    '  for p in $protect; do',
    '    if [ "$b" = "$p" ]; then echo "Hive push guard: pushing to $p is blocked in a Hive worktree. Push to a feature branch (git push origin HEAD:refs/heads/<branch>)." >&2; exit 1; fi',
    '  done',
    '  ok=0',
    '  set -f',
    '  for g in $allow; do case "$b" in $g) ok=1 ;; esac; done',
    '  set +f',
    '  if [ "$ok" != 1 ]; then echo "Hive push guard: this workflow may push only to: $allow (not $b). Add the branch pattern to the workflow\'s worktree.pushBranches." >&2; exit 1; fi',
    '  case "$rsha" in',
    '    *[!0]*)',
    '      if ! git cat-file -e "$rsha^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$rsha" "$lsha" 2>/dev/null; then',
    '        echo "Hive push guard: non-fast-forward (force) push to $b is blocked. Fetch, rebase or merge, then push without --force." >&2; exit 1',
    '      fi ;;',
    '  esac',
    'done || exit 1',
    ...chainLines('pre-push', chain, true)
  ]
  return `${lines.join('\n')}\n`
}

/** Shell lines that run `deny` when the run is a dry run ($HIVE_DRY_RUN=1|true, or the hooks dir's marker file). */
function dryRunLines(marker: string | null, deny: string): string[] {
  return [
    'hive_dry=0',
    'case "${HIVE_DRY_RUN:-}" in 1|true) hive_dry=1 ;; esac',
    ...(marker ? [`[ -f ${q(marker)} ] && hive_dry=1`] : []),
    `if [ "$hive_dry" = 1 ]; then ${deny}; fi`
  ]
}

/** Marker file in a run's hooks dir: present = the run is a dry run (written at ensure, removed when the run ends). */
export const DRY_RUN_MARKER = 'dry-run'

/**
 * PATH shims for isolated nodes (defense in depth on top of pre-push): `git push` refuses --no-verify, --force*, +refspecs,
 * --mirror and --delete, and `-c core.hooksPath=…` is refused for any git command; `gh pr merge` and merge API calls
 * are refused. Everything else execs the real binary (first one on PATH after the shim dir). A process that calls the
 * real binary by absolute path bypasses the shims; the pre-push hook still applies unless --no-verify is passed.
 */
const SHIM_REAL = (bin: string): string => `self_dir=$(cd "$(dirname "$0")" && pwd -P)
real=""
oldifs=$IFS; IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  dd=$(cd "$d" 2>/dev/null && pwd -P) || continue
  [ "$dd" = "$self_dir" ] && continue
  if [ -x "$d/${bin}" ]; then real="$d/${bin}"; break; fi
done
IFS=$oldifs
[ -n "$real" ] || { echo "Hive: ${bin} not found on PATH" >&2; exit 127; }
deny() { echo "Hive push guard: $1" >&2; exit 1; }
`

export function gitShimScript(hooksDir: string): string {
  return `#!/bin/sh
# Hive (AUTHORING.md PO5): git wrapper for isolated workflow nodes.
${SHIM_REAL('git')}# the guard cannot be switched off from the environment either
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=${q(hooksDir)}
case "$GIT_CONFIG_PARAMETERS" in *[hH][oO][oO][kK][sS][pP][aA][tT][hH]*) unset GIT_CONFIG_PARAMETERS ;; esac
sub=""; skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then
    skip=0
    case "$a" in *[hH][oO][oO][kK][sS][pP][aA][tT][hH]*) deny "overriding core.hooksPath is blocked in Hive worktrees." ;; esac
    continue
  fi
  if [ "$skip" = 2 ]; then skip=0; continue; fi
  if [ -z "$sub" ]; then
    case "$a" in
      -c) skip=1 ;;
      -C|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env) skip=2 ;;
      -c*|--config-env=*) case "$a" in *[hH][oO][oO][kK][sS][pP][aA][tT][hH]*) deny "overriding core.hooksPath is blocked in Hive worktrees." ;; esac ;;
      -*) ;;
      *) sub="$a" ;;
    esac
    continue
  fi
  if [ "$sub" = push ]; then
    case "$a" in
      --no-verify) deny "git push --no-verify is blocked in Hive worktrees." ;;
      --force|--force-with-lease|--force-with-lease=*|--force-if-includes|--mirror|--delete|--prune) deny "git push $a is blocked in Hive worktrees." ;;
      --*) ;;
      -*f*|-*d*) deny "git push $a is blocked in Hive worktrees (no force, no delete)." ;;
      +*) deny "force refspec $a is blocked in Hive worktrees." ;;
    esac
  fi
done
if [ "$sub" = push ]; then
${dryRunLines(path.join(hooksDir, DRY_RUN_MARKER), 'deny "this run is a dry run (dry_run = true): git push is blocked."').map((l) => `  ${l}`).join('\n')}
fi
exec "$real" "$@"
`
}

export function ghShimScript(): string {
  return `#!/bin/sh
# Hive (AUTHORING.md PO5): gh wrapper for isolated workflow nodes. Agents open PRs; merging stays with the user.
${SHIM_REAL('gh')}prev=""; api=0
for a in "$@"; do
  [ "$prev" = pr ] && [ "$a" = merge ] && deny "gh pr merge is blocked in Hive workflows: the user merges."
  [ "$a" = api ] && api=1
  if [ "$api" = 1 ]; then case "$a" in */merge|*/merge\?*|*/merges) deny "merging through gh api is blocked in Hive workflows: the user merges." ;; esac; fi
  prev="$a"
done
exec "$real" "$@"
`
}

function chainLines(hook: string, chain: string | null, stdinSaved: boolean): string[] {
  if (!chain) return ['exit 0']
  return [
    `d=${q(chain)}`,
    'case "$d" in /*) ;; *) d="$PWD/$d" ;; esac',
    `h="$d/${hook}"`,
    stdinSaved
      ? 'if [ -x "$h" ]; then printf "%s\\n" "$input" | "$h" "$@"; exit $?; fi'
      : 'if [ -x "$h" ]; then exec "$h" "$@"; fi',
    'exit 0'
  ]
}

export function shimScript(hook: string, chain: string): string {
  return `${['#!/bin/sh', `# Hive: chains to the repository's own ${hook} hook (core.hooksPath points here for this run).`, ...chainLines(hook, chain, false)].join('\n')}\n`
}

export interface WorktreeManagerDeps {
  db: DB
  userData: string
  git: GitRunner
  /** Repo id for an absolute repo path (null = not added to Hive). */
  repoIdForPath(p: string): Id | null
  /** PO5: branch globs this run's isolated nodes may push to (the workflow's worktree.pushBranches). null = default hive/*. */
  pushBranches?(runId: Id): string[] | null
  /** PATH the shims are prepended to (the login env's). */
  basePath?(): string
  emit?(wt: RunWorktree): void
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  now?: () => Date
}

export class WorktreeManager implements WorktreeBridge {
  private pending = new Map<Id, Promise<RunWorktree>>()
  private now: () => Date
  constructor(private d: WorktreeManagerDeps) {
    this.now = d.now ?? (() => new Date())
  }

  get root(): string {
    return path.join(this.d.userData, 'worktrees')
  }
  hooksDir(runId: Id): string {
    return path.join(this.d.userData, 'git-hooks', runId)
  }

  // ---------- reads ----------
  private row(id: Id): Row | null {
    return (this.d.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as Row | undefined) ?? null
  }
  private rowForRun(runId: Id): Row | null {
    return (this.d.db.prepare('SELECT * FROM worktrees WHERE run_id = ? ORDER BY created_at DESC LIMIT 1').get(runId) as Row | undefined) ?? null
  }
  get(id: Id): RunWorktree | null {
    const r = this.row(id)
    return r ? toWorktree(r) : null
  }
  forRun(runId: Id): RunWorktree | null {
    const r = this.rowForRun(runId)
    return r ? toWorktree(r) : null
  }
  list(status?: RunWorktree['status'][]): RunWorktree[] {
    const rows = status?.length
      ? (this.d.db.prepare(`SELECT * FROM worktrees WHERE status IN (${status.map(() => '?').join(',')}) ORDER BY created_at DESC`).all(...status) as Row[])
      : (this.d.db.prepare('SELECT * FROM worktrees ORDER BY created_at DESC').all() as Row[])
    return rows.map(toWorktree)
  }
  /** Source repo path for a cwd inside a Hive worktree (memory grants resolve the project from it). */
  sourceRepoFor(cwd: string): string | null {
    const root = this.root + path.sep
    if (!cwd.startsWith(root)) return null
    const dir = cwd.slice(root.length).split(path.sep)[0]
    // run rows live at <root>/<runId>, task rows at <root>/task-<identifier>: match the folder, newest row first
    const r = (this.d.db.prepare('SELECT * FROM worktrees WHERE path = ? ORDER BY created_at DESC LIMIT 1').get(path.join(this.root, dir)) as Row | undefined) ?? this.rowForRun(dir)
    if (!r) return null
    const rest = cwd.slice(root.length + dir.length)
    return r.repo_path + rest
  }

  private update(id: Id, patch: Partial<Pick<Row, 'status' | 'kept_reason' | 'error' | 'removed_at' | 'base' | 'base_ref' | 'base_sha' | 'heads_json'>>): RunWorktree {
    const keys = Object.keys(patch)
    if (keys.length) this.d.db.prepare(`UPDATE worktrees SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...patch, __id: id })
    const wt = this.get(id)!
    try {
      this.d.emit?.(wt)
    } catch {
      /* never fail git work on an event */
    }
    return wt
  }

  // ---------- PO5 ----------
  /** Env for every process of an isolated node: core.hooksPath -> this run's guard dir. */
  guardEnv(runId: Id): Record<string, string> {
    const r = this.rowForRun(runId)
    if (!r || (r.status !== 'active' && r.status !== 'creating')) return {}
    const bin = path.join(this.hooksDir(runId), 'bin')
    const base = this.d.basePath?.() ?? process.env.PATH ?? '/usr/bin:/bin'
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: this.hooksDir(runId),
      HIVE_WORKTREE: r.path,
      HIVE_WORKTREE_BRANCH: r.branch,
      ...(fs.existsSync(bin) ? { PATH: `${bin}:${base}` } : {})
    }
  }

  private async writeHooks(runId: Id, repoPath: string, protect: string[]): Promise<void> {
    // the repo's own hooks: core.hooksPath (as configured; relative = relative to the worktree root) else <common dir>/hooks
    const cfg = await this.d.git(['config', '--get', 'core.hooksPath'], { cwd: repoPath })
    let chain: string | null = cfg.code === 0 && cfg.stdout.trim() ? cfg.stdout.trim() : null
    if (chain?.startsWith('~/')) chain = path.join(process.env.HOME ?? '', chain.slice(2))
    if (!chain) {
      const common = await this.d.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoPath })
      if (common.code === 0 && common.stdout.trim()) chain = path.join(common.stdout.trim(), 'hooks')
    }
    const dir = this.hooksDir(runId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const write = (name: string, text: string) => {
      const f = path.join(dir, name)
      fs.writeFileSync(f, text, { mode: 0o755 })
      fs.chmodSync(f, 0o755)
    }
    let allow = DEFAULT_PUSH_BRANCHES
    try {
      const declared = this.d.pushBranches?.(runId)
      if (declared && declared.length) allow = declared
    } catch {
      /* default */
    }
    write('pre-push', prePushScript(protect, chain, allow, path.join(dir, DRY_RUN_MARKER)))
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 })
    for (const [name, text] of [['git', gitShimScript(dir)], ['gh', ghShimScript()]] as const) {
      const f = path.join(bin, name)
      fs.writeFileSync(f, text, { mode: 0o755 })
      fs.chmodSync(f, 0o755)
    }
    if (!chain) return
    // shims only for hooks the repo actually has (absolute chain dirs); relative chains get every shim (cheap no-op)
    const abs = path.isAbsolute(chain)
    for (const h of CHAINED_HOOKS) {
      if (abs) {
        try {
          fs.accessSync(path.join(chain, h), fs.constants.X_OK)
        } catch {
          continue
        }
      } else if (h === 'reference-transaction') continue
      write(h, shimScript(h, chain))
    }
  }

  // ---------- branches created during a run (any node, isolated or not) ----------
  /**
   * Records refs/heads of every repo the run may touch, before any node starts (sync fs read; git fallback when the
   * repo uses reftable). The first snapshot per (run, repo) wins. Hive's own worktrees are skipped.
   */
  snapshotRun(runId: Id, paths: string[]): void {
    const at = this.now().toISOString()
    const seen = new Set<string>()
    for (const p of paths) {
      const dirs = gitDirsSync(p)
      if (!dirs || seen.has(dirs.top) || dirs.top.startsWith(this.root + path.sep)) continue
      seen.add(dirs.top)
      if (this.refsRow(runId, dirs.top)) continue
      const heads = listHeadsSync(dirs.common)
      if (heads) {
        this.insertRefs(runId, dirs.top, heads, at)
        continue
      }
      void this.d.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: dirs.top }).then((h) => {
        if (h.code === 0) this.insertRefs(runId, dirs.top, h.stdout.split('\n').map((x) => x.trim()).filter(Boolean), at)
      })
    }
  }

  private insertRefs(runId: Id, repoPath: string, heads: string[], at: string): void {
    this.d.db
      .prepare('INSERT OR IGNORE INTO run_refs(run_id, repo_path, heads_json, created_at) VALUES (?,?,?,?)')
      .run(runId, repoPath, JSON.stringify(heads), at)
  }
  private refsRow(runId: Id, repoPath: string): RefsRow | null {
    return (this.d.db.prepare('SELECT * FROM run_refs WHERE run_id = ? AND repo_path = ?').get(runId, repoPath) as RefsRow | undefined) ?? null
  }

  /** Every local branch created while the run ran, per snapshotted repo (plus the worktree repo of older rows). */
  async branches(runId: Id): Promise<RunBranch[]> {
    const git = this.d.git
    const wt = this.rowForRun(runId)
    const rows = this.d.db.prepare('SELECT * FROM run_refs WHERE run_id = ?').all(runId) as RefsRow[]
    const scopes = rows.map((x) => ({ repo: x.repo_path, before: new Set<string>(JSON.parse(x.heads_json) as string[]), since: x.created_at }))
    if (wt && !scopes.some((x) => x.repo === wt.repo_path)) {
      scopes.push({ repo: wt.repo_path, before: new Set<string>(JSON.parse(wt.heads_json || '[]') as string[]), since: wt.created_at })
    }
    const out: RunBranch[] = []
    // a board task's branch (WORKTREE.md) is the task's, even when its worktree was made while this run ran
    const taskBranches = new Set((this.d.db.prepare(`SELECT repo_path, branch FROM worktrees WHERE NOT (${NOT_TASK})`).all() as { repo_path: string; branch: string }[]).map((x) => `${x.repo_path}\0${x.branch}`))
    for (const sc of scopes) {
      if (!fs.existsSync(sc.repo)) continue
      const heads = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: sc.repo })
      if (heads.code !== 0) continue
      const created = heads.stdout
        .split('\n')
        .map((x) => x.trim())
        .filter((b) => b && !sc.before.has(b) && !taskBranches.has(`${sc.repo}\0${b}`))
      if (!created.length) continue
      const wl = await git(['worktree', 'list', '--porcelain'], { cwd: sc.repo })
      const checked = new Set(
        wl.stdout
          .split('\n')
          .filter((l) => l.startsWith('branch refs/heads/'))
          .map((l) => l.slice('branch refs/heads/'.length).trim())
      )
      const since = `--since=${Math.floor(Date.parse(sc.since) / 1000) - 1}`
      const extraNot = wt && wt.repo_path === sc.repo && wt.base_sha ? [wt.base_sha] : []
      for (const name of created) {
        const rl = await git(['rev-list', '--count', since, `refs/heads/${name}`, '--not', '--remotes', ...extraNot], { cwd: sc.repo })
        const n = rl.code === 0 ? Number.parseInt(rl.stdout.trim(), 10) || 0 : 1
        out.push({ repoPath: sc.repo, name, newCommits: n, checkedOut: checked.has(name), hive: !!wt && wt.repo_path === sc.repo && wt.branch === name })
      }
    }
    return out
  }

  /**
   * PO6 for every branch created during the run: delete the ones that carry no new unpushed commit and are not checked
   * out (fetched PR heads like `git fetch origin pull/N/head:prN`, pushed branches). Returns what is left (offered on the
   * RunView). Never runs while the run's worktree is in use.
   */
  async sweepRun(runId: Id): Promise<RunBranch[]> {
    const wt = this.rowForRun(runId)
    if (wt && (wt.status === 'active' || wt.status === 'creating')) return []
    const all = await this.branches(runId)
    const left: RunBranch[] = []
    for (const b of all) {
      // item 5: Hive's own hive/ branch stays once it was pushed (the user may continue it); it is listed, not deleted
      if (b.hive && wt && (await this.isPushed(b.repoPath, b.name, wt.base_sha))) {
        left.push(b)
        continue
      }
      if (b.newCommits === 0 && !b.checkedOut) {
        const del = await this.d.git(['branch', '-D', b.name], { cwd: b.repoPath })
        if (del.code === 0) continue
      }
      left.push(b)
    }
    this.recordLeft(runId, left)
    if (all.length) this.d.log?.info('run branches swept', { runId, deleted: all.length - left.length, left: left.map((b) => b.name) })
    return left
  }

  /** The user chose to delete branches created during the run (even with unpushed work). Returns what is left. */
  async deleteBranches(runId: Id, which: { repoPath: string; name: string }[]): Promise<RunBranch[]> {
    const created = await this.branches(runId)
    const want = new Set(which.map((w) => `${w.repoPath}\0${w.name}`))
    for (const b of created) {
      if (!want.has(`${b.repoPath}\0${b.name}`)) continue
      if (b.checkedOut) throw new HiveError('conflict', `${b.name} is checked out; switch away from it first`)
      const del = await this.d.git(['branch', '-D', b.name], { cwd: b.repoPath })
      if (del.code !== 0) throw new HiveError('internal', `git branch -D ${b.name} failed: ${del.stderr.trim().slice(0, 300)}`)
    }
    const left = await this.branches(runId)
    this.recordLeft(runId, left)
    return left
  }

  private recordLeft(runId: Id, left: RunBranch[]): void {
    this.d.db.prepare('UPDATE run_refs SET left_json = ?, swept_at = ? WHERE run_id = ?').run(JSON.stringify(left), this.now().toISOString(), runId)
  }

  // ---------- ensure ----------
  ensure(req: { runId: Id; workflowName: string; repo: string; base: string | null; dryRun?: boolean }): Promise<RunWorktree> {
    const existing = this.rowForRun(req.runId)
    if (existing && existing.status === 'active') return Promise.resolve(toWorktree(existing))
    const p = this.pending.get(req.runId)
    if (p) return p
    const job = this.create(req).finally(() => this.pending.delete(req.runId))
    this.pending.set(req.runId, job)
    return job
  }

  private create(req: { runId: Id; workflowName: string; repo: string; base: string | null; dryRun?: boolean }): Promise<RunWorktree> {
    return this.createFor({ ownerId: req.runId, repo: req.repo, base: req.base, dryRun: req.dryRun, branch: `hive/${branchSlug(req.workflowName)}-${req.runId}`, wtPath: path.join(this.root, req.runId), snapshot: true })
  }

  /**
   * One worktree for an owner (a run, or a board task): the base is the requested branch (remote preferred), else
   * origin/HEAD, main, master, HEAD. Runs record refs/heads in run_refs (PO14); a task only keeps them on its row.
   * `reuseBranch`: the branch may already exist (a task Started again): it is checked out instead of created.
   */
  private async createFor(req: { ownerId: Id; repo: string; base: string | null; dryRun?: boolean; branch: string; wtPath: string; snapshot: boolean; reuseBranch?: boolean }): Promise<RunWorktree> {
    if (!/^[a-z]+_[0-9a-z]+$/.test(req.ownerId)) throw new HiveError('bad_request', 'bad run id')
    const git = this.d.git
    let repoPath = req.repo
    try {
      repoPath = fs.realpathSync(req.repo)
    } catch {
      throw new HiveError('not_found', `Worktree repo not found: ${req.repo}`)
    }
    const top = await git(['rev-parse', '--show-toplevel'], { cwd: repoPath })
    if (top.code !== 0) throw new HiveError('validation', `${repoPath} is not a git repository`)
    let topPath = top.stdout.trim()
    try {
      topPath = fs.realpathSync(topPath)
    } catch {
      /* keep */
    }
    if (topPath !== repoPath) repoPath = topPath

    // base: requested branch (remote preferred) else origin/HEAD, main, master, HEAD
    const has = async (ref: string) => (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoPath })).code === 0
    let defaultBranch: string | null = null
    const sym = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath })
    if (sym.code === 0 && sym.stdout.trim()) defaultBranch = sym.stdout.trim().replace(/^origin\//, '')
    else if (await has('refs/heads/main')) defaultBranch = 'main'
    else if (await has('refs/heads/master')) defaultBranch = 'master'
    const want = req.base?.trim() || defaultBranch
    let baseRef = 'HEAD'
    let baseBranch: string | null = null
    if (want) {
      const remoteName = want.replace(/^origin\//, '')
      const remote = await git(['remote'], { cwd: repoPath })
      const hasOrigin = remote.code === 0 && remote.stdout.split('\n').map((s) => s.trim()).includes('origin')
      if (hasOrigin) {
        const f = await git(['fetch', '--quiet', 'origin', remoteName], { cwd: repoPath, timeoutMs: 60_000 })
        if (f.code !== 0) this.d.log?.warn('worktree: fetch failed, using local refs', { repo: repoPath, branch: remoteName, err: f.stderr.slice(0, 300) })
      }
      if (hasOrigin && (await has(`refs/remotes/origin/${remoteName}`))) {
        baseRef = `origin/${remoteName}`
        baseBranch = remoteName
      } else if (await has(`refs/heads/${remoteName}`)) {
        baseRef = remoteName
        baseBranch = remoteName
      } else if (req.base) throw new HiveError('validation', `Base branch "${req.base}" not found in ${repoPath}`)
    }
    const sha = await git(['rev-parse', `${baseRef}^{commit}`], { cwd: repoPath })
    if (sha.code !== 0) throw new HiveError('validation', `${repoPath} has no commits to branch from`)
    const baseSha = sha.stdout.trim()
    // PO6: branches that existed when the RUN started (non-isolated nodes may have created some before this point)
    const snap = req.snapshot ? this.refsRow(req.ownerId, repoPath) : null
    let headList: string[]
    if (snap) headList = JSON.parse(snap.heads_json) as string[]
    else {
      const heads = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: repoPath })
      headList = heads.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      if (req.snapshot) this.insertRefs(req.ownerId, repoPath, headList, this.now().toISOString())
    }

    const branch = req.branch
    const wtPath = req.wtPath
    const reuse = !!req.reuseBranch && headList.includes(branch)
    if (!reuse && headList.includes(branch)) throw new HiveError('conflict', `Branch ${branch} already exists in ${repoPath}`)
    const id = newId('worktree')
    const createdAt = this.now().toISOString()
    const base = `${baseRef} @ ${baseSha.slice(0, 7)}`
    this.d.db
      .prepare(
        `INSERT INTO worktrees(id, run_id, repo_id, repo_path, path, branch, base, base_ref, base_sha, heads_json, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'creating', ?)`
      )
      .run(id, req.ownerId, this.d.repoIdForPath(repoPath), repoPath, wtPath, branch, base, baseRef, baseSha, JSON.stringify(headList), createdAt)
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
      const add = reuse
        ? await git(['worktree', 'add', wtPath, branch], { cwd: repoPath, timeoutMs: 120_000 })
        : await git(['worktree', 'add', '--no-track', '-b', branch, wtPath, baseSha], { cwd: repoPath, timeoutMs: 120_000 })
      if (add.code !== 0) throw new Error(add.stderr.trim().split('\n').pop() || 'git worktree add failed')
      const protect = [...new Set([defaultBranch, baseBranch].filter((b): b is string => !!b))]
      await this.writeHooks(req.ownerId, repoPath, protect)
      const marker = path.join(this.hooksDir(req.ownerId), DRY_RUN_MARKER)
      if (req.dryRun) fs.writeFileSync(marker, 'dry_run = true: every push from this run is refused\n', { mode: 0o644 })
      else fs.rmSync(marker, { force: true })
      const local = await this.setWorktreeHooksPath(repoPath, wtPath, this.hooksDir(req.ownerId))
      this.d.log?.info('worktree created', { owner: req.ownerId, path: wtPath, branch, base, worktreeHooks: local, dryRun: !!req.dryRun })
      return this.update(id, { status: 'active' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.update(id, { status: 'error', error: msg.slice(0, 500) })
      throw new HiveError('internal', `Could not create the worktree: ${msg}`)
    }
  }

  /**
   * Points the new worktree's own `core.hooksPath` at the run's guard dir (`git config --worktree`), so a push from that
   * folder is guarded even outside Hive's env. Enables `extensions.worktreeConfig` in the repo config when it is off,
   * unless the repo keeps core.bare=true / core.worktree in its shared config (git would then need those moved; Hive
   * never rewrites a user's config, so it falls back to the env guard). Never touches the main checkout's hooks.
   */
  private async setWorktreeHooksPath(repoPath: string, wtPath: string, dir: string): Promise<boolean> {
    const git = this.d.git
    const ext = await git(['config', '--bool', '--get', 'extensions.worktreeConfig'], { cwd: repoPath })
    if (ext.stdout.trim() !== 'true') {
      const bare = await git(['config', '--bool', '--get', 'core.bare'], { cwd: repoPath })
      const cwt = await git(['config', '--get', 'core.worktree'], { cwd: repoPath })
      if (bare.stdout.trim() === 'true' || cwt.stdout.trim()) {
        this.d.log?.warn('worktree: repo keeps core.bare/core.worktree in its shared config; push guard via env only', { repo: repoPath })
        return false
      }
      const on = await git(['config', 'extensions.worktreeConfig', 'true'], { cwd: repoPath })
      if (on.code !== 0) {
        this.d.log?.warn('worktree: could not enable extensions.worktreeConfig; push guard via env only', { repo: repoPath, err: on.stderr.slice(0, 300) })
        return false
      }
    }
    const set = await git(['config', '--worktree', 'core.hooksPath', dir], { cwd: wtPath })
    if (set.code !== 0) this.d.log?.warn('worktree: git config --worktree core.hooksPath failed; push guard via env only', { path: wtPath, err: set.stderr.slice(0, 300) })
    return set.code === 0
  }

  /** The run is over: a dry-run marker only guards the run's own processes; a kept worktree is the user's again. */
  private clearDryRun(runId: Id): void {
    try {
      fs.rmSync(path.join(this.hooksDir(runId), DRY_RUN_MARKER), { force: true })
    } catch {
      /* best effort */
    }
  }

  /**
   * Item 5: is a local branch Hive created "pushed"? A remote-tracking ref of the same name exists, or one of its commits
   * not in the base is on a remote. Pushed branches are never deleted by Remove/cleanup.
   */
  private async isPushed(repoPath: string, branch: string, baseSha: string | null): Promise<boolean> {
    const git = this.d.git
    const remotes = await git(['for-each-ref', '--format=%(refname)', 'refs/remotes/'], { cwd: repoPath })
    if (remotes.code === 0 && remotes.stdout.split('\n').some((r) => r.trim().endsWith(`/${branch}`) && r.trim() !== `refs/remotes/${branch}`)) return true
    const mine = await git(['rev-list', `refs/heads/${branch}`, '--not', ...(baseSha ? [baseSha] : [])], { cwd: repoPath })
    const all = mine.code === 0 ? mine.stdout.split('\n').filter(Boolean) : []
    if (!all.length) return false
    const local = await git(['rev-list', `refs/heads/${branch}`, '--not', '--remotes', ...(baseSha ? [baseSha] : [])], { cwd: repoPath })
    const unpushed = local.code === 0 ? local.stdout.split('\n').filter(Boolean).length : all.length
    return unpushed < all.length
  }

  // ---------- finish (PO6) ----------
  async finish(runId: Id, outcome: { status: RunStatus; nothingToDo: boolean }): Promise<RunWorktree | null> {
    try {
      await this.pending.get(runId)?.catch(() => undefined)
      const r = this.rowForRun(runId)
      if (!r || r.status !== 'active' || isTaskOwner(r.run_id)) return r ? toWorktree(r) : null
      this.clearDryRun(runId)
      if (outcome.status === 'failed') return this.update(r.id, { status: 'kept', kept_reason: 'failed' })
      if (outcome.status === 'canceled') return this.update(r.id, { status: 'kept', kept_reason: 'canceled' })
      const work = await this.inspect(r)
      if (work.pushed) return this.update(r.id, { status: 'kept', kept_reason: 'pushed' })
      if (work.dirty || work.unpushed > 0) return this.update(r.id, { status: 'kept', kept_reason: 'dirty' })
      return await this.removeRow(r, work.newBranches)
    } catch (e) {
      this.d.log?.warn('worktree finish failed', { runId, e: String(e) })
      const r = this.rowForRun(runId)
      if (r && r.status === 'active') return this.update(r.id, { status: 'kept', kept_reason: 'dirty', error: String(e).slice(0, 300) })
      return r ? toWorktree(r) : null
    }
  }

  /** Work done in this run (PO6). */
  async inspect(r: Row): Promise<{ dirty: boolean; newCommits: number; unpushed: number; pushed: boolean; newBranches: string[] }> {
    const git = this.d.git
    const exists = fs.existsSync(r.path)
    const st = exists ? await git(['status', '--porcelain'], { cwd: r.path }) : { code: 1, stdout: '', stderr: '' }
    const dirty = st.code === 0 && st.stdout.trim().length > 0
    const before = new Set<string>(JSON.parse(r.heads_json || '[]') as string[])
    const heads = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: r.repo_path })
    const newBranches = heads.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((b) => b && !before.has(b))
    const tips = [...(exists ? ['HEAD'] : []), ...newBranches.map((b) => `refs/heads/${b}`)]
    if (!tips.length || !r.base_sha) return { dirty, newCommits: 0, unpushed: 0, pushed: false, newBranches }
    // "created in this run" = committer date at/after ensure (1 s of slack); a PR checked out detached is older
    const since = `--since=${Math.floor(Date.parse(r.created_at) / 1000) - 1}`
    const cwd = exists ? r.path : r.repo_path
    const all = await git(['rev-list', since, ...tips, '--not', r.base_sha], { cwd })
    const newCommits = all.code === 0 ? all.stdout.split('\n').filter(Boolean) : []
    if (!newCommits.length) return { dirty, newCommits: 0, unpushed: 0, pushed: false, newBranches }
    const notRemote = await git(['rev-list', since, ...tips, '--not', r.base_sha, '--remotes'], { cwd })
    const unpushed = notRemote.code === 0 ? notRemote.stdout.split('\n').filter(Boolean).length : newCommits.length
    return { dirty, newCommits: newCommits.length, unpushed, pushed: unpushed < newCommits.length, newBranches }
  }

  /** git worktree remove --force + delete branches this run created that carry no unpushed commits. */
  private async removeRow(r: Row, createdBranches: string[]): Promise<RunWorktree> {
    const git = this.d.git
    if (fs.existsSync(r.path)) {
      const rm = await git(['worktree', 'remove', '--force', r.path], { cwd: r.repo_path })
      if (rm.code !== 0 && fs.existsSync(r.path)) {
        return this.update(r.id, { status: 'kept', kept_reason: 'dirty', error: `git worktree remove failed: ${rm.stderr.trim().slice(0, 300)}` })
      }
    } else await git(['worktree', 'prune'], { cwd: r.repo_path })
    const before = new Set<string>(JSON.parse(r.heads_json || '[]') as string[])
    const candidates = [...new Set([r.branch, ...createdBranches])].filter((b) => !before.has(b))
    for (const b of candidates) {
      const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: r.repo_path })
      if (exists.code !== 0) continue
      // item 5: Hive's own hive/ branch goes only when it was never pushed
      if (b === r.branch && (await this.isPushed(r.repo_path, b, r.base_sha))) continue
      const args = ['rev-list', `refs/heads/${b}`, '--not', '--remotes', ...(r.base_sha ? [r.base_sha] : [])]
      const unpushed = await git(args, { cwd: r.repo_path })
      if (unpushed.code !== 0 || unpushed.stdout.trim()) continue
      await git(['branch', '-D', b], { cwd: r.repo_path })
    }
    this.removeHooks(r.run_id)
    this.d.log?.info('worktree removed', { runId: r.run_id, path: r.path })
    return this.update(r.id, { status: 'removed', kept_reason: null, removed_at: this.now().toISOString() })
  }

  private removeHooks(runId: Id): void {
    try {
      fs.rmSync(this.hooksDir(runId), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  /**
   * worktrees:remove (user clicked Remove): the worktree folder, then Hive's own local branch in the user's repo, but only
   * the branch Hive created and recorded for this run (not one that existed before it) and only when it was never pushed
   * (no remote ref of that name, none of its new commits on a remote). Unpushed new commits are deleted only when the
   * user confirmed losing them (keptReason 'dirty' - the dialog says so - or discardWork). Then the PO6 sweep of every
   * other branch created during the run. Branches with new unpushed work stay and are listed by branches().
   */
  async remove(id: Id, opts: { discardWork?: boolean; /** false: skip the run-wide branch sweep (Usage › Clean Up, long after the run) */ sweep?: boolean } = {}): Promise<RunWorktree> {
    const r = this.row(id)
    if (!r) throw new HiveError('not_found', 'Worktree not found')
    if (r.status === 'removed') return toWorktree(r)
    if (isTaskOwner(r.run_id) && r.status === 'active') throw new HiveError('conflict', 'This worktree belongs to a task. Remove it from the task (Remove Worktree…).')
    if (r.status === 'active' || r.status === 'creating') throw new HiveError('conflict', 'The run is still using this worktree')
    const git = this.d.git
    if (fs.existsSync(r.path)) {
      const rm = await git(['worktree', 'remove', '--force', r.path], { cwd: r.repo_path })
      if (rm.code !== 0 && fs.existsSync(r.path)) throw new HiveError('internal', `git worktree remove failed: ${rm.stderr.trim().slice(0, 300)}`)
    } else await git(['worktree', 'prune'], { cwd: r.repo_path })
    const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${r.branch}`], { cwd: r.repo_path })
    const recordedBefore = (JSON.parse(r.heads_json || '[]') as string[]).includes(r.branch)
    if (exists.code === 0 && !recordedBefore && !(await this.isPushed(r.repo_path, r.branch, r.base_sha))) {
      const unpushed = await git(['rev-list', `refs/heads/${r.branch}`, '--not', '--remotes', ...(r.base_sha ? [r.base_sha] : [])], { cwd: r.repo_path })
      const nothingToLose = unpushed.code === 0 && !unpushed.stdout.trim()
      if (nothingToLose || r.kept_reason === 'dirty' || opts.discardWork) await git(['branch', '-D', r.branch], { cwd: r.repo_path })
    }
    this.removeHooks(r.run_id)
    const wt = this.update(r.id, { status: 'removed', removed_at: this.now().toISOString() })
    if (opts.sweep === false) return wt
    try {
      await this.sweepRun(r.run_id)
    } catch (e) {
      this.d.log?.warn('run branch sweep failed', { runId: r.run_id, e: String(e) })
    }
    return wt
  }

  // ---------- task worktrees (WORKTREE.md) ----------
  /** The task's newest row (any status). */
  forTask(taskId: Id): RunWorktree | null {
    return this.forRun(taskId)
  }
  /** The base the task's branch started from (full sha + ref), for its work binding. */
  taskBase(taskId: Id): { baseSha: string | null; baseRef: string | null } {
    const r = this.rowForRun(taskId)
    return { baseSha: r?.base_sha ?? null, baseRef: r?.base_ref ?? null }
  }
  /** The branch has a remote-tracking ref (it was pushed): only then is GitHub asked about a PR for it. */
  async taskPushed(taskId: Id): Promise<boolean> {
    const r = this.rowForRun(taskId)
    if (!r) return false
    const cwd = fs.existsSync(r.path) ? r.path : r.repo_path
    const refs = await this.d.git(['for-each-ref', '--format=%(refname)', 'refs/remotes/'], { cwd })
    return refs.code === 0 && refs.stdout.split('\n').some((l) => l.trim().endsWith(`/${r.branch}`))
  }
  taskPath(identifier: string): string {
    return path.join(this.root, taskWorktreeDir(identifier))
  }

  /**
   * Start: the task's own worktree off the default branch (or `base`), on `hive/<identifier>-<slug>`. Idempotent while
   * active. A branch left by an earlier Start (`branch`, the task's own) is checked out again, never recreated. Only worktree add/prune, fetch,
   * rev-parse, symbolic-ref, config and for-each-ref run in the repo itself.
   */
  ensureTask(req: { taskId: Id; identifier: string; title: string; repo: string; base?: string | null; branch?: string | null }): Promise<RunWorktree> {
    const existing = this.rowForRun(req.taskId)
    if (existing && existing.status === 'active') return Promise.resolve(toWorktree(existing))
    const p = this.pending.get(req.taskId)
    if (p) return p
    const wtPath = this.taskPath(req.identifier)
    const job = (async () => {
      if (fs.existsSync(wtPath)) {
        // a folder git no longer knows is never overwritten
        await this.d.git(['worktree', 'prune'], { cwd: req.repo })
        throw new HiveError('conflict', `${wtPath} already exists. Move it away, then Start again.`)
      }
      // a worktree folder deleted by hand leaves git's record behind; prune it so the branch can be checked out again
      await this.d.git(['worktree', 'prune'], { cwd: req.repo })
      return this.createFor({ ownerId: req.taskId, repo: req.repo, base: req.base ?? null, branch: req.branch || taskBranchName(req.identifier, req.title), wtPath, snapshot: false, reuseBranch: true })
    })().finally(() => this.pending.delete(req.taskId))
    this.pending.set(req.taskId, job)
    return job
  }

  /** What removing the task's worktree would lose: uncommitted changes and commits on no remote. */
  async taskLoss(taskId: Id): Promise<{ exists: boolean; dirty: string[]; unpushed: string[] }> {
    const r = this.rowForRun(taskId)
    if (!r || r.status !== 'active') return { exists: false, dirty: [], unpushed: [] }
    const git = this.d.git
    const exists = fs.existsSync(r.path)
    const st = exists ? await git(['status', '--porcelain'], { cwd: r.path }) : { code: 1, stdout: '', stderr: '' }
    const dirty = st.code === 0 ? st.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, 50) : []
    const cwd = exists ? r.path : r.repo_path
    const has = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${r.branch}`], { cwd })
    let unpushed: string[] = []
    if (has.code === 0) {
      const log = await git(['log', '--format=%h %s', `refs/heads/${r.branch}`, '--not', '--remotes', ...(r.base_sha ? [r.base_sha] : [])], { cwd })
      unpushed = log.code === 0 ? log.stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 50) : []
    }
    return { exists, dirty, unpushed }
  }

  /**
   * Remove Worktree… (or the cleanup after a merge): refused while it holds work (uncommitted or unpushed) unless
   * `discardWork` (the founder confirmed the list). The branch goes only when Start created it and nothing on it is
   * unpushed (or discardWork); a branch that existed before is never deleted.
   */
  async removeTask(taskId: Id, opts: { discardWork?: boolean } = {}): Promise<RunWorktree | null> {
    const r = this.rowForRun(taskId)
    if (!r || r.status === 'removed') return r ? toWorktree(r) : null
    const loss = await this.taskLoss(taskId)
    if ((loss.dirty.length || loss.unpushed.length) && !opts.discardWork) {
      const parts = [
        loss.dirty.length ? `${loss.dirty.length} uncommitted change${loss.dirty.length === 1 ? '' : 's'}` : '',
        loss.unpushed.length ? `${loss.unpushed.length} unpushed commit${loss.unpushed.length === 1 ? '' : 's'}` : ''
      ].filter(Boolean)
      throw new HiveError('conflict', `The worktree has ${parts.join(' and ')}. Nothing was removed.`)
    }
    const git = this.d.git
    if (fs.existsSync(r.path)) {
      const rm = await git(['worktree', 'remove', '--force', r.path], { cwd: r.repo_path })
      if (rm.code !== 0 && fs.existsSync(r.path)) throw new HiveError('internal', `git worktree remove failed: ${rm.stderr.trim().slice(0, 300)}`)
    }
    await git(['worktree', 'prune'], { cwd: r.repo_path })
    const before = (JSON.parse(r.heads_json || '[]') as string[]).includes(r.branch)
    const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${r.branch}`], { cwd: r.repo_path })
    if (exists.code === 0 && !before) {
      const unpushed = await git(['rev-list', `refs/heads/${r.branch}`, '--not', '--remotes', ...(r.base_sha ? [r.base_sha] : [])], { cwd: r.repo_path })
      if ((unpushed.code === 0 && !unpushed.stdout.trim()) || opts.discardWork) await git(['branch', '-D', r.branch], { cwd: r.repo_path })
    }
    this.removeHooks(r.run_id)
    this.d.log?.info('task worktree removed', { taskId, path: r.path })
    return this.update(r.id, { status: 'removed', kept_reason: null, removed_at: this.now().toISOString() })
  }

  /** The folder went away by hand: prune git's record and close the row (the branch stays: it may hold work). */
  async forgetTask(taskId: Id): Promise<void> {
    const r = this.rowForRun(taskId)
    if (!r || r.status === 'removed') return
    if (fs.existsSync(r.path)) throw new HiveError('conflict', 'The worktree is still there')
    await this.d.git(['worktree', 'prune'], { cwd: r.repo_path })
    this.removeHooks(r.run_id)
    this.update(r.id, { status: 'removed', removed_at: this.now().toISOString() })
  }

  /**
   * A local merge: the branch has commits past its base and its tip is reachable from the local base branch
   * (merge-base ancestry only, run inside the task's worktree; a rebased branch is never "merged" this way).
   */
  async mergedLocally(taskId: Id): Promise<boolean> {
    const r = this.rowForRun(taskId)
    if (!r || r.status !== 'active' || !r.base_sha || !fs.existsSync(r.path)) return false
    const baseBranch = (r.base_ref ?? '').replace(/^origin\//, '')
    if (!baseBranch || baseBranch === 'HEAD') return false
    const git = this.d.git
    const tip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${r.branch}^{commit}`], { cwd: r.path })
    if (tip.code !== 0 || tip.stdout.trim() === r.base_sha) return false
    const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}^{commit}`], { cwd: r.path })
    if (local.code !== 0) return false
    return (await git(['merge-base', '--is-ancestor', tip.stdout.trim(), local.stdout.trim()], { cwd: r.path })).code === 0
  }

  /** Boot: 'creating' -> error; 'active' (Hive quit mid-run) -> kept 'failed'; vanished paths -> removed; prune once a day. */
  async bootRecover(opts: { pruneDue: boolean } = { pruneDue: true }): Promise<{ fixed: number; pruned: number }> {
    let fixed = 0
    const at = this.now().toISOString()
    fixed += this.d.db.prepare("UPDATE worktrees SET status = 'error', error = 'Hive quit while creating it' WHERE status = 'creating'").run().changes
    // a task's worktree outlives the app (WORKTREE.md): only run rows are settled here
    fixed += this.d.db.prepare(`UPDATE worktrees SET status = 'kept', kept_reason = 'failed' WHERE status = 'active' AND ${NOT_TASK}`).run().changes
    for (const r of this.d.db.prepare(`SELECT * FROM worktrees WHERE status IN ('kept','error') AND ${NOT_TASK}`).all() as Row[]) {
      if (!fs.existsSync(r.path)) {
        this.d.db.prepare("UPDATE worktrees SET status = 'removed', removed_at = ? WHERE id = ?").run(at, r.id)
        this.removeHooks(r.run_id)
        fixed++
      }
    }
    let pruned = 0
    if (opts.pruneDue) {
      const repos = (this.d.db.prepare('SELECT DISTINCT repo_path FROM worktrees').all() as { repo_path: string }[]).map((x) => x.repo_path)
      for (const repo of repos) {
        if (!fs.existsSync(repo)) continue
        if ((await this.d.git(['worktree', 'prune'], { cwd: repo })).code === 0) pruned++
      }
    }
    return { fixed, pruned }
  }
}
