# Principia's own layer between runs (the orchestrator)

Status: phases P0-P4 implemented, 2026-10-26 (branch `feat/orchestrator`). Lives behind the board switch
(`experimental.companies` + `.departments`) and `Settings.orchestrator` (default: on, rules coordinator), with each
company's own switches in This company > Team & autonomy > "Principia runs the team".
Companion to [AGENT-COLLAB.md](AGENT-COLLAB.md) (agents asking agents), [PROACTIVE.md](PROACTIVE.md) (the
"Use Principia" section) and [DEPARTMENTS.md](DEPARTMENTS.md) (the board).

## 0. Why

Agents talking to each other, filing follow-ups and keeping the founder informed used to depend on the CLI model
choosing to call Principia's MCP tools. Claude gets the most tools; Codex, Gemini and Cursor get fewer. So the same
company behaved differently by harness.

Now Principia does the higher-level work itself, the same on every harness. Before a run it hands the agent its
context and the report contract. After the run it reads the report and acts. MCP tools stay an optional fast path
inside a task; whatever the agent already did with them is never done twice.

## 1. The run lifecycle

### 1.1 Before a run (`src/main/orchestrator/context.ts`)

`executor.ts` `withPrincipia` appends one block to every non-shell step of a company run that has an agent (a board
task run, or a seat's Forum reply run), on every adapter, after the "Use Principia" section:

- **Inbox:** teammates' open questions for this agent (with the ref to answer), and answers to its own questions
  that no wake delivered (an answer that woke the task is in that turn's prompt already: never twice).
- **Your teammates:** every other active agent of the company, one line each: `@marcus (Brand Voice Writer,
  Marketing)` (the persona name is added when it differs from the handle). The report's `to`, `agentHandle` and
  handoff name them by handle; a name or role works too (§2).
- **Relevant tasks:** its task's dependencies, sibling subtasks and other open tasks of its department.
- **Teammates' recent work:** the latest task reports of the company (3 days).
- **Knowledge:** a read-only brief, only when a reader is plugged in (steps with memory already get their brief).
- **The report contract** (§1.2).

At most ~1,500 tokens (6,000 characters); sections are dropped in priority order, the contract always fits. A resumed
turn gets only the inbox delta and a one-line reminder. The block says it is data, not instructions.

### 1.2 The run report contract v1 (`runReport.ts`)

Two ways to deliver it, both harness-agnostic:

1. a trailing fenced `principia-run-report` JSON block (only whitespace may follow it);
2. the same JSON in the file named by `$PRINCIPIA_RUN_REPORT` (`<run logs>/<run id>/<step id>.report.json`).

```json
{"v":1,"outcome":"review|blocked|answered|progress","summary":"…","evidence":["…"],
 "followUps":[{"title":"…","goal":"…","agentHandle":"optional @teammate","departmentKey":"optional","blocksCurrent":false}],
 "handoff":{"departmentKey":"or agentHandle","why":"…"},
 "questions":[{"to":"@handle (or a name)|@department|founder","question":"…","why":"…","blocking":false}],
 "answers":[{"ref":"m1c","text":"…"}],
 "facts":[{"text":"…","topic":"optional note"}],
 "blockers":[{"text":"…","needs":"decision|access|money|connection","connectionId":"optional"}],
 "suggestions":[{"kind":"routine|connection|task","text":"…"}]}
```

Parsing is lenient about shape (missing lists are empty, broken entries dropped, text clipped, lists capped) and
strict about place (a block that is not at the end is no report; only the last block counts). `reportHarvest.ts`
accepts both `principia-task-report` and `principia-run-report` through one shared trailing-fence parser, and maps
`outcome`/`summary`/`evidence` into `task.report` as before (`answered` and `progress` read as review).

**Fallback extractor** (`extract.ts`): a run that passed with neither the block nor the file gets one cheap headless
call (haiku on Claude, low effort on Codex; no tools, empty cwd, the founder's own login; a company's own key only if
it set one), framed as data. Its report is stamped `extracted` and only proposes. It counts against
`callsPerDay` (`orch_budget`) and is skipped when `extractFallback` is off. Only task runs are extracted: a Forum reply
run's answer is already its post, and a run that used Principia's tools (a post, a wake) did its team work itself, so
neither spends a call from the company's budget. An extracted follow-up is filed with `externalId = xrun:<id>:<i>`, so
the chief of staff never turns a guess into a "Start …" suggestion.

### 1.3 After a run (`apply.ts`)

Once per run (`orch_run_reports`, claimed on the first terminal `run.updated`), only for runs that passed. Every
action or skip is recorded in `actions_json` and shown in the Run view.

Before the board syncs the run (`beforeSync`, wrapped around `CompanyStore.syncRun` outside the handoff wrapper, so
the task is still in flight):

- **Board report from the file:** a report delivered as a file sets `task.report` the way the harvest does for the
  fenced block (never over a report or ask set over MCP), in shadow mode too: it is the agent's own outcome.

- **Handoff:** through the existing `task_handoff` path (`AuthorBroker.taskCall` as the run's step); the handoff
  wrapper applies it right after. Not reimplemented.
- **Follow-ups that block the current task:** filed now and added as its dependency, so the run end leaves the task
  `blocked(deps)` until they are done.
- **Founder questions and blockers:** become the task's ask, so the run end parks it in Needs you. A blocker that
  needs a connection carries a `principia://connect/<id>` link ("… . Set it up: principia://connect/<id>"). Skipped
  when the agent already asked over its tools, or when the task was handed on. **A decision the agent waits for from
  a teammate** (a `decision` blocker in a report that also has a blocking question to a teammate) is the teammate's,
  not the founder's: the blocking question is sent now (§2), the decision stays out of Needs you, and the answer
  picks the task back up. If that teammate cannot be asked (no such teammate, a cap, a cycle, paused), the decision
  (or the question itself) becomes **the task's own ask** with a line saying why ("Principia: @x could not be asked
  (…), so this comes to you"): the run end parks it `blocked(needs_input)` in Needs you, and the founder's answer
  moves it to To do with "Answer: …" in its next turn, the usual way.

After the run ended (the last run hook):

- **Update post:** skipped when the only news is the wait (a blocked report whose blocking question went out, with no
  follow-ups or answers: the ask card already says it, and the board keeps the report). Otherwise the summary (and up to three pieces of
  evidence) in the seat's department channel or #general,
  posted for the agent with `ForumService.postAsAgent` (origin `principia:<run>`, shown as "via Principia"). The
  Forum's automatic post of the step's answer stands down for a task step that has a report (`deferAutoPost`), so the
  team sees one post, not two. Reply runs keep their own post (it answers the message).
- **Follow-ups:** `source:'agent'`, `externalId = run:<id>:<i>`, deduplicated against open tasks by normalised title,
  and against a task the same run already filed with `task_create` (its externalId starts with the run id; an
  "NC-8: …" prefix in the title is read as that task), at most 10 per company per hour. `agentHandle` names the
  teammate who should do it (its department follows); a name nobody in the company has is said in the action and
  never routes the work back to the asking agent (it waits unassigned). Otherwise routed with the board's rules.
  `task_create {agent}` names the teammate the same way (handle, name or role, this company only). `todo` only when the target agent is automatic and
  the company's Autopilot is on; otherwise `backlog`. Never `todo` from an extracted report. **A reply run's
  follow-up** (a person wrote to the agent in the Forum and the agent put the work in its report, e.g. without Forum
  tools) is that person's request: it goes to the replying agent unless it names someone, to To do, with the message
  quoted, once per message (skipped when the agent already filed it with `forum_reply`'s task field), and the thread
  gets the live task card "Marcus started NC-12: …" (CHAT-UI.md §8), and the task's result comes back there. The reply rules (`forum/responder.ts`) tell every harness to put asked
  work on the Board itself and never to send the person to Make task.
- **Questions to teammates:** the mailbox (§2).
- **Answers:** a reply in the ask's thread (via Principia) that answers it.
- **Facts:** memory proposals (`mem_proposal`, source `run-report`) through `SuggestionPipeline.fileRunFacts`,
  screened like harvested notes. Never written to the vault.
- **Suggestions:** listed for the founder (the chief of staff picks them up in P3-P4).

**MCP dedupe:** the agent's own Forum posts in this run (not the automatic one), teammates it already asked
(`forum_agent_wakes.from_run`), tasks already on the board, and an ask it already set are skipped.

**On the task:** one Activity line, "Principia after this run: …", lists what was done (the Run view has every
action and skip).

**Secrets:** every report string goes through the vault's redaction and then the secret shapes `team_activity` uses
(`scrubSecrets`: `sk-…`, `ghp_…`, bearer headers, JWTs…), so a key pasted into a report never reaches the Forum, the
board report, `orch_run_reports` or a teammate's prompt. The board's report harvest and the context block scrub the
same shapes. A fact that held a secret is not kept, not even as a proposal.

**Shadow mode** records what would happen (`shadow`) and changes nothing; the Forum's automatic post stays.

## 2. The mailbox (`mailbox.ts`)

`send({companyId, fromAgentId, fromRunId, fromTaskId, to, question, why, blocking})`:

1. `AgentCollab.check` applies the existing caps unchanged (self, not an agent, cycle, hops, thread, target, asker,
   company per day), with the asking run as provenance. Refusals are recorded like any other.
2. The ask card is posted as the asker, via Principia, in the target's department channel.
3. Delivery, on whatever harness the target uses: a target with a task in flight (the oldest one, when it works on
   several at once) gets the question in that task's `pendingWake` (`Dispatcher.addWake`; its next turn's inbox shows
   it); otherwise `responder.wakeForAgent` starts a short reply run, whose final answer is posted and answers the ask.
4. When the ask is answered (`ForumService.onAskAnswered`: a reply run, `forum_reply`, an `answers` entry, a person),
   the row is answered and a **blocking** question wakes the asker's task with the answer (`Dispatcher.addWake`, which
   also gives a task parked in review or blocked-by-agent its follow-up turn, under the usual guard and gates). When
   no turn starts (a manual agent, Autopilot off, the guard), a task its agent parked (`blocked(agent)`) goes back to
   To do (`CompanyStore.resumeOnAnswer`, a system move allowed only for a teammate's answer), and the task's Activity
   says who answered and what happens next ("… picks it up when you press Start").
5. A reply run that fails, is canceled or ends without answering closes the ask with why (`ForumService.settleReply`,
   `wakeFailed`), so the asker resumes instead of waiting (a quit keeps it open: the next boot asks again). Such an ask
   is `noAnswer`: a real answer that comes later still replaces it and reaches the asker, once.

**No loops across woken turns.** Each woken turn of a task is a new run, so the collab chain starts again at hop 1.
The mailbox therefore never sends a task's same question to the same teammate twice (the earlier answer is quoted in
the skip), and a task asks one teammate at most `ASKS_PER_TASK_TARGET` (2) questions in 6 hours.

**Who `to` names.** An `@handle`; else a name, a role or both, as an agent writes them ("Marcus", "Brand Voice Writer",
"Marcus, Brand Voice Writer", "Marcus (Brand Voice Writer, Marketing)"), matched against this company's roster only
(`forum/roster.ts`: every comma or bracket part must fit the same teammate; a shared role or a part that fits someone
else is no match); else a department key (its first active agent). A name nobody has is refused with the teammates to
pick from. `forum_ask_agent` and `forum_ask` read names the same way.

**Questions asked with the Forum tools pick the task back up too.** An ask an agent made from a task run with
`forum_ask_agent` (or `forum_ask` to agents only), or a question it asked by @mention (a post with a `?`), wakes the
asking task when it is answered (the ask answered, or the teammate's reply in the thread: `AgentCollab.onReplied`),
with the same Activity line and the same move back to To do. An answer the tool was still waiting for (`wait_s`,
Claude usually waits) reached the turn itself: no wake. The answer reaches the next turn once, in its wake; the
Activity line says who answered and where (the Forum thread), not the answer again. A `decision` blocker in the same
run's report is that wait (Codex often writes one after `forum_ask_agent`): while such an ask is open, or its answer
already sits in the task's wake, the decision stays out of Needs you, as for a blocking report question. A task the
dispatcher parked meanwhile says it picks the answer up once Unparked.

Both paths (this and `forum_ask_agent`) write `forum_agent_wakes`; mailbox rows use via `report`.

## 3. The chief of staff (`coordinator.ts`, `coordinatorRules.ts`, `coordinatorCall.ts`)

One per company, between runs, the same on every harness. Serialised per company (a promise chain, like the
dispatcher).

**Events:** `run_ended` (after the applier, once per run), `task_created` and `task_done` (the board hooks and
`approve`), `ask_answered` (a Forum ask or a task answer), `forum_human_post`, and a daily `tick` (checked hourly).
Debounced 2 minutes into one batch per company, at most 10 minutes after the first event. **No self-retrigger:**
while it acts on a company that company's events are dropped, and the tasks it files carry `externalId orch:<id>:<i>`,
so a later event about them is dropped too.

**Gates, in order:** the setting (the company's mode on, coordinator not off, the board on); the company is not
paused; it is under its monthly cap (this month's value, Principia's own calls included); and, for the model only,
the company's daily budget (`orch_budget`, shared with the fallback extractor). A used-up budget or a failed call
means rules only for that batch, and the batch says so.

**Rules first** (`coordinatorRules.ts`, pure):

| when | then |
|---|---|
| a task is done and others waited for it | `pump` |
| Principia filed a follow-up for an agent who waits to be started (or Autopilot is off) | `suggest` starting it |
| run reports suggested the same routine 3 times in 14 days | `suggest` the routine |
| a run needs a connection (a blocker or a suggestion with a connection id) | `suggest` the connection |
| a run report suggests a task | `suggest` the task |
| the daily tick, something happened, no digest in 20 hours | `digest_post` |

What rules cannot decide is "ambiguous": a person posted, a run made progress with no next step, a done task left an
automatic agent with nothing to do. **Only then, and only in model mode** ("Let Principia decide next steps with
AI"), one cheap call (`coordinatorCall.ts`: routeCall conventions, no tools, empty cwd, the founder's own Claude or
Codex login, haiku or low effort, JSON out, 90 s) proposes more decisions. One model call at a time for the app.

**The closed set of verbs**, checked in code for every decision, from rules or the model:
`pump`, `wake_task` (Dispatcher.addWake), `ask_agent` (the mailbox, so the collab caps apply), `file_task`
(To do only for an automatic agent with Autopilot on, else Backlog; deduplicated by title; 5 per hour), `suggest`
(Needs you) and `digest_post` (Principia's own line in the Team room, once a day). Anything else is refused with the
reason: spending, publishing, external messages, deleting, approving or closing tasks, creating companies or
departments. **A manual agent's work is only ever suggested** (`wake_task` on its task becomes a suggestion; a task
filed for it also gets one).

**Activity:** each batch that decided something (or has a note: the AI step was skipped or failed) is a row of
`orch_decisions`; a batch with nothing to do leaves no row. A batch acts on at most 12 decisions; the rest are written
down as skipped ("left for the next one"), never dropped. A row holds its events, rules or model, every decision and what happened,
and the tokens. The tasks it touched get an Activity line "Principia (chief of staff): …", and Team & autonomy lists the
latest batches ("What Principia did lately", `orchestrator:decisions`).

**Usage:** the coordinator's and the extractor's calls are rows of `orch_usage` (usage source `orchestrator`); Spend
shows them as one "Principia (chief of staff)" row per company, and the monthly cap counts them.

**Shadow mode** records each decision as `shadow` and changes nothing.

### 3.1 Suggestions in Needs you (`suggestions.ts`)

Three kinds, each with one button and "Not now":

- **Routine:** "Make it a routine" creates the schedule (task mode, for the agent) at the founder's click. A routine
  idea that is one of the ready-made routines (`shared/routines.ts`: morning brief, weekly review, inbox triage, social
  drafts, pull requests digest, code brief) is not made twice: "See the routine" opens
  `principia://automations/routines?add=<id>` (with the suggested time when it differs), where the founder presses
  Turn on, and a ready-made routine that is already on (`Settings.routines`) is never suggested.
- **Connection:** "Set it up" opens the connection's card (`principia://connect/<id>?company=…`, `shared/deepLink.ts`;
  a tool Principia has no card for opens "Add your own MCP server"), shown as a link button.
- **Next step:** "Start it" starts a task a manual agent waits on (a human start), or "Add to To do" files it.

A fingerprint per suggestion (the task, the connection, else the normalised title): never two open at once, and 14
days after the founder dismissed or accepted one before it may come back. At most 3 new suggestions per company per
day. A task suggestion whose task moved on leaves Needs you by itself. Open suggestions count in every Needs you
number: the rail and sidebar badges, the status bar, Home and the Phone (where they show as "Idea", decided on the
Mac).

**A batch Principia skips** because the company is paused or at its monthly cap leaves one line in Activity saying so
(at most once every 6 hours per reason).

## 3b. Refused in code

Principia's layer never spends money, publishes, sends external messages, deletes, approves or closes tasks, or
creates companies or departments. The chief of staff's verbs are the closed set above. The applier's verbs are posting in the company Forum, filing tasks
(backlog-first), the existing handoff, asking teammates under the collab caps, setting the task's ask, and filing
memory proposals. Report text is data throughout: posts and tasks are redacted by the store, facts go to review,
task creation is capped.

## 4. Setting

```ts
Settings.orchestrator = { mode: 'off'|'shadow'|'on', coordinator: 'off'|'rules'|'model', cli: 'auto'|'claude'|'codex',
  callsPerDay: 20, extractFallback: boolean,    // default: on, rules, auto, 20, true
  companies?: Record<companyId, { mode?: 'off'|'on', coordinator?: 'off'|'rules'|'model', callsPerDay?: number }> }
```

`orchestratorFor(raw, companyId)` is the setting one company runs with. This company > Team & autonomy > "Principia
runs the team" writes `companies[id]` (merged company by company): the on/off switch, "Let Principia decide next
steps with AI" (`coordinator: 'model'`) and "AI calls per day". Shadow mode stays an app-wide debugging switch.

## 5. Observability

- Run view: "Principia after this run" (`orchestrator:forRun`): the report source and each action or skip.
- Forum: posts and asks Principia made read "via Principia"; the Agent talk panel shows mailbox wakes (via report).
- Activity: the chief of staff's batches (`orch_decisions`) on the tasks they touched and in Team & autonomy.
- Forum: the daily digest is a line in the Team room read as "Principia (chief of staff)".
- Spend: "Principia (chief of staff)" (`orch_usage`).
- Tables: `orch_run_reports`, `orch_mailbox`, `orch_budget`, `orch_decisions`, `orch_suggestions`, `orch_usage`.

## 6. Files

New: `src/shared/orchestrator.ts`; `src/main/orchestrator/{runReport,extract,context,apply,mailbox,coordinator,
coordinatorRules,coordinatorCall,suggestions,usage,wire}.ts` with tests; `src/renderer/src/lib/orchestrator.ts`,
`src/renderer/src/components/orchestrator/PrincipiaTeam.tsx`; `__tests__/world.ts` (real board, Forum and layer over a fake engine), `orchestrator.integration.test.ts`;
`src/main/handlers/orchestrator.ts`; `src/main/engine/__tests__/orchestratorContext.test.ts`.

Report text (a file never went through the step's output redaction) is passed through the vault's redaction.

Changed: `engine/executor.ts` (`withPrincipia`, the report env), `engine/env.ts` (`runReportPath`), `shared/engine.ts`
(`EngineContext.orchestrator`), `company/reportHarvest.ts` (both fences), `company/dispatcher.ts` (`addWake`),
`forum/service.ts` (`postAsAgent`, `postAsPrincipia`, `postsOfRun`, `deferAutoPost`, `onAskAnswered`), `forum/collab.ts` (via `report`,
`originRunId` provenance, a `deliver` option), `forum/store.ts` (`via`, an origin and opKey for system lines), `usage/summary.ts` (the Principia row), `memory/vault/suggest/index.ts`
(`fileRunFacts`), `shared/passport.ts` (source `run-report`), `db/schema.ts`, settings, IPC, Run view, Forum message.

Not touched: `adapters.ts`, `taskToolDefs.ts`, `taskTools.ts`, `author/*`, `memory/server/tools.ts`. Connect and
routine links come from `shared/deepLink.ts`. Codex has the task tools over MCP too (push-features), so the MCP dedupe
above applies to both harnesses.

## 7. Not yet (P5)

Trimming the task-kind "must call X" rules in `principiaOps.ts` (the context block replaces "Before starting:
team_board").
