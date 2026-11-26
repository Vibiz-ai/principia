/**
 * docs/MACHINES.md §2: the one script a new machine runs (cloud-init user-data at Hetzner and DigitalOcean, `sudo bash
 * -s` over SSH on your own server). It holds nothing secret: the cloud's master key is generated on the machine, and
 * the admin token that pairs this Mac is given only as its SHA-256. Pure: returns text, so tests can read and lint it.
 *
 * What it does, in order:
 *  1. SSH keys only (no root password), Docker from get.docker.com.
 *  2. Containers cannot reach the cloud metadata service (169.254.169.254), which serves the user-data and, at some
 *     providers, credentials: a systemd unit inserts the DROP rule into DOCKER-USER after every Docker start.
 *  3. /opt/principia/{compose.yml,Caddyfile,.env}: Principia Cloud in one container (passport embedded on the same
 *     origin, like Render) behind Caddy, which gets the https certificate for <ip>.sslip.io.
 *  4. The published image for this app version; when it cannot be pulled, it builds the image from the public source
 *     at the same version (without the embedded passport, whose sources are not public yet).
 *
 * It is two halves (docs/FLEET.md §4): `prepareScript` (1, 2 and the image: the same on every machine, so a managed
 * fleet bakes it into its machine image once) and `configureScript` (this machine's address, admin hash and, on a
 * managed machine, its heartbeat to the fleet). `bootstrapScript` is both, for Hetzner, DigitalOcean and SSH.
 */

export interface PrepareInput {
  /** the image to pull, e.g. ghcr.io/vibiz-ai/principia-cloud:0.4.8 */
  image: string
  /** the git ref of https://github.com/Vibiz-ai/principia to build from when the image cannot be pulled */
  sourceRef: string
  sourceRepo?: string
}

export interface ConfigureInput {
  /** <ip>.sslip.io, your own domain pointing at the machine, or 'auto' (the script finds its public IPv4) */
  domain: string
  /** SHA-256 hex of the one-time admin token this Mac pairs with; null on a one-line install (it prints a connect link) */
  adminTokenSha256: string | null
  workspaceName?: string
  /** a managed machine: where its heartbeat goes, and the token that lets it report (and nothing else) */
  fleet?: { url: string; machineToken: string } | null
}

export type BootstrapInput = PrepareInput & ConfigureInput

const SAFE = /^[A-Za-z0-9._:/@+-]{1,300}$/
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/

/** Single-quoted for sh. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const HEADER = `#!/bin/bash
# Principia Cloud machine (docs/MACHINES.md). Made by Principia.
set -euo pipefail
# the log is root's only (0600) before anything is written to it
(umask 077; touch /var/log/principia-bootstrap.log)
chmod 600 /var/log/principia-bootstrap.log
exec > >(tee -a /var/log/principia-bootstrap.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
`

/**
 * The managed machine's heartbeat (docs/FLEET.md §6): every 2 minutes, as root on the host, it reads the control
 * plane's activity.json from the data volume and posts it to the fleet with this machine's token. Python 3 from the
 * Ubuntu image, standard library only. A failed post is retried at the next tick; the fleet decides about sleep.
 */
