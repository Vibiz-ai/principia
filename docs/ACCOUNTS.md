# Accounts: sign in once, every cloud run is signed in

Agents on your Mac use your own sign-ins: the Claude Code and Codex CLIs, `gh`, and the keys in **Keys**. A cloud
machine starts with none of them, and the macOS Keychain cannot be copied to it. This document explains how
Principia gets those accounts into the cloud without asking you to sign in on every machine, and where that design
goes next.

## 1. What you do

1. Connect a cloud (**Cloud** › paste the connect link).
2. On **Keys**, under *Accounts*:
   - **Claude**: *Connect Claude* (one browser sign-in on this Mac; a long-lived token goes to the cloud).
   - **Codex**: *Sign in with ChatGPT* (a second sign-in just for the cloud; Codex on this Mac stays signed in).
   - **GitHub**: *Use This Mac’s GitHub* (reads the token `gh` already holds), or paste a fine-grained token.
3. On each **Shared** key the cloud should have, switch on *In the cloud*.

That is all. Every run in the cloud, for every company, gets these accounts. Removing one here removes it there.

## 2. What each account becomes in a run

| Account | Stored in the cloud as | A run gets it as |
| --- | --- | --- |
| Claude | `credentials` (adapter `claude`), AES-256-GCM | `CLAUDE_CODE_OAUTH_TOKEN`, only for steps that run Claude |
| Codex | `credentials` (adapter `codex`), the `auth.json` | a 0600 `$CODEX_HOME/auth.json`; refreshed tokens are written back after the run |
| GitHub | `credentials` (adapter `github`) | the repo token for clone and push (through `GIT_ASKPASS`, never argv or the remote URL) for repos without a token of their own, and `GH_TOKEN` / `GITHUB_TOKEN` for `gh` and the API |
| Shared keys | `workspace_secrets` | environment variables |
| Company keys | `company_secrets` | environment variables; a company key wins over a Shared key of the same name |

Precedence in a run's environment, lowest first: GitHub (`GH_TOKEN`, `GITHUB_TOKEN`), then Shared keys, then the
company's own keys. So a company that needs a different GitHub token sets its own `GH_TOKEN`.

## 3. Why it is built this way

**Values go up, never come back.** Every credential is write-only: the cloud returns names, logins and dates, never a
value. A value exists in plaintext only inside the run that uses it (memory, a 0600 file in the run home that is
deleted afterwards). The redactor is primed with every stored value at boot, so a value that shows up in a log, a step
title or an answer is masked.

**Separate credentials for the cloud.** Claude and Codex mint a *new* sign-in for the cloud (`claude setup-token`, a
second ChatGPT login in a throwaway `CODEX_HOME`) instead of copying the Mac's. Revoking the cloud's sign-in never
signs this Mac out, and the reverse. GitHub reuses the `gh` token because `gh` has no equivalent. That is why pasting
a fine-grained token limited to a few repositories is offered right next to it, and is the safer choice.

**The Mac is the source of truth for Shared keys.** `settings.cloudKeys` lists the Shared keys this Mac keeps in the
cloud. Changing, importing, moving or deleting one syncs at once (when it is marked). Pairing pushes them right away,
and `cloud:keysSync` repeats it on demand. A sync only touches keys this Mac marked. A second Mac paired to the same cloud keeps its
own keys there.

**Refresh tokens are never used twice at once.** Codex rotates its refresh token. The queue never runs two jobs on the
same Codex sign-in at once (`credential_lock`), and the refreshed `auth.json` is written back after each run. A
write-back for a sign-in you replaced meanwhile is dropped as stale.

## 4. Where the code is

- Contract: `src/shared/cloud.ts` (`CloudAccounts`, `CloudAccountsView`, `GITHUB_TOKEN_RE`, routes `accounts`,
  `githubAccountPut/Delete`, `sharedSecretPut/Delete`).
- Cloud: `src/cloud/control/accounts.ts`, which builds GitHub and Shared-key materials. `queue.ts` merges them into a
  run's secrets. `companies.ts` falls back to the GitHub account for repos that have no token of their own, and counts
  Shared keys and the GitHub variables when checking whether a company is ready. Migration 3 adds `workspace_secrets`.
- Mac: `src/main/cloud/accounts.ts` (`CloudAccountsSync`), `ghToken` in `src/main/onboarding/github.ts`, IPC
  `cloud:accounts`, `cloud:githubConnect`, `cloud:githubRemove`, `cloud:keyCloud`, `cloud:keysSync`.
- UI: `src/renderer/src/components/cloud/CloudAccess.tsx` on the Keys page.
- Tests: `src/cloud/control/__tests__/accounts.test.ts` (end to end through HTTP, including "no value in any response,
  log or text column") and `src/main/cloud/__tests__/accounts.test.ts`.

## 5. Next: many machines, and Macs

Today the control plane and the agent runtime share one container. The contract between them
(`src/cloud/contract.ts`) was cut so the runtime can move to separate machines. That design suits accounts well,
because **a machine never stores an account; it receives the materials for one run**:

1. **One microVM (or Mac VM) per run or per workspace.** The control plane keeps the vault and builds `RunMaterials`
   per run, exactly as now. A worker receives them over mTLS, materializes them in the run home, and wipes them at the
   end. A compromised machine holds at most the accounts its own run needed, for as long as that run lasted.
2. **Short-lived GitHub tokens.** Replace the stored token with a GitHub App (the contract already has
   `RepoMaterial.token` described as "a GitHub App installation token (1 h)", and `github_app` is reserved). The cloud
   mints a 1-hour token scoped to the run's repositories, and nothing long-lived ever reaches a machine.
3. **Secrets the agent never sees.** For HTTP APIs, an egress proxy on the worker adds the `Authorization` header on
   the way out, so a prompt-injected agent cannot print the key. CLI sign-ins (Claude, Codex) still need their file
   or variable, which is why they stay per-run and separate from the Mac's.
4. **macOS workers.** A Mac VM worker (Apple Virtualization, two VMs per host) takes the same `RunMaterials`. Two
   things differ. Keychain-only tools are told to use file storage, as Codex already is. Apple accounts use an App
   Store Connect API key (a Shared key), never an Apple ID session.
