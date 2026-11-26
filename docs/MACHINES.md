# Machines: make your cloud from the app, sign in once, agents work there

You click **Make my cloud** on the Cloud page. Principia creates a server, installs Principia Cloud on it with its own
https address, connects this Mac, and signs it in with your accounts. Agents then run there in a sandbox, signed in to
Claude, Codex and GitHub, with your keys and the tools they need. Nobody types a command or copies a link.

The default is the managed cloud of docs/FLEET.md: *Turn On Cloud*, one click, Principia runs it. This page is
*Use my own server or provider*, and the parts both share (the script, pairing, signing in).

## 1. What you do

1. **Cloud** › *Use my own server or provider*. Choose one:
   - **Hetzner Cloud**: paste an API token (Project › Security › API tokens, Read & Write), then *Check*. Pick a
     region and a size. The default is the cheapest x86 size with 4 vCPU and 8 GB.
   - **DigitalOcean**: the same, with a DigitalOcean token. The default is `s-4vcpu-8gb`.
   - **My own server**: an address and a user. Principia connects with this Mac's SSH keys and installs as root (or
     with `sudo -n`). It needs a public IPv4 and ports 80 and 443 open. Or, without the app doing the SSH, run the
     one line of §7 on the server.
2. Choose what it signs in with: **GitHub** (this Mac's `gh`), **Shared keys** (the ones switched to *In the cloud*),
   **Claude** and **Codex** (each opens the browser once for a sign-in made just for the cloud).
3. *Create*. The page shows the steps. You can leave the page or quit the app; it continues where it stopped.

When it is ready, the Cloud page shows the usual workspace and a **Machine** card with its address and anything that
still needs you (for example "Claude: finish signing in in your browser"). **Delete** disconnects this Mac and deletes
the server at the provider, which stops the billing. For your own server it only disconnects (*Forget*).

## 2. What happens, step by step

`src/main/cloud/machines/index.ts` (`CloudMachines`) moves the machine through these phases and saves each one in
`<userData>/cloud-machine.json` (0600):

| Phase | What Principia does |
| --- | --- |
| creating | Adds this Mac's SSH public key at the provider (if there is one), then creates an Ubuntu 24.04 server whose user-data is the bootstrap script. |
| booting | Polls the provider until the server runs and has a public IPv4. The address becomes `https://<a-b-c-d>.sslip.io`. |
| installing | The server runs the script. *My own server* runs it now over `ssh … bash -s`. Principia polls `/v1/health` until it answers with a valid certificate (35 minutes at most). |
| pairing | `POST /v1/pair/start` with the one-time admin token, then normal pairing. The admin token is deleted from the Mac right after. |
| signing-in | Pushes the marked Shared keys and GitHub (docs/ACCOUNTS.md). Then the machine is **ready**, and the Claude and Codex browser sign-ins open one after the other. |

A failure stops at its phase with the reason (`failed`, `failedAt`). *Try Again* continues from that phase. *Delete*
cleans up. The app resumes a machine in progress at startup (`cloud.machines.resume()`).

### The bootstrap script (`machines/bootstrap.ts`)

One bash script for all three ways in. It holds **nothing secret**. Tests check it with `bash -n`, and with
`shellcheck` when it is installed. It is two halves: `prepareScript` (steps 1, 2 and the image, the same on every
machine, which the managed fleet bakes into its machine image) and `configureScript` (this machine's address, the
admin hash, and on a managed machine its heartbeat, then `docker compose up`).

1. SSH keys only: password and keyboard-interactive login off, root password locked. Docker comes from
   get.docker.com. On a server without systemd (a container, LXC or WSL) Docker starts from its init script and the
   step 2 rule is inserted once instead of by a unit; it does not come back by itself after a reboot.
2. Containers can't reach `169.254.169.254`. A systemd unit adds a `DOCKER-USER` DROP rule after every Docker start.
   That address is the provider's metadata service, which serves the user-data and, at some providers, credentials.
3. `/opt/principia/` holds `compose.yml`, `Caddyfile`, `.env` and `principia.env` (0600). Principia Cloud runs in one
   hardened container with the passport embedded, like Render: read-only root, all capabilities dropped except the
   six of CLOUD.md §7.8, `no-new-privileges`, and agents running as uid 1001. Caddy gets the Let's Encrypt
   certificate for the sslip.io name.
4. Image: `ghcr.io/vibiz-ai/principia-cloud:<app version>`. When that can't be pulled, the script clones the public
   source at `v<app version>` and builds it on the machine. That build has no embedded passport, because the Open
   Passport sources are not public yet. The install log is `/var/log/principia-bootstrap.log`.

Overrides for development: `PRINCIPIA_CLOUD_IMAGE` (another image) and `PRINCIPIA_CLOUD_REF` (another git ref to
build from) in the app's environment.

## 3. Why it is built this way

**Nothing that grants access is in the user-data.** Providers keep the user-data, and any process on the server can
read it from the metadata service. So the master key is generated on the server, and the admin token that pairs
this Mac appears there only as its SHA-256 (`PRINCIPIA_ADMIN_TOKEN_SHA256`, checked in `control/auth.ts`). The token
itself exists only on this Mac, encrypted with safeStorage, until it has been used once. The server enforces the
"once" too: when a device pairs, that hash is recorded as spent (`meta.admin_sha256_used`) and `POST /v1/pair/start`
answers 403 to it from then on (a lost answer before the pairing completes can still be retried). A new install
writes a new hash. The metadata block in step 2 is a second layer.

**Your accounts arrive the same way as on any cloud.** A machine made here is an ordinary self-hosted cloud. The
accounts follow docs/ACCOUNTS.md exactly: values go up once, are encrypted with the cloud's master key, and never
come back. Claude and Codex get sign-ins of their own, so deleting the machine never signs this Mac out.

**The provider token stays on this Mac.** It is kept encrypted only so *Delete* can delete the server. It goes only
to its provider's API host and never to the cloud. A scoped token (Hetzner: one project; DigitalOcean: custom
scopes) limits what it can reach.

