# Worktree per task

Status: implemented, 2026-10-25, branch `feat/task-worktrees`. Companion to [DEPARTMENTS.md](DEPARTMENTS.md) (the
board, §1.4 state machine, §3 dispatcher), [AUTHORING.md](AUTHORING.md) (§6 worktree per run, PO5 push guard, PO6
keep/remove) and [COMPANY.md](COMPANY.md) (§5 company resolution).

Founder direction: a code task on the Board can be **Started** into its own git worktree and branch named after the
task, with an agent on it. The founder's checkout is never touched. The task follows the work until the PR is merged.

## 0. Decisions in one screen

1. **Start is the one new main action.** A white-outlined **Start** under the task title, only for a task whose
   repository belongs to its company (Personal included: its repos are the unowned ones), that is open, and that has no
   worktree yet. Sub-label: "Opens a new branch and worktree. Your checkout is not touched." Once started, the same spot
   shows the PR state. Run now stays, as a secondary button.
2. **One worktree per task**: `<userData>/worktrees/task-<ID>` on `hive/<id-lower>-<slug of the title>`, off the default
   branch (origin/HEAD, else main / master). The branch is inside the default `pushBranches` `hive/*`, so the run push
   guard covers it unchanged.
3. **Every turn of a started task runs in its worktree** with the push guard env (core.hooksPath and the bin/ shims), and
   "Open as session" opens there too. Any interactive session whose folder is inside an active Hive worktree (Open as
   session, Take over, a Restart, a chat opened on that folder) gets the same env on its PTY (`SessionDeps.worktreeGuard`
   → `WorktreeManager.guardEnvForPath`): the shims go first on the session's own PATH, so `gh pr merge` and force pushes
   are refused for the agent in a chat too. A turn whose worktree is gone fails; it never falls back to the founder's checkout.
   A turn of a task whose worktree was removed on purpose (Keep As Is, Remove Worktree…) gets it back first: a new
   worktree on the task's own branch.
4. **The task follows the work**, each move a `work` activity by Principia: worktree created → In Progress; PR open and
   ready → In Review; changes requested → the agent goes again with the reviewer's note (In Progress); PR merged (on
   GitHub or with **Merge…**) or a local merge into the base → Done with the done note "Merged #42".
5. **Merging is the founder's.** Merge… asks with a native confirm in main, then `gh pr merge --squash` (never
   `--delete-branch`). The agent shims keep refusing `gh pr merge`. No auto-push beyond the guarded rules: an agent may
   push its own `hive/*` branch and open a PR; never the default branch, never force, never delete.
6. **Several tasks at once**, with no limit unless the company sets a maxInFlight (default 0, no limit). Start beyond a set limit queues the task:
   "Queued: 3 already running". It starts when a running task finishes.
7. **Agents work in parallel; two runs never share a checkout.** An agent takes several tasks at once (§3a). A task
   whose repository checkout another in-flight run already works in gets its own worktree by itself, on Run now, a
   chat's start or an automatic one: the same binding as Start, made before its first turn.
8. **Nothing pops up unasked.** A deleted worktree shows a banner on the task, not a dialog. gh missing or signed out is a
   line on the task ("GitHub CLI not signed in"), and statuses stop moving by themselves until it is fixed.

## 1. Code map

