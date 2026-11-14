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
 */

export interface BootstrapInput {
  /** <ip>.sslip.io, your own domain pointing at the machine, or 'auto' (the script finds its public IPv4) */
  domain: string
  /** SHA-256 hex of the one-time admin token this Mac pairs with */
  adminTokenSha256: string
  /** the image to pull, e.g. ghcr.io/vibiz-ai/principia-cloud:0.4.8 */
  image: string
  /** the git ref of https://github.com/Vibiz-ai/principia to build from when the image cannot be pulled */
  sourceRef: string
  sourceRepo?: string
  workspaceName?: string
}

const SAFE = /^[A-Za-z0-9._:/@+-]{1,300}$/

/** Single-quoted for sh. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export function bootstrapScript(i: BootstrapInput): string {
  for (const [k, v] of Object.entries({ domain: i.domain, image: i.image, sourceRef: i.sourceRef, sourceRepo: i.sourceRepo ?? 'x' })) {
    if (!SAFE.test(v)) throw new Error(`Invalid ${k}`)
  }
  if (!/^[0-9a-f]{64}$/.test(i.adminTokenSha256)) throw new Error('Invalid admin token hash')
  const repo = i.sourceRepo ?? 'https://github.com/Vibiz-ai/principia.git'
  const name = (i.workspaceName ?? 'Principia Cloud').replace(/[^\w .-]/g, '').slice(0, 80) || 'Principia Cloud'
  return `#!/bin/bash
# Principia Cloud machine (docs/MACHINES.md). Made by the Principia app; nothing in this script is secret.
set -euo pipefail
exec > >(tee -a /var/log/principia-bootstrap.log) 2>&1
echo "principia: start $(date -u +%FT%TZ)"
export DEBIAN_FRONTEND=noninteractive
DOMAIN=${shq(i.domain)}
IMAGE=${shq(i.image)}
SOURCE_REPO=${shq(repo)}
SOURCE_REF=${shq(i.sourceRef)}
ADMIN_SHA256=${shq(i.adminTokenSha256)}
WORKSPACE_NAME=${shq(name)}
# auto: the machine's own public IPv4 (the provider gives it after the script was written)
if [ "$DOMAIN" = auto ]; then
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  case "$IP" in ''|10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*|100.*) IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)" ;; esac
  [ -n "$IP" ] || { echo "principia: no public IPv4"; exit 1; }
  DOMAIN="$(printf '%s' "$IP" | tr . -).sslip.io"
fi

# 1. keys only, and Docker
if [ -d /etc/ssh/sshd_config.d ]; then
  printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\nPermitRootLogin prohibit-password\\n' > /etc/ssh/sshd_config.d/10-principia.conf
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi
passwd -l root >/dev/null 2>&1 || true
if ! command -v docker >/dev/null 2>&1; then
  for n in 1 2 3 4 5; do curl -fsSL https://get.docker.com | sh && break; echo "principia: docker install failed, retry $n"; sleep 10; done
fi
systemctl enable --now docker

# 2. no container reaches the metadata service
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
systemctl enable --now principia-metadata-block.service

# 3. the stack
mkdir -p /opt/principia
cd /opt/principia
PASSPORT=embedded
if ! docker pull "$IMAGE"; then
  echo "principia: $IMAGE is not published, building $SOURCE_REF from source"
  command -v git >/dev/null 2>&1 || { apt-get update -q && apt-get install -yq git; }
  rm -rf src op-stub
  git clone --depth 1 --branch "$SOURCE_REF" "$SOURCE_REPO" src
  mkdir -p op-stub/packages/js op-stub/packages/server
  docker build -f src/cloud/Dockerfile --build-context open-passport=op-stub -t principia-cloud:local src
  IMAGE=principia-cloud:local
  PASSPORT=
  echo source > install-kind
else
  echo published > install-kind
fi

cat > .env <<ENV
PRINCIPIA_IMAGE=$IMAGE
ENV
cat > principia.env <<ENV
PRINCIPIA_PUBLIC_URL=https://$DOMAIN
PRINCIPIA_ADMIN_TOKEN_SHA256=$ADMIN_SHA256
PRINCIPIA_WORKSPACE_NAME=$WORKSPACE_NAME
PRINCIPIA_PASSPORT=$PASSPORT
PRINCIPIA_DATA_DIR=/data
PRINCIPIA_SECRETS_DIR=/data/secrets
PRINCIPIA_WORKSPACE=/data/workspace
HOST=0.0.0.0
PORT=8787
ENV
chmod 600 principia.env
cat > Caddyfile <<CADDY
$DOMAIN {
  reverse_proxy principia:8787
}
CADDY
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
docker compose up -d
echo "principia: up at https://$DOMAIN $(date -u +%FT%TZ)"
`
}
