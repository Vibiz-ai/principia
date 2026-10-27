# Principia launch and contributor plan

Audit date: **19 October 2026**. This is a proposed execution plan; no launch submissions, outreach, issues, or releases were created by this audit. Repository metrics below are a point-in-time snapshot, not traction forecasts.

## Public repository status

| Item | Verified public state | Evidence |
| --- | --- | --- |
| Repository | Public, `Vibiz-ai/principia`, default branch `main` | [Repository](https://github.com/Vibiz-ai/principia) |
| Stars / forks | **1 star / 0 forks** | Public repository API, checked 19 October 2026 |
| Open issues / PRs | **0 open issues / 0 open PRs** | [Issues](https://github.com/Vibiz-ai/principia/issues), [pull requests](https://github.com/Vibiz-ai/principia/pulls) |
| License | MIT recognized by GitHub | [License](https://github.com/Vibiz-ai/principia/blob/main/LICENSE) |
| CI | Latest three runs succeeded; two earlier initial runs failed | [Actions](https://github.com/Vibiz-ai/principia/actions) |
| Latest verified CI | `1659b36`, success, verified 19 October 2026 | [Run](https://github.com/Vibiz-ai/principia/actions/runs/39262076753) |
| CI coverage | Dependency install, TypeScript, tests, desktop build, cloud build/tests/smokes, release-source checks | [Job steps](https://github.com/Vibiz-ai/principia/actions/runs/39262076753/job/118029834866) |
| Releases / app downloads | **No GitHub releases** returned by the releases API; therefore no release-attached Mac installer or release download count to report | [Releases](https://github.com/Vibiz-ai/principia/releases) |
| User setup docs | README with source quick start, shared connections and self-hosted cloud setup | [README](https://github.com/Vibiz-ai/principia/blob/main/README.md), [cloud guide](https://github.com/Vibiz-ai/principia/blob/main/cloud/README.md) |
| Contributor foundation | CONTRIBUTING, SECURITY, bug/feature forms, PR template and MIT license are published | [Contribution guide](https://github.com/Vibiz-ai/principia/blob/main/CONTRIBUTING.md), [security policy](https://github.com/Vibiz-ai/principia/blob/main/SECURITY.md) |
| Demo / onboarding | Product screenshot now embedded in README; React product/install page source published in `website/` with a public [landing page](https://useprincipia.com). An unsigned Mac preview (v0.1.0-preview.1, a GitHub pre-release) is the download until the first signed release; building from source still works | [README](https://github.com/Vibiz-ai/principia/blob/main/README.md) |

These counts were read with GitHub CLI/API. They do not establish unique users, successful installations, retention, customer demand, or independent contributors. Passing CI also does not establish a signed/notarized Mac release or successful OAuth consent with every provider.

## Positioning: broad vision, concrete first reason to try

**Vision:** run an entire company, or a portfolio of companies, from one workspace. Agents carry out the work using connected tools and shared context. Supporting a thousand companies autonomously is an ambition, not a validated capability of the preview.

**Launch message:** “Run your entire company. From one workspace.”

**Supporting story:** agents, a company toolbox (databases, image generation, scraping, connections, phone and email), and **Passport**, our name for planned portable company memory. Clearly label roadmap categories and Passport portability/sign-in integration; demonstrate existing workflows, shared MCP connections and project memory separately.

First audience: technical founders and small software teams already using both coding CLIs on an Apple Silicon Mac. They already understand the tools and can recognize the pain of repeating context, reconnecting services and manually checking runs. Start with those users before claiming to serve every department or nontechnical business owner.

The first demo should prove three things in one continuous recording:

1. Connect a company MCP service in Principia and choose the project allowed to use it.
2. Do a small useful job in Claude, then continue it in Codex with available context and the same connection.
3. Show the resulting artifact and run history, so viewers can inspect what happened.

A separate short cloud demo can show an authenticated API request creating a job on a self-hosted worker. A dedicated browser workspace is the intended remote interface; Telegram is optional. Label self-hosting, separate cloud authentication and experimental status clearly. Do not imply an available managed cloud service, perfect cross-harness memory, or replacement accounting/payroll functionality.

## Readiness gates before broad distribution

| Priority | Deliverable | Owner | Acceptance evidence |
| --- | --- | --- | --- |
| P0 | Publish an Apple Silicon Mac prerelease installer with checksums, exact version and limitations | Release maintainer | A stranger downloads the release asset and opens the app on a fresh supported Mac |
| P0 | Decide signing/notarization path; document unsigned early access honestly if shipping that way | Release maintainer | Tested first-open instructions; no blanket instructions to disable macOS protections |
| P0 | Test first-run agent detection, missing login help and a complete first workflow | Product maintainer | Three independent testers each produce one artifact without developer debugging |
| P0 | Verify one full real OAuth sign-in and tool call with a willing tester; verify Claude and Codex can both use it | Gateway maintainer | Recorded successful consent + tool calls; automated mocks and discovery checks alone do not satisfy this gate |
| P0 | Record a 45–60 second clean demo; add three screenshots and an obvious download/start path | Founder | README answers what it is, who it is for, and how to try it above the long architecture material |
| P0 | Create five genuinely scoped starter issues | Maintainer | Each issue has context, affected files, expected behavior, validation and a reviewer |
| P1 | Offer a safe sample repository and one workflow requiring no extra paid service | Engine maintainer | New user can reproduce the demo and inspect its output without connecting production company data |
| P1 | Test cloud setup on a clean Linux host, including restart, auth, allowlists and recovery | Cloud maintainer | Repeatable documented result; container build success alone is insufficient |

A source-only preview can recruit technical testers now. Complete P0 before treating Show HN/Product Hunt as a broad launch. Signing may remain an openly disclosed preview limitation, but install friction must be observed rather than guessed.

## Four phases

### Phase 1 — establish activation, days 1–7 after the release candidate

Work with **10 consenting testers**, recruited from people who already use Claude/Codex. Invite personally through existing relationships; do not automate unsolicited messages. Offer an optional 20-minute setup session. Give everyone the same sample task so failure patterns are comparable.

Target: at least **7/10 install and complete one useful job**, median time to first artifact under **15 minutes**, and **4/10 return for another job within seven days**. These are decision targets, not expected outcomes. Record setup failures separately from model/provider failures.

If fewer than half activate, pause distribution and fix the two most common setup failures. If people activate but do not return, interview them about what work they actually want to delegate before adding more integrations.

### Phase 2 — demonstrate in relevant communities, days 8–14

Publish one honest founder demo on X and a detailed GitHub release note. Ask which part of the workflow people would use, and link the sample task and download. Reply to installation problems promptly. Turn repeat questions into documentation and reproducible issues.

Choose **one relevant Reddit community** after checking its current rules in the actual community. Share a concrete technical walkthrough, disclose that you built it, and ask for specific feedback. Do not cross-post identical promotion into many communities or solicit votes. Community-rule pages were not fully readable in this audit, so no subreddit permission is assumed. [Reddit's official spam policy](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam) prohibits repetitive unsolicited promotion and defers additional restrictions to moderators.

Target: **25 additional successful first jobs**, **five substantive bug reports**, and two community members who return to discuss a second use case. Track which channel brought each consenting tester; raw impressions and stars are secondary.

### Phase 3 — Show HN, after first-run success is established

Suggested title: **“Show HN: Principia – shared tools and workflows for Claude and Codex”**.

Submit the repository or direct working download path. Write a first comment explaining the personal problem, the specific implementation, what works, what remains rough, and why project-scoped shared MCP matters. Be present to answer technical questions and publish fixes. Show HN asks for something people can actually try, discourages signup barriers, and prohibits asking friends to upvote/comment. A landing page alone is unsuitable. [Official Show HN rules](https://news.ycombinator.com/showhn.html).

Target: **50 new successful first jobs**, response to new reproducible issues within **one business day**, and **two external pull requests**. If it gets little attention, continue improving activation rather than repeatedly resubmitting the same launch.

### Phase 4 — Product Hunt and repeatable distribution, weeks 3–6

Use Product Hunt when the release and onboarding are understandable to less technical operators. Prepare two or more useful gallery images, a plain-language tagline, a direct product/download URL and a maker comment. The official guide allows self-submission, excludes shortened/tracking URLs as the primary product URL, and asks for feedback rather than upvotes. [Product Hunt launch guide](https://www.producthunt.com/launch/preparing-for-launch).

Suggested tagline: **“Shared tools and workflows for your AI agents”**.

Publish a weekly example showing a real business task: reviewing a PR, preparing a sourced competitor brief, or running a recurring report. Each example should include an importable workflow, expected output, prerequisites, permission needs and failure cases. Choose these by user demand, not by how many nodes the editor can display.

Target by day 30: **100 cumulative activated users**, **20 weekly active operators**, **five external contributors** and **three merged external PRs**. Count real people separately from bots and the founding team. These are ambitious planning targets, not forecasts or launch guarantees.

## Turn users into contributors

Create a small public roadmap around observed user problems. Use `good first issue` for approachable work and `help wanted` for larger tasks. GitHub specifically uses the former to help surface suitable issues. [GitHub contribution-label guidance](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/encouraging-helpful-contributions-to-your-project-with-labels).

Proposed first issues, to validate against current behavior before publishing:

| Candidate | Deliverable | Validation |
| --- | --- | --- |
| Improve missing-CLI onboarding | Clear install/login guidance for an unavailable harness | Fresh-machine reproduction and a UI screenshot |
| Add a portable starter workflow | Useful workflow that runs on macOS and Linux without private credentials | Import and run successfully in desktop and cloud |
| Improve connection accessibility | Keyboard and screen-reader review of the guided MCP form | Documented focus order and resolved concrete findings |
| Document a tested MCP provider | Setup guide with auth method, scope limits and troubleshooting | A consenting user reproduces setup; no secrets in examples |
| Reproduce a harness compatibility bug | Minimal fixture and fix for an observed CLI-version mismatch | Regression test covers the actual failing event format |

Review new contributor questions within one business day, agree scope before large PRs, and aim for an initial review within two business days. Thank contributors in release notes. Avoid manufacturing easy issues or accepting cosmetic churn merely to increase contribution counts.

Do not open a separate Discord before there is demand and someone available to maintain it. GitHub issues and optional Discussions keep early technical context searchable and reduce abandoned support channels.

## Measurement and weekly decisions

| Metric | Definition | Initial collection |
| --- | --- | --- |
| Activation | Person completes a useful job and can open its artifact within seven days of first install | Opt-in tester checklist; do not infer it from downloads |
| Time to first value | Time from opening the app to first useful artifact | Voluntary setup observation |
| Week-one return | Activated person completes a second useful job on a later day within seven days | Voluntary follow-up; anonymous aggregate if instrumentation is later added |
| Weekly active operator | Person completes at least one useful job during a calendar week | Opt-in reports initially |
| Contribution conversion | External person opens a substantive issue or PR after trying the product | GitHub manual review |
| Contributor retention | External contributor makes a second substantive contribution within 30 days | GitHub manual review |
| Install conversion | Successful installs / distinct people who attempted installation in the tester cohort | Cohort checklist; release downloads are a separate aggregate |

Maintain a weekly scorecard with denominators, time window, known missing observations and top three failure reasons. Never collect prompts, repository contents, MCP payloads, tokens or customer data for marketing analytics. Add instrumentation only with a clear documented consent and privacy model; this plan does not install telemetry.

Use stars as a discoverability signal, not the success criterion. The strongest early outcome is a small group running recurring real work and improving the project together.

## Next concrete actions

1. Finish the first Mac prerelease and fresh-machine install check.
2. Produce the sample task, three screenshots and one continuous demo.
3. Publish five scoped contribution issues with maintainer ownership.
4. Recruit the first 10 consenting testers and track first artifacts/return use.
5. Fix the top setup failures, then launch on one community channel at a time.

No paid advertising is needed to validate this first cohort. Budget decisions should follow observed activation and retention, not a target star count.

## Domain shortlist — live quote, 19 October 2026

Vercel public Registrar API returned these non-premium names available for one year. USD; availability/prices can change. No purchase made.

| Domain | First year | Renewal/year | Position |
| --- | ---: | ---: | --- |
| principia.run | $6.99 | $26.19 | Recommended product address |
| principia.sh | $33.00 | $61.38 | Developer-facing alternative |
| runprincipia.com | $11.25 | $11.25 | Recommended economical .com |
| useprincipia.com | $11.25 | $11.25 | Plain .com alternative |
| principia.build | $30.00 | $30.00 | Builder audience |
| principia.company | $3.99 | $15.10 | Literal company positioning |

`principia.so`, `principia.dev`, `principia.app`, `getprincipia.com`, `principiahq.com`, and `principia.tools` were not confirmed available. This does not establish their ownership. Source: [Vercel Registrar API](https://vercel.com/docs/domains/registrar-api), live search endpoint. A domain lookup does not provide trademark clearance.
