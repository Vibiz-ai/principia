/**
 * The "Morning brief" workflow (SPEC 7.3 seed): git activity of the last 24 hours across the run's company repositories
 * (HIVE_REPOS is company-scoped), then an agent writes the brief. Shared so main seeds it on first launch and the
 * Routines library (shared/routines.ts, "Code activity brief") can create it in a company that lacks it.
 */
import type { Id, WorkflowDraft } from './types'

export const MORNING_BRIEF_SEED_KEY = 'morning-brief'

export function morningBriefDraft(profileId: Id): WorkflowDraft {
  return {
  name: 'Morning brief',
  description:
    'Collects the last 24 h of git activity across your repositories and writes a markdown brief to the artifacts. Turn it on every weekday at 9:00 from Automations › Routines (Code activity brief).',
  inputs: [
    {
      name: 'root',
      label: 'Folder with your repos, or "all" for every repository added to Hive',
      type: 'text',
      default: 'all'
    }
  ],
  nodes: [
    {
      id: 'gather',
      type: 'shell',
      label: 'Gather git activity',
      after: [],
      cwd: null,
      timeoutMin: 5,
      command: [
        'R="{{inputs.root}}"; R="${R/#\\~/$HOME}"',
        'if [ -n "$R" ] && [ "$R" != all ]; then list_dirs() { for x in "$R"/*/ "$R"; do echo "$x"; done; }',
        'else list_dirs() { printf "%s\\n" "$HIVE_REPOS" | sed "/^$/d"; }; fi',
        'list_dirs | sort -u | while IFS= read -r d; do',
        '  git -C "$d" rev-parse --show-toplevel >/dev/null 2>&1 || continue',
        '  d="${d%/}"; [ "$(git -C "$d" rev-parse --show-toplevel)" = "$d" ] || continue',
        '  log=$(git -C "$d" log --since="24 hours ago" --branches --pretty="  %h %an (%ar): %s" 2>/dev/null | head -n 40)',
        '  dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d " ")',
        '  [ -z "$log" ] && [ "$dirty" = "0" ] && continue',
        '  echo "## $(basename "$d") [$(git -C "$d" branch --show-current)] - $dirty uncommitted files"',
        '  [ -n "$log" ] && echo "$log"',
        '  echo',
        'done | head -c 40000',
        '[ "$R" != all ] || [ -n "$HIVE_REPOS" ] || echo "No repositories: add one in Hive or set the folder input."'
      ].join('\n')
    },
    {
      id: 'brief',
      type: 'agent',
      label: 'Write brief',
      after: ['gather'],
      cwd: null,
      timeoutMin: 10,
      profileId,
      prompt:
        'Here is the git activity of the last 24 hours across my repositories (empty means nothing moved):\n\n{{gather.output}}\n\nWrite a short morning brief in markdown: what moved, what looks unfinished (uncommitted work), and the 3 things I should look at first. Save it as {{ARTIFACTS_DIR}}morning-brief.md and also reply with it.',
      memory: 'read-write'
    }
  ]
}
}
