# Contributing

Principia is a desktop and self-hosted cloud workspace for agent sessions, shared company tools, workflows and schedules. Some internal names remain Hive for compatibility.

## Run locally

Use an Apple Silicon Mac and Node.js 24. Install at least one supported agent CLI and sign in through that CLI if you want to exercise real agent sessions.

```sh
npm ci
HIVE_USER_DATA=/tmp/agent-workspace-contrib HIVE_NO_SCHEDULER=1 npm run dev
```

Use a separate data directory while developing. It prevents development changes from affecting your usual sessions, keys and schedules. Do not connect production Slack workspaces or use customer repositories for reproduction examples.

## Pick a change

Start with a reproducible bug, a documentation improvement or an issue labelled `good first issue` or `help wanted`. For a large feature, describe the problem and proposed behavior in an issue before implementing it.

Useful areas include terminal accessibility, provider compatibility, workflow error messages, onboarding and portable workflow examples. Use fictional names and temporary repositories in examples and screenshots.

## Send a pull request

Explain the problem, the resulting behavior and how you verified it. Include a screenshot for visible UI changes. Keep unrelated changes in separate pull requests.

```sh
npm run typecheck
npm test
npm run build
```

Run tests relevant to your change. Some database tests require native modules built for the test runtime; report skipped tests rather than treating them as verified. Real agent and connector checks can consume subscription quota or contact external services: use an isolated test setup and describe those checks explicitly.

## Project map

- `src/main/engine`: provider adapters, workflow execution and scheduling.
- `src/main/sessions.ts`: interactive terminal sessions.
- `src/main/connectors`: external integrations.
- `src/renderer/src`: React interface and terminal panes.
- `src/shared`: types and IPC contracts.
- `docs/CONTRACT.md`: interfaces and behavior contracts.

Preserve permission boundaries, subscription authentication defaults and secret redaction. Never attach tokens, environment files, local databases, private transcripts or customer data to an issue or pull request. Report security problems privately through GitHub's vulnerability reporting feature when enabled; do not disclose credentials in public issues.
