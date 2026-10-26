# Task briefs and Plans

Status: version 2, 2026-10-25, branch `feat/plans-v2` (ported from `feat/plans-and-briefs` onto the worktree track).
Companion to [DEPARTMENTS.md](DEPARTMENTS.md) (the Board, task tools §6, the dispatcher §3), [WORKTREE.md](WORKTREE.md)
(the task's worktree, branch and PR, Merge…), [AUTOPILOT.md](AUTOPILOT.md) and [VOICE.md](VOICE.md) (§5 line art).

Founder direction: every task carries a definition that survives from one agent to the next, and a goal can become one
plan run by one head agent. "Sometimes I just want to go ahead and work": nothing here forces a tool call, and a chat
stays a chat until the founder clicks Make a Task or approves a Plan.

## 0. Decisions in one screen

1. **Briefs are always on; Plans are experimental.** Briefs are part of every board task (the board's two flags).
   Plans sit behind **Settings › Experimental › Plans** (`experimental.plans`, on top of Companies and Departments), like
   companies and the vault: off, the sidebar has no Plans, a deep link shows "Plans are off. Turn them on in Settings ›
   Experimental.", every `plans:*` channel refuses, the pilot does nothing, and a plan task's Run now says so.
2. **Every board task has a brief**: goal, context, acceptance criteria (open / done / deferred / not done, with a reason
   for the last two), decisions (each with its why), open questions, notes for the next agent (the handoff), proof
   (screenshots, test results, links, files, graphs) and revisions (who changed which section, when). It lives in the
   task JSON (`brief`, `proof`). An old task has none: its description reads as the Context, and nothing is written
   until someone edits it. **Description and Context are one text** (editing either writes both).
3. **Agents keep it true, without nagging.** Task runs get `task_brief_edit`, `task_criterion`, `task_decide` and
   `task_attach_proof`. The prompt carries the brief in place of the description, capped, plus one paragraph of habits.
   If a turn reports without rewriting the handoff, Principia quietly writes it from the report summary (by `system`).
   A turn is never failed or re-woken for a missing brief edit. Chats get no brief tools. (v1's `task_update` for title
   and priority is gone: the proactive track owns `task_update`.)
4. **A Plan** is a goal → milestones (`dependsOn`, pass criteria) → tasks (blockers, `touches`). The head agent drafts
   it as JSON; the draft never touches the Board. **Approve Plan** creates one milestone task per milestone and its tasks
   under it, all in Backlog with their milestone agent.
5. **Three paces.** Step by Step: nothing starts; "Your turn: start PRN-31". Check-ins (default): a ready milestone gets
   its agent; each gate waits for the founder's Pass. Autopilot: a passing gate moves on; a failing gate stops the plan
   and adds fix tasks. The pace control is hidden once the plan is done or archived (and refused in main).
6. **One agent, one worktree, one conversation per milestone** (token saving). The worktree is the **milestone task's
   own WORKTREE.md binding**: `<userData>/worktrees/task-<ID>` on `hive/<id>-<slug>`, the push guard, one owner row,
   one sweep rule. There is no second worktree system (v1's `planWorkspace.ts` is gone). Its plan tasks run there one
   after another (`TaskWorkService.workdir` follows the milestone task), resuming the same Claude session.
7. **Gates need evidence.** When every task of a milestone is in review, the head agent checks briefs, proof and diff
   against the pass criteria. A pass that cites no evidence is recorded as a fail. A fail adds fix tasks and stops.
8. **Parallel awareness.** A milestone agent's note lists what runs beside it and the files those tasks edit; milestones
   and plans whose touches overlap never run side by side.
9. **No merge in the founder's checkout, ever.** A done plan's work is put on one hive/ branch, pushed through the
   guarded push and opened as a pull request with gh. Merging is the founder's: **Merge…** on that PR (the worktree
   track's: native confirm, `gh pr merge --squash`). Without gh (missing or signed out) the page shows the branch, the
   reason and the commands to open the PR; Principia never merges locally.
10. **Pause and Archive are honest.** Pause is read live, right before every start (a pause while a worktree is being
    made wins). Archive cancels the plan's open tasks and its In review ones too (they leave Needs you, each saying its
    plan was archived); it is refused while a task is in progress.

Cut on purpose: forcing task creation from chats, phases, plan change proposals with a diff UI, recaps with graphs,
shared tasks, conflict resolution UI.

## 1. Code map

| File | What |
|---|---|
| `src/shared/plans.ts` | Brief, proof, plan types; `plansEnabled`, `briefOf`, `whoseTurn`, `openPrInstructions`, `milestoneReady/Complete`, `touchesOverlap`, `planBlockerMet`, the IPC map |
| `src/main/company/brief.ts`, `briefSchemas.ts` | Pure brief edits, `briefPromptBlock`, `checkProofRef`, `BriefStore` (`fillHandoff`) |
| `src/main/company/taskToolDefs.ts`, `taskTools.ts` | The four brief tools; `task_get` returns the brief; proof roots = the task's (or its milestone's) worktree, then the run's artifacts |
| `src/main/company/plans.ts`, `plansSchemas.ts` | `PlanStore` (`company_plans`), draft parsing, approval onto the Board |
| `src/main/company/planPilot.ts` | Drafting, the pump (paces, overlap, session reuse, the live Pause check), gates, pass / send back / resume, archive, the result branch and its PR |
| `src/main/company/planWork.ts` | `PlanWork` over the worktree track: `ensure` (bind + multi-dependency merge in the new worktree), `diff`, `commitLeftovers`, `collect`, `publish` (guarded push + `gh pr create`), `cleanup` |
| `src/main/company/taskWork.ts` | (WORKTREE.md) `bind` / `unbind` / `recordPr` / `cleanupMerged`, `ownerOf` (a plan task → its milestone task), `workdir` and `sessionCwd` follow it |
| `src/main/company/taskWorkGh.ts` | `createPr`; PR lookups read `baseRefName` (the confirm says the PR's real base) |
| `src/main/worktrees.ts` | `ensureTask({ startPoint })`: a milestone off its first dependency's local branch |
| `src/main/company/planPrompt.ts` | The milestone note, the draft and gate prompts |
| `src/main/handlers/plans.ts` | `tasks:brief`, `tasks:proofPreview`, `plans:*`, the run-end hook (handoff fill, pilot) |
| `src/renderer/src/components/board/BriefPanel.tsx` | The brief in the task inspector |
| `src/renderer/src/views/PlansView.tsx`, `lib/planGraph.ts` | List, plan page, New Plan sheet, the graph |

The graph uses the app's `GraphView` (React Flow + dagre, the run graph's renderer). The diagrams track's `DiagramBlock`
draws agent-written `principia-graph` JSON with no navigation hook; the plan graph needs clickable task cards, gate
cards and milestone frames, so it keeps GraphView.

## 2. How a plan runs

- **Approve**: milestone tasks `M1 · <title>` and their tasks land in Backlog with the milestone agent and the plan link
  (`task.plan`). The dispatcher never picks a plan task (even in To do), `CompanyStore.startTask` refuses one that did
  not come through the pilot, Take over is refused, and the worktree track's Start is not offered for one
  (`canStartWork`; `TaskWorkService.startTask` refuses too).
- **Start**: the pilot reads Pause, binds the milestone task's worktree (`PlanWork.ensure` → `TaskWorkService.bind` →
  `WorktreeManager.ensureTask`), reads Pause again, writes the milestone note as the wake, sets the milestone's session
  as the task's `agentSessionId`, and starts it as a human start (the founder's pace is the consent). The run target
  carries no folder: the executor asks `TaskRunBridge.workdir`, which for a plan task returns the milestone worktree
  and its push guard env; a missing milestone worktree fails the turn, never the founder's checkout.