const HEARTBEAT_PY = `#!/usr/bin/env python3
import datetime, json, os, re, subprocess, time, urllib.request
env = {}
for line in open('/opt/principia/fleet.env'):
    if '=' in line:
        k, v = line.strip().split('=', 1)
        env[k] = v
def out(*a):
    try:
        return subprocess.run(a, capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        return ''
mount = out('docker', 'volume', 'inspect', 'principia_data', '-f', '{{.Mountpoint}}')
activity = None
try:
    with open(os.path.join(mount, 'activity.json')) as f:
        activity = json.load(f)
except Exception:
    activity = None
up = out('docker', 'compose', '--project-directory', '/opt/principia', 'ps', '--status', 'running', '-q', 'principia') != ''
uptime = int(float(open('/proc/uptime').read().split()[0]))
body = json.dumps({'activity': activity, 'up': up, 'uptimeSec': uptime}).encode()
req = urllib.request.Request(env['FLEET_URL'].rstrip('/') + '/v1/heartbeat', data=body, method='POST',
    headers={'authorization': 'Bearer ' + env['FLEET_TOKEN'], 'content-type': 'application/json'})
resp = urllib.request.urlopen(req, timeout=20).read()
# docs/FLEET.md §10: the fleet names the version this machine should run; it moves there only while nothing runs
# (the data volume, its chats and its sign-ins stay), and only to a published Principia Cloud tag
try:
    want = json.loads(resp).get('image')
except Exception:
    want = None
if isinstance(want, str) and re.fullmatch(r'ghcr\\.io/vibiz-ai/principia-cloud:[0-9A-Za-z._-]{1,64}', want):
    envp = '/opt/principia/.env'
    lines = [l.rstrip('\\n') for l in open(envp)] if os.path.exists(envp) else []
    cur = next((l.split('=', 1)[1] for l in lines if l.startswith('PRINCIPIA_IMAGE=')), '')
    idle = not activity or (not activity.get('busy') and not activity.get('running') and not activity.get('queued'))
    if cur != want and idle:
        pulled = subprocess.run(['docker', 'pull', want], capture_output=True, timeout=900).returncode == 0
        # the pull can take minutes: only a fresh, idle snapshot (written in the last 90 s, nothing running, queued,
        # waiting or changed in the last 2 minutes) lets the container be replaced; else the next heartbeat tries again
        fresh = None
        try:
            with open(os.path.join(mount, 'activity.json')) as f:
                fresh = json.load(f)
        except Exception:
            fresh = None
        def age(iso):
            try:
                return time.time() - datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp()
            except Exception:
                return 1e9
        still_idle = bool(fresh) and age(fresh.get('at') or '') < 90 and not fresh.get('busy') and not fresh.get('running') \\
            and not fresh.get('queued') and not fresh.get('needsInput') and age(fresh.get('lastActivityAt') or '') > 120
        if pulled and (still_idle or not up):
            keep = [l for l in lines if l and not l.startswith('PRINCIPIA_IMAGE=')]
            with open(envp + '.tmp', 'w') as f:
                f.write('\\n'.join(keep + ['PRINCIPIA_IMAGE=' + want]) + '\\n')
            os.replace(envp + '.tmp', envp)
            with open('/opt/principia/install-kind', 'w') as f:
                f.write('published\\n')
            subprocess.run(['docker', 'compose', '--project-directory', '/opt/principia', 'up', '-d'], capture_output=True, timeout=600)
            print('principia: now running ' + want)
`