| File | What |
|---|---|
| `src/shared/taskWork.ts` | Pure: `TaskWork` (the task's `work` field), branch and folder names, `canStartWork`, `prChip`, `nextMove` (every PR rule), `workBrief` |
| `src/main/company/taskWorkSchema.ts` | zod shape of `work` (stored on the task JSON; renderer channels omit it) |
| `src/main/company/taskWork.ts` | `TaskWorkService`: Start, the queue, `workdir` for the engine, PR polling, merge, remove, the gone banner |
| `src/main/company/taskWorkGh.ts` | gh calls (`pr view --json`, `auth status`, `pr merge --squash`) and their parsers |
| `src/main/company/taskWorkWire.ts` | Builds the service over Hive; run-end hook |
| `src/main/handlers/taskWork.ts` | `taskWork:*` channels, native confirms, Open in Editor |
| `src/main/worktrees.ts` | Task rows: `ensureTask`, `taskLoss`, `removeTask`, `forgetTask`, `mergedLocally`, `taskPushed` |
| `src/main/company/taskState.ts` | Four rows scoped to their move (`when`): PR ready, changes requested, merged, Back to Backlog |
| `src/main/engine/executor.ts` | Prompt turns ask `TaskRunBridge.workdir` for their cwd and env |
| `src/renderer/src/components/board/TaskWork.tsx` | Start, the Work section, the gone banner, PR chip, card badge |
| `src/renderer/src/components/board/TaskStrip.tsx` | The task strip above a run's or session's chat |

## 2. The binding

`BoardTask.work` (absent on older rows; `withTaskDefaults` reads it as null):

```ts
work: { repoId, worktreePath, branch, baseSha, baseRef, pr: { number, url, state, isDraft, reviewDecision, mergedAt, checkedAt } | null,
        startedAt, worktreeId, queuedAt, goneAt, removedAt, gh, reviewSeenAt, readySeen, conflict, error }
```

Only main writes it (`TaskWorkService.writeWork`, a `json_set` on the task row). `tasks:create` and `tasks:update` omit
it, like the other system fields.

**One owner record per worktree.** The worktree row in `worktrees` has `run_id = <task id>` (`task_…`). Run-only paths
skip task rows: `finish` (PO6 at a run end), `sweepRun` (a task's branch is never one of a run's branches, even when the
task's worktree was made while that run ran), `bootRecover` (an app restart keeps a task's worktree active),
and `worktrees:remove` (a task row is removed from the task). `sourceRepoFor` matches by folder, so memory grants and
company resolution see the task worktree as a checkout of its repo.

**A run owns only the branches it created.** At the run end (`finish`, and the run-end sweep with `atRunEnd`) the
branches made since the run started are frozen in `run_refs.created_json` (plus the run's own worktree branch). Every
later call (Remove long after, a later sweep, the offered list, `inspect`) reads that set, so a branch the founder makes
after the run is never taken for the run's. Rows from before the freeze existed are listed but never swept. A task's
turn is stricter: every git command it runs goes through its worktree's guard dir, whose `reference-transaction` hook
records each branch created there (`<guard dir>/created-refs`); its run owns only those (`sweepRun({ guardOwners })`),
so a branch the founder makes in their own checkout while the agent works is never swept either (QA found this).

Interactive sessions: an agent session (Claude, Codex) keeps the shims first on PATH (Claude's Bash tool keeps the
PATH it was started with). A plain Shell session is the founder's own terminal: their shell rc files may put other
folders before the shims, so there `gh` is the real one; the push guard (pre-push through core.hooksPath) still holds.

## 3. Start

1. Checks: a repository of the task's company, open, no binding, an agent or profile, the §1.4 start move allowed.
2. Limit, if the company set one: tasks In Progress in the company (plus ones being started) against maxInFlight. At it: `work.queuedAt`, a
   `work` activity "Queued: N already running", nothing else.
3. `WorktreeManager.ensureTask`: `git worktree prune`, then `git worktree add --no-track -b <branch> <path> <base sha>`
   (a branch left by an earlier Start is checked out again, never recreated). The hooks dir `<userData>/git-hooks/<task
   id>`, the pre-push, the bin/ shims and the worktree-local `core.hooksPath` are the run ones. `extensions.worktreeConfig`
   is set only when it is not already true.
4. The binding, a `work` activity "Worktree created on hive/… (origin/main @ abc1234). Your checkout is not touched.",
   `agentSessionId` cleared (a new folder is a new conversation), and the short brief (`workBrief`) as the turn's wake.
   Prompt modules are not edited.
5. `CompanyStore.startTask` (human) → In Progress. A failed start removes the fresh worktree again, unless an agent
   took the task meanwhile and works in it.

One Start per task at a time: a second Start while one is under way is refused ("This task is starting already"), and
Start, the queue and a dispatcher turn share one worktree creation, so only the call that created it can clean it up.

The queue drains on every run end, every 60 s tick and on window focus, oldest first. A queued task the dispatcher claims
by itself gets its worktree with that turn (`workdir`), never the founder's checkout.

## 3a. Parallel tasks

An agent is never "busy": a human Run now (or a chat's start) never waits for the agent's other work, nor for the
company's maxInFlight; Start never waits for a busy agent (it still queues at maxInFlight, §0.6). Automatic starts (the dispatcher, a follow-up turn, a schedule fire, a
handoff, an answer resuming, the plan pilot) stop only at a maxInFlight the company set; one agent takes any number of
tasks. The same task can still start only once
("An agent already owns this task").

Each task keeps its own provider conversation (`agentSessionId` per task), so parallel turns never share a session.

The checkout rule, in `CompanyStore.startTask`: the task's repository (its own, else its agent's default) is a git
checkout, and another task in flight with a run or session of ours works in it (no `work` binding, not a plan task).
Then the task gets a `work` binding (not started yet: path from `WorktreeManager.taskPath`, branch `hive/<id>-<slug>`),
its `repoId` written, its `agentSessionId` cleared (a new folder is a new conversation), the worktree brief in its wake
and a `work` activity "VO-12 is already working in the app checkout, so VO-15 runs in its own worktree on hive/…".
`TaskWorkService.workdir` makes the worktree before the turn, as for a queued Start; from then on it is a Started task
(PR followed, Merge…, Remove Worktree…). The first run keeps the checkout as before. Shared as before: the company
workspace and plain folders (no git), a workflow seat's run, and Open as session (the founder's own interactive
session, in the folder as it is). Without the task worktree service (no `setWorktreePaths`) a checkout is shared.