**sslip.io instead of a domain.** A name is ready the moment the IP exists, with nothing to configure. The dashed form
(`1-2-3-4.sslip.io`) keeps each machine under its own name for Let's Encrypt. Bringing your own domain is a later
option: the script already takes any domain.

## 4. What agents get in the sandbox

Each run starts in a fresh 0700 home as uid 1001 (CLOUD.md §7.8), with:

- **Signed-in CLIs:** `claude` (`CLAUDE_CODE_OAUTH_TOKEN`), `codex` (its own `auth.json`), `gemini`.
- **GitHub everywhere:** `GH_TOKEN` and `GITHUB_TOKEN` for `gh` and the API. The run's `GIT_ASKPASS` answers with
  each company repo's own token inside that repo, and with the workspace GitHub account for any other github.com
  repository (`runAskpass(…, github)`). An agent can clone, fetch and push whatever the account reaches, and the
  token is never in argv, a remote URL or the script.
- **Keys:** the Shared keys marked *In the cloud*, then the company's own keys over them.
- **Tools** (`cloud/Dockerfile`): git, gh, ripgrep, fd, jq, curl, wget, Python 3 with pip and venv,
  build-essential, pkg-config, zip and xz, procps and less, alongside Node 24.

## 5. Next

- **One sandbox per run.** The runtime contract (`src/cloud/contract.ts`) already passes `RunMaterials` per run. A
  `docker` driver, then a microVM driver (Firecracker or Cloud Hypervisor on the same machine), gives each run its own
  filesystem and network policy. The accounts flow doesn't change.
- **Short-lived GitHub tokens** through a GitHub App (docs/ACCOUNTS.md §5).
- **More providers:** Fly Machines, AWS (including EC2 Mac for macOS workers), GCP. Each one only implements the five
  `MachineApi` calls.
