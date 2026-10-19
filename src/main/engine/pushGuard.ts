/**
 * PO5 push guard, zero repo writes (AUTHORING.md §6.3). Every process of an isolated node runs with
 * GIT_CONFIG_COUNT/KEY/VALUE pointing git's core.hooksPath at Hive's own hooks dir (<userData>/git-hooks). Hive's
 * `pre-push` refuses remote branch deletes and pushes to the repo's default branch or the worktree base, then chains to
 * the repo's own hook. Every other hook name is a pure pass-through to the repo's own hooks path, so husky & co. keep
 * running in worktrees. Nothing is ever written to the repo's config or hooks.
 *
 * Main may install the dir itself and hand the env back through WorktreeBridge.guardEnv; when it does not, the engine
 * installs it lazily before the first isolated node (installPushGuard is idempotent).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = 'hive-push-guard v2'

/** Client-side hooks chained to the repo's own (reference-transaction is left out: it fires on every ref update). */
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
  'fsmonitor-watchman'
] as const

/** Resolves the repo's own hooks dir, ignoring the env override (GIT_CONFIG_COUNT=0), and runs `$orig/<name>`. */
const ORIG_HOOKS = `
own_dir=$(cd "$(dirname "$0")" && pwd -P)
orig=$(GIT_CONFIG_COUNT=0 git config --type=path --get core.hooksPath 2>/dev/null)
if [ -z "$orig" ]; then orig="$(GIT_CONFIG_COUNT=0 git rev-parse --git-common-dir 2>/dev/null)/hooks"; fi
case "$orig" in /*) ;; *) orig="$(pwd -P)/$orig" ;; esac
orig_real=$(cd "$orig" 2>/dev/null && pwd -P)
[ "$orig_real" = "$own_dir" ] && orig=""
`

const CHAIN_HOOK = `#!/bin/sh
# ${VERSION}: pass-through to the repo's own hook (Hive never writes the repo's hooks).
${ORIG_HOOKS}
name=$(basename "$0")
if [ -n "$orig" ] && [ -x "$orig/$name" ]; then exec "$orig/$name" "$@"; fi
exit 0
`

const PRE_PUSH_HOOK = `#!/bin/sh
# ${VERSION}: blocks remote branch deletes and pushes to the default branch / worktree base, then chains.
remote="$1"
input=$(cat)
case "\${HIVE_DRY_RUN:-}" in 1|true) echo "Hive: this run is a dry run (dry_run = true): every git push is blocked." >&2; exit 1 ;; esac
def=$(GIT_CONFIG_COUNT=0 git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null)
def=\${def#"$remote"/}
if [ -n "$def" ]; then protect="$def"; else protect="main master"; fi
protect="$protect $(printf '%s' "$HIVE_PUSH_PROTECT" | tr ',' ' ')"
if [ -n "$input" ]; then
  printf '%s\\n' "$input" | {
    while read -r lref lsha rref rsha; do
      [ -n "$rref" ] || continue
      case "$lsha" in
        *[!0]*) ;;
        *) echo "Hive: deleting the remote branch $rref is blocked in Hive worktrees." >&2; exit 1 ;;
      esac
      for b in $protect; do
        if [ "$rref" = "refs/heads/$b" ]; then
          echo "Hive: pushing to $b is blocked in Hive worktrees. Push a feature branch instead (git push origin HEAD:refs/heads/<branch>)." >&2
          exit 1
        fi
      done
    done
    exit 0
  } || exit 1
fi
${ORIG_HOOKS}
if [ -n "$orig" ] && [ -x "$orig/pre-push" ]; then
  if [ -n "$input" ]; then printf '%s\\n' "$input" | "$orig/pre-push" "$@"; else "$orig/pre-push" "$@" </dev/null; fi
  exit $?
fi
exit 0
`

/** Writes <dir>/pre-push + the pass-through hooks (0755) when missing or outdated. Returns dir. Throws on fs errors. */
export function installPushGuard(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const files: [string, string][] = [['pre-push', PRE_PUSH_HOOK], ...CHAINED_HOOKS.map((h): [string, string] => [h, CHAIN_HOOK])]
  for (const [name, content] of files) {
    const p = join(dir, name)
    let cur = ''
    try {
      cur = readFileSync(p, 'utf8')
    } catch {
      /* missing */
    }
    if (cur !== content) writeFileSync(p, content, { mode: 0o755 })
    chmodSync(p, 0o755)
  }
  return dir
}

/** Branch name of a RunWorktree.base like "origin/main @ 1a2b3c4" / "refs/heads/dev" -> "main" / "dev". */
export function baseBranch(base: string | null | undefined): string | null {
  const ref = (base ?? '').split(' @ ')[0]!.trim()
  if (!ref || /^[0-9a-f]{7,64}$/.test(ref) || ref === 'HEAD') return null
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '').replace(/^origin\//, '')
}

/**
 * Env for every process of an isolated node. Appends to an inherited GIT_CONFIG_COUNT instead of clobbering it.
 * `protect` = extra branch names (the worktree base); the hook adds the remote's default branch itself.
 */
export function pushGuardEnv(hooksDir: string, protect: string[], inherited: Record<string, string> = {}): Record<string, string> {
  const n = Number.parseInt(inherited.GIT_CONFIG_COUNT ?? '0', 10)
  const i = Number.isFinite(n) && n > 0 ? n : 0
  return {
    GIT_CONFIG_COUNT: String(i + 1),
    [`GIT_CONFIG_KEY_${i}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${i}`]: hooksDir,
    HIVE_PUSH_PROTECT: protect.filter(Boolean).join(',')
  }
}
