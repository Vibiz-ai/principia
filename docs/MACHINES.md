# Machines: make your cloud from the app, sign in once, agents work there

You click **Make my cloud** on the Cloud page. Principia creates a server, installs Principia Cloud on it with its own
https address, connects this Mac, and signs it in with your accounts. Agents then run there in a sandbox, signed in to
Claude, Codex and GitHub, with your keys and the tools they need. Nobody types a command or copies a link.

## 1. What you do

1. **Cloud** › *Make my cloud*. Choose one:
   - **Hetzner Cloud**: paste an API token (Project › Security › API tokens, Read & Write), then *Check*. Pick a
     region and a size. The default is the cheapest x86 size with 4 vCPU and 8 GB.
   - **DigitalOcean**: the same, with a DigitalOcean token. The default is `s-4vcpu-8gb`.
   - **My own server**: an address and a user. Principia connects with this Mac's SSH keys and installs as root (or
     with `sudo -n`). It needs a public IPv4 and ports 80 and 443 open.
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
`shellcheck` when it is installed.

1. SSH keys only: password and keyboard-interactive login off, root password locked. Docker comes from
   get.docker.com.
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
itself exists only on this Mac, encrypted with safeStorage, until it has been used once. The metadata block in
step 2 is a second layer.

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