- **Run end**: the session is captured on the milestone; a failed turn drops it. Then the next task, or the gate.
- **Inside a plan, a blocker in review counts as met** (`planBlockerMet`).
- **Pass Milestone N** approves its tasks in review and its milestone task. **Send Back** adds a fix task.
  **Run Fixes** clears a stop; **Pass … Anyway** cancels fix tasks nobody started.
- **Pause** sets `pausedAt`: nothing new starts (a running turn finishes, a milestone whose tasks are all in review is
  still checked). The top line says "Paused: nothing new starts. Resume it to go on." **Resume** clears it.
- **Archive** (Stop and Archive on a running plan): open and In review tasks are canceled with an activity line; the
  plan leaves the list (the Archived chip shows it). Milestone worktrees stay on their tasks; Remove Worktree… there.

### 2.6 Where the code goes

- **A milestone that depends on several** starts from all of them: their leftovers are committed in their own
  worktrees, the new worktree starts from the first dependency's branch (`startPoint`, local, as it is) and the others
  are merged in **inside the new worktree only** ("Plan M3: start from hive/…"). A conflict aborts that merge, takes the
  fresh worktree and branch away again (`unbind`) and stops the plan with the files named.
- **When every milestone passed**, the leaves (milestones nothing depends on) are collected: leftovers committed, the
  other leaves merged into the first leaf's worktree. That branch holds the plan.