/** Steps 1, 2 and the image: nothing about this machine, nothing secret. */
export function prepareScript(i: PrepareInput, o: { header?: boolean; keysOnlyIfKeyed?: boolean } = {}): string {
  for (const [k, v] of Object.entries({ image: i.image, sourceRef: i.sourceRef, sourceRepo: i.sourceRepo ?? 'x' })) {
    if (!SAFE.test(v)) throw new Error(`Invalid ${k}`)
  }
  const repo = i.sourceRepo ?? 'https://github.com/Vibiz-ai/principia.git'
  return `${o.header === false ? '' : HEADER}echo "principia: prepare $(date -u +%FT%TZ)"
IMAGE=${shq(i.image)}
SOURCE_REPO=${shq(repo)}
SOURCE_REF=${shq(i.sourceRef)}

# 1. keys only, and Docker
${o.keysOnlyIfKeyed ? `# (only when root or the sudo user already logs in with a key: turning passwords off would lock out the others)
KEYED=
# the user who ran sudo is the one who would be locked out, so it is that user's keys that count (else root's)
KEYHOME="$(getent passwd "\${SUDO_USER:-root}" | cut -d: -f6)"
if [ -s "\${KEYHOME:-/nonexistent}/.ssh/authorized_keys" ]; then KEYED=1; fi
[ -n "$KEYED" ] || echo "principia: this server has no SSH key yet, so password login stays on. Add a key, then turn passwords off."
if [ -n "$KEYED" ] && [ -d /etc/ssh/sshd_config.d ]; then` : 'if [ -d /etc/ssh/sshd_config.d ]; then'}
  printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\nPermitRootLogin prohibit-password\\n' > /etc/ssh/sshd_config.d/10-principia.conf
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi
${o.keysOnlyIfKeyed ? '[ -z "$KEYED" ] || ' : ''}passwd -l root >/dev/null 2>&1 || true
if ! command -v docker >/dev/null 2>&1; then
  for n in 1 2 3 4 5; do curl -fsSL https://get.docker.com | sh && break; echo "principia: docker install failed, retry $n"; sleep 10; done
fi
# a server without systemd (a container, LXC or WSL host): Docker's SysV script, and the rules applied once
SYSTEMD=1
[ -d /run/systemd/system ] || SYSTEMD=
if [ -n "$SYSTEMD" ]; then
  systemctl enable --now docker
else
  echo "principia: no systemd, starting Docker with its init script (it will not restart on reboot by itself)"
  docker info >/dev/null 2>&1 || service docker start || echo "principia: Docker's init script failed, starting dockerd directly"
  docker info >/dev/null 2>&1 || pgrep -x dockerd >/dev/null || { nohup dockerd >>/var/log/dockerd.log 2>&1 & }
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
docker info >/dev/null 2>&1 || { echo "principia: Docker did not start"; exit 1; }

# 2. no container reaches the metadata service
if [ -z "$SYSTEMD" ]; then
  iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254 -j DROP \
    || echo "principia: warning: could not block the metadata service for containers (no iptables permission here)"
fi
if [ -n "$SYSTEMD" ]; then
cat > /etc/systemd/system/principia-metadata-block.service <<'UNIT'
[Unit]
Description=Keep containers away from the cloud metadata service (Principia)
After=docker.service
BindsTo=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254 -j DROP'
[Install]
WantedBy=docker.service multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now principia-metadata-block.service \
  || echo "principia: warning: could not block the metadata service for containers (see systemctl status principia-metadata-block)"
fi

# 3. the image and the stack (started by configure)
mkdir -p /opt/principia
cd /opt/principia
if ! docker pull "$IMAGE"; then
  echo "principia: $IMAGE is not published, building $SOURCE_REF from source"
  command -v git >/dev/null 2>&1 || { apt-get update -q && apt-get install -yq git; }
  rm -rf src op-stub
  git clone --depth 1 --branch "$SOURCE_REF" "$SOURCE_REPO" src
  mkdir -p op-stub/packages/js op-stub/packages/server
  docker build -f src/cloud/Dockerfile --build-context open-passport=op-stub -t principia-cloud:local src
  rm -rf src op-stub
  IMAGE=principia-cloud:local
  echo source > install-kind
else
  echo published > install-kind
fi
docker pull caddy:2.10-alpine
cat > .env <<ENV
PRINCIPIA_IMAGE=$IMAGE
ENV
cat > compose.yml <<'COMPOSE'
name: principia
services:
  principia:
    image: \${PRINCIPIA_IMAGE}
    user: '0:0'
    init: true
    restart: unless-stopped
    env_file: principia.env
    volumes:
      - data:/data
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    # docs/CLOUD.md §7.8: enough to hand folders to the agent user and start agents as it; agents get none
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
      - FOWNER
      - SETUID
      - SETGID
      - KILL
    security_opt:
      - no-new-privileges:true
    stop_grace_period: 20s
  caddy:
    image: caddy:2.10-alpine
    restart: unless-stopped
    depends_on:
      - principia
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
volumes:
  data:
  caddy-data:
  caddy-config:
COMPOSE

# the managed heartbeat: installed everywhere, enabled only where configure writes fleet.env
cat > /usr/local/sbin/principia-heartbeat <<'PY'
${HEARTBEAT_PY}PY
chmod 755 /usr/local/sbin/principia-heartbeat
if [ -n "$SYSTEMD" ]; then
cat > /etc/systemd/system/principia-heartbeat.service <<'UNIT'
[Unit]
Description=Report this machine's activity to the Principia fleet
ConditionPathExists=/opt/principia/fleet.env
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/principia-heartbeat
UNIT
cat > /etc/systemd/system/principia-heartbeat.timer <<'UNIT'
[Unit]
Description=Principia fleet heartbeat
[Timer]
OnBootSec=45s
OnUnitActiveSec=2min
AccuracySec=10s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
fi
echo "principia: prepared $(date -u +%FT%TZ)"
`
}

