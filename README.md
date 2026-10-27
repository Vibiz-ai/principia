<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/brand/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="resources/brand/banner-light.png">
    <img alt="Engraving of a Roman triumphal arch with the sun rising through its central archway" src="resources/brand/banner-light.png" width="100%">
  </picture>
</p>

# Principia

[Website](https://useprincipia.com) · [GitHub](https://github.com/Vibiz-ai/principia) · [Contribute](CONTRIBUTING.md) · [Cloud setup](cloud/README.md) · [Report a vulnerability](SECURITY.md)

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Vibiz-ai/principia/badge)](https://scorecard.dev/viewer/?uri=github.com/Vibiz-ai/principia)

**Run your entire company. From one workspace.**

Principia brings agent sessions, company tool connections, memory, workflows and schedules together. Use Claude Code and Codex in the same workspace, keep context when changing harnesses, and run work on your Mac or a self-hosted cloud worker.

This is an early open-source release. The desktop app targets Apple Silicon macOS. The cloud runner is experimental and intended for one trusted operator, not a public multi-tenant service.

![Principia agent canvas — example workspace](website/public/principia-agents.png)

*Current interface with sample data. [Explore the connection catalog](website/public/principia-connections.png).*

## What works today

- **Agent sessions:** terminal panes for installed coding CLIs, with Claude ↔ Codex handoffs carrying available conversation context and recent output.
- **Workflows:** agent, shell, reviewer, room, wait and notification nodes; local scheduling and run history. Usage-limit failures can try other installed harnesses.
- **Shared MCP connections:** configure stdio or Streamable HTTP tool servers once in Principia for Claude and Codex, scoped to selected project folders or all projects. Desktop credentials are encrypted. Remote services can use managed browser OAuth sign-in, including Mobbin.
- **Memory:** project knowledge and provenance with review/edit controls. Provider support varies; brief injection is used where direct memory MCP support remains unverified.
- **Artifacts and visibility:** outputs, live agent activity, a workflow editor and a canvas with an expandable parent/subagent hierarchy alongside the workflow execution view.
- **Cloud and phone control:** a self-hosted Linux container with an authenticated API, persistent job/run storage, CLI execution, workflow import and optional Telegram control.

The ambition is a workspace for operating one company or a thousand, with agents carrying work from start to finish and people setting the direction. Today’s preview provides the execution foundation: agents, shared MCP connections, workflows, schedules, and project memory. Full multi-company administration and autonomous operation at that scale remain roadmap work.

**Passport** is the name for the portable company memory we’re building toward: company identity, knowledge, decisions, and working context that can be imported into a workspace or selectively shared with compatible services alongside sign-in. Project memory exists today; Passport import/export and sign-in integration are planned.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/brand/scribe-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="resources/brand/scribe-light.png">
    <img alt="Engraving of a Roman scribe writing on a scroll at a stone desk, columns behind him and the city through an arched window" src="resources/brand/scribe-light.png" width="80%">
  </picture>
</p>

The broader company toolbox is intended to cover databases, image generation, web research and scraping, connections, phone, and email. Compatible MCP tools can be connected today; dedicated setup for these categories is on the roadmap.

## Desktop quick start

**Download:** [Principia for Mac, preview](https://github.com/Vibiz-ai/principia/releases/download/v0.1.0-preview.1/Principia-0.1.0-preview.1-arm64.dmg) (Apple Silicon, macOS 13 or later; [release notes and checksums](https://github.com/Vibiz-ai/principia/releases/tag/v0.1.0-preview.1)). It is not yet signed with an Apple Developer ID: the first time, open it through System Settings › Privacy & Security › **Open Anyway**. It cannot update itself; Principia says when a new version is out. Signed, auto-updating builds come soon.

Or build from source. Requirements: Apple Silicon macOS, Node.js 24 and at least one installed agent CLI. Authenticate that CLI separately with your account. Workflows using GitHub CLI also need `gh auth login`.

```sh
npm ci
npm run dev
```

Use isolated data for development:

```sh
HIVE_USER_DATA=/tmp/principia-dev HIVE_NO_SCHEDULER=1 npm run dev
```

Build the desktop package:

```sh
npm run build
npm run dist
```

`npm run dist` makes an unsigned local package. Signed, notarized releases with automatic updates are made with `npm run release:mac`: see [Releasing](docs/RELEASING.md). Internal `HIVE_*` variables, `.hive.json` workflow files, data paths and some identifiers remain for compatibility with the earlier Hive prototype. Existing local data is not renamed or uploaded by this release.

## Connect company tools once

Open **Settings → Connections → Company connections**. Choose **Connect Mobbin** or **Add connection**, enter a server URL, and select the projects allowed to use it or choose All projects. Sign in through your browser, or choose an API key/local server configuration. New Claude and Codex sessions and workflow steps receive a Principia bridge automatically.

Principia owns the connection; harness account logins remain separate. The gateway currently proxies tools, not MCP resources, prompts or sampling. It preserves harness approval policies. Read [MCP setup and permissions](docs/MCP-GATEWAY.md).

## Run from your phone

**iPhone app.** A native app watches your agents and keeps the work going from your phone: pair it with Principia on your Mac (Settings › App › Phone), or try a sample company without a Mac. Public TestFlight link: coming soon. <!-- TESTFLIGHT_LINK: replace "coming soon" with the public link (https://testflight.apple.com/join/…) once the first build is approved; docs/IOS.md, TestFlight --> Build it yourself: [docs/IOS.md](docs/IOS.md).

**Self-hosted worker.** Deploy the worker on an always-on Linux server with Docker, persistent storage and agent CLIs authenticated in that environment. Telegram long polling receives your commands without exposing a public webhook.

```sh
cp cloud/.env.example cloud/.env
# Configure a random PRINCIPIA_API_TOKEN and optional Telegram credentials/allowlists.
docker compose -f cloud/compose.yml up -d --build
```

Agent login and repository checkout are separate setup steps. The desktop Keychain cannot be copied to a Linux container. Read [cloud deployment and phone setup](cloud/README.md), including permissions, authentication and workflow limits, before starting a live worker.

This repository ships deployment configuration; it does not include a hosted account or preconfigured live bot.

## Contribute

We welcome reproducible bug reports, harness compatibility fixes, accessible UI improvements, reusable workflow examples and help with cloud execution. Read [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run cloud:build
npm run cloud:test
npm run release:test
```

Some native database tests need an appropriate Node/Electron ABI. See the contribution guide and cloud smoke command for verification details.

## Architecture

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/brand/aqueduct-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="resources/brand/aqueduct-light.png">
    <img alt="Engraving of a Roman aqueduct carrying its arches across a valley to the horizon" src="resources/brand/aqueduct-light.png" width="80%">
  </picture>
</p>

| Directory | Purpose |
| --- | --- |
| `src/main/engine` | Shared workflow execution, provider adapters, retries and scheduling |
| `src/main/gateway` | Desktop MCP broker, scoped grants and stdio bridge |
| `src/main/sessions.ts` | Desktop interactive PTY sessions |
| `src/renderer` | React desktop interface |
| `src/cloud` | Headless adapter for the shared workflow engine |
| `website` | React + TypeScript + Tailwind install and product page |
| `cloud` | Cloud API, prompt runner, Telegram control and containers |
| `src/shared` | Domain types and IPC contracts |

The desktop renderer is sandboxed, uses typed IPC and has no production network listener. Agent CLIs and connected tools communicate with their providers. The cloud worker is a separate authenticated server; run it in an isolated environment with only the repositories and credentials it needs. Project folder scopes are application access controls, not an operating-system sandbox for arbitrary code.

## License

[MIT](LICENSE).

### Marketplace

Browse **Marketplace** in the desktop sidebar for reusable workflows, skills, scripts and agents. Search by task or use case, inspect what an item does, then install it. Workflows open as editable copies; installation does not start a run. Skills and subagents currently install for Claude Code. You can also add an HTTPS community catalog in Settings → Data.

Want to share a company capability? See the [Marketplace contribution guide](resources/marketplace/README.md).