- **Publish**: the branch is pushed from its worktree (`git push -u origin HEAD:refs/heads/hive/…`, the worktree's own
  pre-push guard: hive/* only, protected branches, no force, no delete), then `gh pr create --head hive/… --base <the
  first milestone's base, main>`. The PR is recorded on the leaf's milestone task (`TaskWorkService.recordPr`), so the
  worktree track follows it like any task PR (a done task with an open PR is still followed, without status moves).
- **Merge…** on the plan page calls `taskWork:merge` for that task: the native confirm names the PR's base, then
  `gh pr merge --squash`. The pilot (and `plans:get`) read the binding: merged → "Done: merged into main (#N)" and
  every milestone worktree is removed when nothing would be lost (WORKTREE.md's cleanup rule).
- **No gh, signed out, no origin, push refused**: the result says so (`gh`, `pushed`, `error`), the top line offers
  **Open a PR** (tries again) and the Code block lists the commands (`git push -u origin hive/…` when not pushed, `gh pr
  create --head hive/… --base main`). Never a local merge, never a merge into the founder's checkout.

## 3. Checks

- Unit: `brief.test.ts` (old rows, the agent turn, the system handoff, validation, proof roots from the worktree, chats
  without brief tools), `planPilot.test.ts` (draft vs Board, approval, Check-ins, Step by Step, Autopilot fail, no-evidence
  fail, compaction, parallel notes, overlaps, send back, pass anyway, Board starts through the pilot, the dispatcher
  skipping plan tasks, multi-dependency `from`, the PR flow and Merge… follow-up, gh missing then Open a PR, two leaves,
  autonomy refused when done, Pause / Archive with In review released, Pause read live during the worktree, Plans off),
  `src/shared/plans.test.ts` (the flag, done top lines, Open a PR commands, Pause, no Start for a plan task),
  `src/renderer/src/views/plans.render.test.ts` (autonomy hidden when finished, the Archive wording, the Open a PR
  block, the PR chip).
- Real git (`src/main/__tests__/planWork.test.ts`): a 2-milestone Check-ins plan whose milestone worktrees are task
  bindings (one owner row each, plan tasks' workdir and session there, the guard env), M2 from M1's branch, push + PR
  into main, Merge…, cleanup, the founder's checkout and both mains untouched; a multi-dependency start with both
  branches merged in its own worktree; a conflicting one taken away again with the files named; gh missing then Open a PR.
- In the app (2026-10-25, own instance, a scratch repo with a local bare origin, a gh stand-in via `HIVE_GH_BIN`,
  `HIVE_TEST_CONFIRM=yes`, real Claude): a 2-milestone Check-ins plan ran each milestone in its milestone task's
  worktree (the agent process's cwd was `worktrees/task-PRN-1`), M2 started from M1's branch, Pass twice, the plan
  pushed its branch and opened PR #101 into main, Merge… merged it and both milestone worktrees were removed; the
  founder's checkout stayed on main, clean, at its first commit. A 3-milestone plan: Pause right after approval held
  M2 back for over a minute with the seat free (the gate of M1 still ran), Resume started it, M3 started from both
  branches ("Plan M3: start from hive/…"), Stop and Archive with two tasks in review emptied Needs you. With gh signed
  out the plan pushed and showed Open a PR with the command; Open a PR after signing in opened #103; merging it
  approved the Autopilot tasks left in review ("Merged #103").
- A QA finding fixed on the way: a merged plan PR now approves the plan tasks still in review (Autopilot leaves them
  there), with "Merged #N".
