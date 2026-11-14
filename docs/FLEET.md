# Fleet: Principia runs your cloud

The person clicks **Turn On Cloud**. That's all. Principia makes a machine on its own AWS account, signs it in with
their accounts, and runs their agents there. The machine sleeps when nothing runs and wakes when they start
something. They never see a provider, a token, a region or a size.

The fleet is a small service in `fleet/`. Anyone can deploy it to their own AWS account; the app finds it through
`FLEET_URL` in `src/shared/machines.ts` (or `PRINCIPIA_FLEET_URL` in the app's environment).

## 1. What the person sees

1. **Cloud** › *Turn On Cloud*. The app signs in to the fleet with this Mac's GitHub sign-in (`gh`), once.
2. Progress for about two minutes: making the machine, starting it, the https certificate, connecting this Mac,
   signing it in. Claude asks them to sign in once in the browser.
3. The Cloud page shows **Your cloud** with *Awake* or *Asleep*, the hours used this month, *Wake* and *Turn Off*.

*Use my own server or provider* keeps the paths of docs/MACHINES.md (Hetzner, DigitalOcean, SSH, a connect link).

## 2. How a request flows

```
Mac ──enroll (GitHub token, used once)──▶ fleet ──▶ GitHub /user
Mac ──POST /v1/machine (admin hash)─────▶ fleet ──▶ EC2: address + instance from the fleet image
machine ──heartbeat every 2 min─────────▶ fleet      (activity.json: busy, last activity, next schedule)
fleet tick every minute ────────────────▶ EC2: stop idle machines, start them for schedules, clean up
Mac ──change can't get through──────────▶ fleet /wake ──▶ EC2 start ──▶ Mac waits for /v1/health, retries
```

| Endpoint | Who | What |
| --- | --- | --- |
| `POST /v1/enroll` | Mac | GitHub token → fleet key (`pfk_…`). The token is used for `/user` (and `/user/orgs`) and never stored. A new enroll replaces the old key. |
| `GET /v1/machine` | Mac | The machine: state, address, hours this month, why it sleeps, when it wakes. |
| `POST /v1/machine` | Mac | Makes it, with the SHA-256 of the one-time admin token. A failed machine is rebuilt in place (same address). |
| `POST /v1/machine/wake` | Mac | Starts a sleeping machine (or one that is stopping, as soon as it stopped). |
| `DELETE /v1/machine` | Mac | Terminates it and releases its address. |
| `POST /v1/heartbeat` | machine | Its activity, with a token that can only report. |

## 3. On AWS (`fleet/infra/app.ts`)

One `cdk deploy` makes the VPC (public subnets in three zones, no NAT), a security group with only 80 and 443 open,
the launch template, a DynamoDB table, the API Lambda behind a function URL, and the reconciler Lambda every minute
(one at a time). IAM can change only what carries the `principia-fleet` tag.

**Each machine** (launch template):
- Graviton `t4g.large` (2 vCPU, 8 GB); `m7g.large` and `t4g.xlarge` when a zone has no room.
- Encrypted 40 GB gp3 disk. Shutting down stops it; it doesn't delete it.
- IMDSv2 only, hop limit 1, plus the `DOCKER-USER` drop rule: no container reaches the metadata service.
- No instance profile, so nothing on a machine can call AWS. No SSH key, and port 22 is closed.
- An Elastic IP from the start, so the address (`<a-b-c-d>.sslip.io`) and its certificate survive every sleep.

**Secrets.** User-data holds the admin token's hash and the heartbeat token, which can only report activity. The
fleet stores only hashes of the fleet keys and heartbeat tokens. GitHub, Claude, Codex and the Shared keys go from
the Mac straight to the machine (docs/ACCOUNTS.md); the fleet never sees them.

## 4. The machine image (`fleet/scripts/build-ami.ts`)

`prepareScript` (docs/MACHINES.md) runs once on a builder: Docker, the metadata block, the Principia Cloud image
(pulled, or built from `--ref`), Caddy and the heartbeat timer. The builder powers off, the script makes an image,
writes its id to `/principia-fleet/ami-id`, terminates the builder and deletes images older than the newest three.
A new machine only runs `configureScript`: its address, the admin hash, the heartbeat, `docker compose up`.

## 5. Money

All of it is enforced in `fleet/src/core.ts` and tested in `fleet/test/core.test.ts`.

| Rule | Default | Setting |
| --- | --- | --- |
| One machine per person | – | – |
| Machines across everyone | 25 | `-c maxMachines=` |
| Awake hours per person per month (then no wake until the 1st) | 200 | `-c maxHoursPerMonth=` |
| Stop after nothing ran and nothing changed for | 20 min | `-c idleMinutes=` |
| Stop a machine whose heartbeat is quiet for | 15 min | – |
| Stop and mark failed: first boot not up after / a wake not up after | 20 / 8 min | – |
| A failed machine is never left running | – | – |
| Orphan instances and addresses (no record, older than 15 min) are removed | – | – |
| Monthly AWS Budget e-mail at 80 % and 100 % | off | `-c monthlyBudgetUsd= -c alertEmail=` |
| Who may have a machine | nobody | `-c allowUsers=a,b -c allowOrgs=org -c open=true` |

Awake hours count only what a tick saw (at most 5 minutes per tick), so a missed tick never bills a gap.

**Rough cost per person** (us-east-2, on-demand): `t4g.large` is about $0.067 an hour. Awake 3 hours a day is about
$6 a month; the disk ($3.20) and the address ($3.60) are paid always. About **$13 a month** for a typical person, and
about $49 + $7 if it never slept.

## 6. Sleep and wake

The control plane writes `activity.json` every 30 seconds (`src/cloud/control/activity.ts`): runs queued or running,
the last run or change, and the next cloud schedule. The host heartbeat posts it to the fleet.

- **Sleep:** the reconciler stops a machine with nothing running and nothing changed for `idleMinutes`. A busy
  machine never sleeps. Reads and the Mac's event stream don't count as activity.
- **Wake for a schedule:** a sleeping machine is started 3 minutes before its next cloud schedule. A slot missed by
  a late wake still fires (up to 12 hours late, `src/cloud/agent/triggers.ts`).
- **Wake for use:** a change from the Mac (run, sync, key, sign-in) that can't get through calls
  `CloudMachines.wakeForUse()` (via `CloudClient`'s `wake`), waits until the cloud answers, and sends it once more.
  Reads never wake it. The Cloud page has a *Wake* button.
- **No room in the zone:** the stopped machine moves to the next instance type and starts.

## 7. Deploy

```sh
aws login --profile <profile>
cd fleet && npm ci
AWS_PROFILE=<profile> npx cdk bootstrap
AWS_PROFILE=<profile> npx cdk deploy -c allowUsers=<github-login> -c monthlyBudgetUsd=100 -c alertEmail=<you>
AWS_PROFILE=<profile> npx tsx scripts/build-ami.ts --ref <pushed git ref>
```

Then set `FLEET_URL` in `src/shared/machines.ts` to the stack's `FleetUrl` output (or run the app with
`PRINCIPIA_FLEET_URL=…`). Tests: `npm run fleet:test`.

## 8. Not yet

- **Passport.** A machine built from source has no embedded Open Passport, whose sources aren't public. The
  published image (`ghcr.io/vibiz-ai/principia-cloud`) has it once the release workflow publishes it.
- **Billing.** Hours are counted and capped, not charged. Charging them (e.g. to Vibiz credits) reads `usage`.
- **Updates to a running machine.** New machines use the newest image; existing ones keep theirs.
- **One sandbox per run** on the machine (docs/MACHINES.md §5), and a custom domain instead of sslip.io.