A folder already at the task's path (an agent ran `git worktree add` there by hand): `WorktreeManager.ensureTask` adopts
it when it is a worktree of this repository on a `hive/` branch that nothing else owns. The binding takes its real
branch (the wake names it too), its base is where the branch left the default branch, it gets the push guard, and a
failed start never removes it. Anything else (a plain folder, another repository's worktree, a detached HEAD, a branch
the push guard refuses) is left untouched: the turn ends in blocked(agent), in Needs you, saying what to move.

## 4. Following the work

The service checks a started task on its run end, every 60 s and on window focus (at most every 10 s):

- **Gone**: the folder no longer exists and the task is open → `goneAt` and the banner "The worktree for PRN-12 is gone.
  Cancel Task · Back to Backlog · Keep As Is". Cancel Task cancels it (its run first, if one holds it); Back to Backlog
  moves it to Backlog (a §1.4 row for exactly this); both clear the binding (the branch stays, Start again checks it out).
  Keep As Is keeps the binding as removed (no banner; an open PR is still followed). The Work section keeps the branch
  line: "Worktree removed. Start (or Run now) checks out hive/… again".
- **Local merge**: the branch has commits past its base, its tip is an ancestor of the local base branch
  (`merge-base --is-ancestor`, run inside the worktree), and no open PR decides instead → Done "Merged hive/… into main
  locally". A rebased branch is never an ancestor, so it never reads as merged.