- **Your own domain** and a DNS check, as an alternative to sslip.io.
- **Snapshots and resize** from the Machine card.

## 6. Tested for real: the own-server path on a local stand-in (26 November 2026)

No server was rented. An Ubuntu 24.04 container with only `sshd` (no systemd) and `--privileged` (Docker inside it),
its SSH port published on `127.0.0.1:2222`, and a throwaway key, stood in for "my own server". The real `runSsh` ran
the real `bootstrapScript` over `ssh … bash -s`, as root and as a `sudo -n` user, with the domain `localhost` (Caddy
then uses its own local CA, since Let's Encrypt cannot reach a laptop).

| Step | Result |
| --- | --- |
| SSH, `bash -s`, `sudo -n bash -s` | works; `principia:` lines arrive as progress |
| Docker from get.docker.com | installs; then `systemctl enable --now docker` **stopped the install** on a server without systemd (fixed: init-script fallback, §2 step 1) |
| image `ghcr.io/vibiz-ai/principia-cloud:0.4.10` | pulls; runs healthy, agents as uid 1001 |
| Caddy, https | serves `https://localhost` (local CA); `/v1/health` answers `ok` |
| `POST /v1/pair/start` with the admin token, `POST /v1/pair/complete`, `/v1/me`, `/v1/login-links` | all work |
| the admin token after pairing | was still accepted (fixed: one-time, §3) |
| running the script a second time | idempotent: same workspace, data kept, containers recreated |
| `cloud/install.sh` piped into `bash` over SSH (§7) | installs, prints the connect link and its QR code |
| `principia-cloud phone-link` (an image built from this branch) | exits 3 until the "Mac" pairs, then prints the phone link and its QR code; the link signs the console in once and is refused the second time |

Not covered locally: a Let's Encrypt certificate for `<ip>.sslip.io` (needs a public IPv4 with 80 and 443 open)
and the app's own `install()` phase, which refuses private addresses on purpose. The published 0.4.10 image has no
Open Passport host (the release build had no `OPEN_PASSPORT_TOKEN`), so `PRINCIPIA_PASSPORT=embedded` is a no-op on
it and the cloud logs "starting without a passport".

To repeat it: build a `ubuntu:24.04` image with `openssh-server curl ca-certificates iproute2 sudo` and a key in
`/root/.ssh/authorized_keys`, run it with `--privileged -p 127.0.0.1:2222:22 -p 127.0.0.1:8443:443`, and feed the
script to `ssh -p 2222 root@127.0.0.1 'PRINCIPIA_DOMAIN=localhost bash'`.

## 7. One line on your own server

```sh
curl -fsSL https://raw.githubusercontent.com/Vibiz-ai/principia/main/cloud/install.sh | sudo bash
```

On any Ubuntu 22.04+ or Debian 12+ server with a public IPv4 and ports 80 and 443 open. With your own domain (its A
record pointing at the server) instead of `<ip>.sslip.io`: `… | sudo PRINCIPIA_DOMAIN=cloud.example.com bash`.

What it does, in order:

1. Checks it is root on Ubuntu or Debian, installs `curl`, `iproute2`, `iptables` and `qrencode`, and opens 80 and
   443 when `ufw` is on.
2. `prepareScript` and `configureScript` of §2, unchanged, with two differences: there is no admin hash (no Mac made
   it), and password SSH login is turned off only when root or the `sudo` user already has an `authorized_keys`, so
   nobody who logs in with a password is locked out.
3. Waits for `https://<domain>/v1/health` (the certificate), then runs `principia-cloud pair` in the container and
   prints the **connect link** with its **QR code**. On the Mac: Principia › Cloud › paste it.
4. Waits up to 10 minutes for that pairing (`principia-cloud phone-link` exits 3 until a device is paired), then
   prints a one-time **phone link** (the console sign-in of `POST /v1/login-links`, 10 minutes) with its QR code.
   An image older than `phone-link` falls back to "Workspace › Open on your phone" on the Mac.

The script runs inside one function called with stdin from `/dev/null`: bash reads all of it before running
anything, and nothing it starts (apt, Docker, compose) can swallow the rest of the script from the curl pipe.

**It cannot drift.** `cloud/install.sh` is generated: `installScript(version)` in `machines/bootstrap.ts` builds it
from the same `prepareScript` and `configureScript` as every Hetzner, DigitalOcean, SSH and managed machine.
`npm run cloud:install-sh` writes it, `npm run cloud:install-sh:check` fails when it is stale, and
`machines.test.ts` compares the file byte for byte (plus `bash -n` and shellcheck). The image version sits between
`x-release-please-start-version` markers, and `release-please-config.json` lists the file in `extra-files`, so the
release PR bumps it together with `package.json` and the test stays green.

**Where it is served, and how you can check it.** Decision:

- **Today:** `raw.githubusercontent.com/Vibiz-ai/principia/main/cloud/install.sh`. On `main` the file always pins the
  last released image (release-please bumps it in the release PR), so the short URL installs the current release.
  The pinned form is the tag: `…/principia/v<version>/cloud/install.sh`.
- **Next (the URL to advertise):** a release asset,
  `https://github.com/Vibiz-ai/principia/releases/latest/download/install.sh`. Releases are immutable (RELEASING.md),
  so a published `install.sh` can never change, and it is listed in that release's `SHA256SUMS.txt` and covered by
  `gh attestation verify`. To add it, `scripts/release-mac.mjs` writes `node scripts/install-sh.mjs --version <v>
  --out <outDir>/install.sh` before it writes `SHA256SUMS.txt`; the draft check then expects it like every other file.
- **Checking before running** (for people who do not pipe into root):
  ```sh
  curl -fsSLO https://github.com/Vibiz-ai/principia/releases/download/v<version>/install.sh
  curl -fsSL https://github.com/Vibiz-ai/principia/releases/download/v<version>/SHA256SUMS.txt | grep ' install.sh$' | sha256sum -c
  sudo bash install.sh
  ```
  The script itself holds nothing secret and fetches only Docker (get.docker.com), the pinned image from ghcr.io and
  `caddy:2.10-alpine`. Pinning the image by digest is the remaining gap (the image is built after the tag).

### Accounts on your own server, as easily as on the managed cloud

A machine the app makes over SSH already gets the full docs/ACCOUNTS.md flow: its `signing-in` phase pushes Shared
keys and GitHub, and signs Claude and Codex in from the saved sign-ins of `cloud-logins.json` (docs/FLEET.md §9), so
there is no browser when this Mac has signed a cloud in before. A cloud installed with the one line is paired by a
pasted link, which today stops at "paired". The plan, so both end the same way:

1. **Adopt a pasted cloud.** When a connect link pairs and no machine is being made, `CloudMachines` records an
   `ssh`-kind machine for that URL in phase `signing-in` (no admin token, no SSH target) with the default
   `bring` (GitHub, Shared keys, Claude, Codex). The same `signIn()` then runs: keys and GitHub go up at once, Claude
   and Codex come from the login vault, and the browser opens only for one that was never saved.
2. **Ask once, in the connect sheet.** The paste sheet shows the same four checkboxes as *Make my cloud*, ticked,
   so nothing is pushed that the person did not see.
3. **Show the one line in the app.** *My own server* gets a second tab, "Run one command on it", with the command
   above and a field that waits for the connect link (or picks it up from the clipboard), so a server reached only
   through a console (no SSH from this Mac) needs no terminal on the Mac.
4. **Phone.** After pairing, the server already prints the phone link (§7, step 4); the Mac's "Open on your phone"
   stays the way to get another.