/** This machine: its address, the admin hash, the fleet heartbeat (managed), then the stack starts. */
export function configureScript(i: ConfigureInput, o: { header?: boolean; domainFromEnv?: boolean } = {}): string {
  if (!SAFE.test(i.domain)) throw new Error('Invalid domain')
  if (i.adminTokenSha256 !== null && !/^[0-9a-f]{64}$/.test(i.adminTokenSha256)) throw new Error('Invalid admin token hash')
  if (i.fleet && (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._/-]*)?$/.test(i.fleet.url) || !TOKEN.test(i.fleet.machineToken))) throw new Error('Invalid fleet')
  const name = (i.workspaceName ?? 'Principia Cloud').replace(/[^\w .-]/g, '').slice(0, 80) || 'Principia Cloud'
  const fleet = i.fleet
    ? `
# the fleet heartbeat (managed machines): this token only reports activity, it opens nothing
umask 077
cat > fleet.env <<ENV
FLEET_URL=${i.fleet.url}
FLEET_TOKEN=${i.fleet.machineToken}
ENV
chmod 600 fleet.env
umask 022
systemctl enable --now principia-heartbeat.timer
`
    : ''
  return `${o.header === false ? '' : HEADER}echo "principia: configure $(date -u +%FT%TZ)"
${o.domainFromEnv ? `# your own domain (pointing at this server), else ${i.domain}
DOMAIN="\${PRINCIPIA_DOMAIN:-${i.domain}}"
case "$DOMAIN" in ''|*[!A-Za-z0-9.-]*) echo "principia: PRINCIPIA_DOMAIN is not a domain name"; exit 1 ;; esac` : `DOMAIN=${shq(i.domain)}`}
ADMIN_SHA256=${shq(i.adminTokenSha256 ?? '')}
WORKSPACE_NAME=${shq(name)}
# auto: the machine's own public IPv4 (the provider gives it after the script was written)
if [ "$DOMAIN" = auto ]; then
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  case "$IP" in ''|10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*|100.*) IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)" ;; esac
  [ -n "$IP" ] || { echo "principia: no public IPv4"; exit 1; }
  DOMAIN="$(printf '%s' "$IP" | tr . -).sslip.io"
fi
cd /opt/principia
PASSPORT=embedded
[ "$(cat install-kind 2>/dev/null)" = source ] && PASSPORT=
cat > principia.env <<ENV
PRINCIPIA_PUBLIC_URL=https://$DOMAIN
\${ADMIN_SHA256:+PRINCIPIA_ADMIN_TOKEN_SHA256=$ADMIN_SHA256}
\${ADMIN_SHA256:+PRINCIPIA_ADMIN_TOKEN_ONCE=1}
PRINCIPIA_WORKSPACE_NAME=$WORKSPACE_NAME
PRINCIPIA_PASSPORT=$PASSPORT
PRINCIPIA_DATA_DIR=/data
PRINCIPIA_SECRETS_DIR=/data/secrets
PRINCIPIA_WORKSPACE=/data/workspace
HOST=0.0.0.0
PORT=8787
ENV
${i.fleet ? `echo 'PRINCIPIA_FLEET_URL=${i.fleet.url}' >> principia.env
` : ''}chmod 600 principia.env
cat > Caddyfile <<CADDY
$DOMAIN {
  reverse_proxy principia:8787
}
CADDY
${fleet}docker compose up -d
echo "principia: up at https://$DOMAIN $(date -u +%FT%TZ)"
`
}

/** Both halves, for a machine that installs itself (Hetzner, DigitalOcean, your own server). */
export function bootstrapScript(i: BootstrapInput): string {
  return `${prepareScript(i)}\n${configureScript(i, { header: false })}`
}

/** The published image of a Principia version, and the tag its source is at. */
export const releaseInputs = (version: string): PrepareInput => ({ image: `ghcr.io/vibiz-ai/principia-cloud:${version}`, sourceRef: `v${version}` })

/**
 * docs/MACHINES.md §7: the one-line install on your own Ubuntu or Debian server,
 *   curl -fsSL https://raw.githubusercontent.com/Vibiz-ai/principia/main/cloud/install.sh | sudo bash
 * The same two halves as every machine (prepare, configure), with no admin hash: instead it prints a connect link and
 * its QR code, waits for your Mac, then prints a one-time phone link. Everything runs inside one function that is
 * called with stdin from /dev/null, so nothing it runs can read the rest of the script from the curl pipe.
 * cloud/install.sh is this text (scripts/install-sh.mjs writes it; a test keeps it in sync). release-please bumps the
 * version between its markers.
 */