- **PR**: GitHub is asked only once the branch has a remote-tracking ref (it was pushed) or a PR is known, and then only
  while it is open. `gh pr view <branch|url> --json number,url,state,isDraft,reviewDecision,mergedAt`. Errors back off
  (60 s doubling, at most 15 min). `nextMove`:
  - merged → Done, doneNote "Merged #N" (a `system` move allowed only with `work: 'merged'`; the human merged it). Then
    the worktree is removed when nothing would be lost.
  - open and ready, seen ready for the first time (`readySeen`), task not In Progress or In Review → In Review. A task
    the founder sent back while the PR stays open is not bounced back.
  - changes requested, task In Review, a review not handled yet (`reviewSeenAt`) → a `work` activity with the reviewer's
    note, the note as the next wake, and the agent's turn (`startTask` with `work: 'changes_requested'`). At the cap it is
    queued instead.
  - A run still holding the task is never moved: its end comes first, then the next check. A PR merged meanwhile is
    recorded, and the check after the run end makes the task Done from the recorded merge (GitHub is not asked again).

## 5. Founder actions (TaskInspector, Work section)

Branch (mono), worktree path, PR chip (#42 Open · Draft · Changes requested · Approved · Merged · Closed), then
**Open in Editor** (Cursor, VS Code or Zed when installed, else Finder) · **Open PR** · **Merge…** · **Remove Worktree…**.

- **Merge…**: native confirm, `gh pr merge <url> --squash`, then the PR check (→ Done). A conflict stops at "Merge
  conflict, open in editor". There is no conflict UI. Disabled while the task is In Progress (an agent may still push
  to the branch), with the tooltip "An agent is working on this task. Merge once it is In Review."; main refuses it then
  too, before any confirm.
- **Remove Worktree…**: refused while an agent works in it. The confirm lists what would be lost (uncommitted changes,
  commits on no remote). The branch is deleted only when Start created it and nothing on it is unpushed, or the founder
  confirmed losing it.

The Board card gets a branch glyph and the PR number. Above a task run's chat (RunView) and a task session (SessionView):
one strip with the status glyph, identifier, title, branch, PR chip and Open task.

## 6. Rules kept

- The founder's checkout is never checked out, reset, stashed or switched. In the repo itself only `worktree
  add|remove|prune`, `fetch`, `rev-parse`, `symbolic-ref`, `config` (reads, and `extensions.worktreeConfig` once),
  `for-each-ref`, `log`/`rev-list` reads and `branch -D <a branch Start created>` run.
- Several agents in sibling worktrees: dependency folders (node_modules, virtualenvs) are per worktree. The brief tells the
  agent to install them in its worktree; nothing is shared or symlinked.
- gh only (no GitLab or Bitbucket), no auto-merge on green CI, no forks, no stacking on an in-review branch.

## 7. Testing

- Unit: `src/shared/taskWork.test.ts`, `src/main/company/taskWorkGh.test.ts`, the WORKTREE rows in
  `src/main/company/taskState.test.ts`.
- End to end over real git (`src/main/__tests__/taskWork.test.ts`): Start and the untouched checkout, the push guard and
  gh shim, ready → review → changes → merged, Merge… with a conflict, a local merge, gh signed out, the gone banner's
  three answers, Remove Worktree…, the maxInFlight queue, a queued task claimed by the dispatcher, and the QA fixes: a PR
  merged mid-run, a turn after Keep As Is or Remove Worktree…, two Starts at once, a run's branch sweep; the follow-ups:
  Merge… refused In Progress, the session guard env in a task worktree (gh pr merge and force push refused).
  `src/main/__tests__/worktrees.test.ts`: a founder branch made after the run survives Remove and later sweeps.
- Markup (`src/renderer/src/components/board/TaskWork.render.test.ts`): Start for a repo added a moment ago (the live
  repo list), the Work section after Keep As Is, Merge… disabled In Progress with its tooltip.
  `src/main/__tests__/sessions.test.ts`: the guard env reaches the PTY.
- Dev instance seams (ignored in a packaged app except `HIVE_GH_BIN`): `HIVE_GH_BIN=<path>` points the PR calls at a gh
  stand-in, `HIVE_TEST_CONFIRM=yes|no` answers Merge… and Remove Worktree… confirms (CDP cannot click native dialogs).
