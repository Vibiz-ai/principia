# SKILLS.md: skill packs per agent role (PR-49, proposal)

Status: **proposal, waiting for the founder's OK. Nothing here is built yet.**

The ask: every agent should know its field well. A content writer should know how to write a launch post, and a repo auditor how to review a PR. Some of that know-how ships built in, and the founder can add or edit the rest.

## 1. What exists today (inventory)

| Piece | Where | What an agent gets from it |
|---|---|---|
| Agent instructions | `CompanyAgentData.instructions` (≤ 4000 chars, `src/shared/company.ts`), edited on the agent page › Instructions | Pasted into `<principia-role>` on every task turn (`src/main/company/taskPrompt.ts` `buildTaskPrompt`), Forum reply (`src/main/forum/responder.ts`) and chat (`src/shared/agentChat.ts`). This is the **only** role-specific text an agent gets today. |
| Onboarding role presets | `src/shared/onboardingPlan.ts` (`auditor`, `siteBuilder`, `writer`, `researcher`, `supportDrafter`, `generalist`), roles in `PLAN_AGENT_ROLES` | Seeds the instructions once at hire. The **role is not stored** on the agent afterwards (`CompanyAgent` has no `role` field). |
| Department charter | Department `does / doesNot` and the Passport department note | Sent as Passport context and used for routing. It is not how-to knowledge. |
| Marketplace skills | `resources/marketplace/skills/*/SKILL.md` (customer-brief, launch-checklist, meeting-actions, firecrawl, fal-image, screenshot-to-code), installed by `src/main/marketplace.ts` | Written to the founder's **global** `~/.claude/skills`. Every Claude session on the Mac gets them, not one agent. Codex, Cursor and Gemini never see them. |
| Principia's own skill folder | `src/main/diagrams/visualizeSkill.ts`: `<userData>/claude-skills/.claude/skills/visualize`, passed with `--add-dir` | Only in **interactive** chat panes. Headless task runs (`claudeAdapter` non-interactive args in `src/main/engine/adapters.ts`) never get it. |
| Library tab on an agent | `AgentPanel.tsx` `AgentLibrary` | What the agent produced (files, drafts, notes). It is not skills. |

The gap: role know-how has to fit into one 4000-character instructions box, written by hand, with no defaults per role. The skills that do exist are global and Claude-only. Background task runs (where most of the work happens) get no skills at all.

## 2. Proposal

### 2.1 A skill is a SKILL.md, the format Claude Code already uses

```
---
name: launch-post
description: Write a launch post for X, LinkedIn or Show HN. Use when asked for a launch or announcement post.
roles: [content]            # Principia-only: which roles get it by default
---
# Steps, checklists, examples, house rules…
```

We keep the standard format, so a Marketplace skill, a skill from the web, or one the founder writes all work the same way. Claude only loads a skill's body when the work needs it. Only the one-line `description` sits in context, so ten skills cost almost nothing until one is used.

### 2.2 Where skills live

- **Built-in packs** ship in `resources/skills/<role>/<name>/SKILL.md`. They are read-only and refreshed with each release. A first set of about 3 per role:
  - **developer / repo auditor:** `review-pr` (correctness first, small safe diffs, tests with every fix), `bug-triage` (reproduce, root cause, regression test), `release-notes`
  - **content writer:** `launch-post` (X / LinkedIn / Show HN shapes), `blog-post` (outline, hook, CTA, SEO basics), `brand-voice-check` (reads the company's Brand voice Passport note and rewrites to it)
  - **researcher:** `competitor-brief`, `source-and-cite`
  - **support:** `reply-draft` (empathy, the answer, the next step; never promise refunds), `bug-report-from-ticket`
  - **generalist / ops:** `weekly-review`, `checklist-from-process`
- **Company skills** live in the company's data folder (`<userData>/companies/<id>/skills/<name>/SKILL.md`). The founder creates or edits them in the app. "Edit" on a built-in makes a company copy that overrides it. Marketplace skills can be installed here ("for this company") as well as globally.

### 2.3 How a skill attaches to an agent

- New field `CompanyAgentData.skills: string[]` (skill names) plus `role?: PlanAgentRole`, which is stored at hire. Agents hired before this change get a role guessed from their name or department, which the founder can change.
- By default an agent gets its role's built-in pack. On the agent page, a new **Skills** section (under Instructions) lists them with on/off switches, plus "Add skill…" (from built-ins, company skills, or "Write a new one").
- **At spawn:** Principia builds one folder per agent, `<userData>/agent-skills/<agentId>/.claude/skills/…`, holding the agent's skills, and passes it with `--add-dir`. This is the same mechanism `/visualize` already uses, and it now works for **headless task runs too**. Skills stay scoped to the agent and never touch `~/.claude`.
- **Codex / Cursor / Gemini** have no skill loader. They get a short "Your skills" index (name + description + file path) in the role block, and can read a file when they need it.

### 2.4 Safety

- A skill is text the agent follows, like instructions. Built-ins are reviewed in this repo. Company skills are the founder's own. Marketplace and remote skills show their full text before install (as today).
- Skills never change permissions, tools or keys. The task rules footer still wins over anything a skill says.
- The size cap per skill (64 KB) and per agent (20 skills) keeps prompts small.

## 3. Build plan (after the OK), in small PRs

1. `role` + `skills` on `CompanyAgentData`, defaults by role, and a migration that guesses roles for existing agents. Tests.
2. A per-agent skill folder plus `--add-dir` on headless and interactive Claude runs, and the index fallback for the other CLIs. Tests on the spawn args.
3. The built-in packs above (content writer and repo auditor first).
4. A Skills section on the agent page, plus a company skill editor. Marketplace gets an "Install for this company" option.

## 4. Questions for the founder

1. Is the built-in starting set above right, or should some roles come first?
2. Should company skills be editable in the app only, or also as files in a folder you can open in Finder (or both)?
3. Should agents be able to *propose* a new skill (for example after a task taught them something), for your Approve, like hires?