export function installScript(version: string): string {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid version')
  const prepare = prepareScript(releaseInputs(version), { header: false, keysOnlyIfKeyed: true }).replace(/^(IMAGE=.*\n(?:.*\n)?SOURCE_REF=.*\n)/m, '# x-release-please-start-version\n$1# x-release-please-end\n')
  if (!prepare.includes('x-release-please-end')) throw new Error('prepareScript changed: put the release markers around IMAGE and SOURCE_REF')
  const configure = configureScript({ domain: 'auto', adminTokenSha256: null }, { header: false, domainFromEnv: true })
  return `#!/bin/bash
# Principia Cloud on your own server (docs/MACHINES.md §7). Ubuntu 22.04+ or Debian 12+, a public IPv4, ports 80
# and 443 open. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/Vibiz-ai/principia/main/cloud/install.sh | sudo bash
# Your own domain instead of <ip>.sslip.io (its A record pointing here):
#   curl -fsSL … | sudo PRINCIPIA_DOMAIN=cloud.example.com bash
# Generated from src/main/cloud/machines/bootstrap.ts by scripts/install-sh.mjs. Do not edit by hand.
set -euo pipefail

principia_install() {
[ "$(id -u)" = 0 ] || { echo "principia: run it as root (… | sudo bash)"; exit 1; }
# the log is root's only (0600) before anything is written to it
(umask 077; touch /var/log/principia-bootstrap.log)
chmod 600 /var/log/principia-bootstrap.log
exec 3>&1 # the terminal, for the links
exec > >(tee -a /var/log/principia-bootstrap.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
# shellcheck source=/dev/null
OS="$(. /etc/os-release 2>/dev/null; echo "\${ID:-} \${ID_LIKE:-}")"
case " $OS " in *' ubuntu '*|*' debian '*) ;; *) echo "principia: this installer is for Ubuntu and Debian (found: $OS)"; exit 1 ;; esac
apt-get update -q
apt-get install -yq curl ca-certificates iproute2 iptables qrencode
# a host firewall that is on lets the certificate and the cloud through
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then ufw allow 80/tcp; ufw allow 443/tcp; fi

${prepare}
${configure}
# reachable over https, then the links
URL="https://$DOMAIN"
K=
case "$DOMAIN" in localhost|*.localhost) K=-k ;; esac
echo "principia: waiting for $URL (its https certificate can take a minute)"
UP=
for _ in $(seq 1 60); do
  if curl -fsS $K --max-time 10 "$URL/v1/health" >/dev/null 2>&1; then UP=1; break; fi
  sleep 5
done
if [ -z "$UP" ]; then
  echo "principia: $URL does not answer yet. Ports 80 and 443 must be open to the internet (at your provider too) for its certificate."
  echo "  Look: cd /opt/principia && docker compose logs caddy principia"
  exit 1
fi
# the links open the cloud: they go to the terminal only (fd 3), never into the log
show() {
  {
    echo
    echo "  $1"
    echo "  $2"
    echo
    qrencode -t ANSIUTF8 -m 2 "$2" 2>/dev/null || true
  } >&3
}
LINK="$(docker compose exec -T principia principia-cloud pair | sed -n 's/^Connect link: \\([^ ]*\\).*/\\1/p')"
show "On your Mac: Principia › Cloud › paste this connect link (10 minutes, once)" "$LINK"
echo "principia: waiting for your Mac (a new link: cd /opt/principia && docker compose exec principia principia-cloud pair)"
PHONE=
for _ in $(seq 1 120); do
  RC=0
  PHONE="$(docker compose exec -T principia principia-cloud phone-link 2>/dev/null)" || RC=$?
  # 0: here it is; 2: an image without phone-link; anything else (3: not paired yet, a hiccup of exec): try again
  case "$RC" in 0|2) break ;; esac
  sleep 5
done
PHONE="$(printf '%s' "$PHONE" | sed -n 's/^Phone link: \\([^ ]*\\).*/\\1/p')"
if [ -n "$PHONE" ]; then
  show "Your Mac is connected. On your phone: scan this, or open the link (10 minutes, once)" "$PHONE"
else
  echo "principia: no Mac connected yet. When it is: Principia › Cloud › Workspace › Open on your phone."
fi
echo "principia: installed $(date -u +%FT%TZ). Log: /var/log/principia-bootstrap.log"
}

principia_install "$@" </dev/null
`
}
