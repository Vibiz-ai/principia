#!/usr/bin/env bash
# Principia Cloud on one GCE VM (CLOUD.md §12.1 self-host, run by us). Dry run by default; --apply executes.
#   bash cloud/deploy/gcp-vm.sh            # print the plan
#   bash cloud/deploy/gcp-vm.sh --apply    # create project, VM, firewall; build and start the stack with public https
#   bash cloud/deploy/gcp-vm.sh --apply ship   # re-copy the source and rebuild only
# The VM builds the images from source (the GHCR images are not published yet), so it needs both checkouts next to
# each other: hive (this repo) and ../open-passport. Public https comes from Caddy with sslip.io names on the VM's
# static IP until a real domain exists: cloud.<ip>.sslip.io and passport.<ip>.sslip.io.
# Settings: PROJECT, ORG, BILLING (required for the project step), ZONE, VM, MACHINE, from the environment or from
# cloud/deploy/.env.gcp (gitignored, plain KEY=value lines).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
hive="$(cd "$here/../.." && pwd)"
op="$(cd "$hive/../open-passport" && pwd)"
if [ -f "$here/.env.gcp" ]; then
  while IFS='=' read -r k v; do
    case "$k" in PROJECT|ORG|BILLING|ZONE|VM|MACHINE) [ -n "${!k:-}" ] || export "$k=$v" ;; esac
  done < "$here/.env.gcp"
fi

PROJECT="${PROJECT:-principia-cloud}"
ORG="${ORG:-}"
BILLING="${BILLING:-}"
ZONE="${ZONE:-us-central1-a}"
REGION="${ZONE%-*}"
VM="${VM:-principia-cloud}"
MACHINE="${MACHINE:-e2-medium}"
IP_NAME="$VM-ip"

APPLY=0
steps=()
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    project|network|vm|ship) steps+=("$a") ;;
    *) echo "unknown argument: $a" >&2; exit 64 ;;
  esac
done
[ ${#steps[@]} -eq 0 ] && steps=(project network vm ship)

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() { printf '  $ %s\n' "$*"; if [ "$APPLY" = 1 ]; then "$@"; fi; }
G=(gcloud --project "$PROJECT" --quiet)

has() { for s in "${steps[@]}"; do [ "$s" = "$1" ] && return 0; done; return 1; }

if has project; then
  if [ "$APPLY" = 1 ] && { [ -z "$ORG" ] || [ -z "$BILLING" ]; }; then echo "ORG and BILLING are required for the project step" >&2; exit 64; fi
  say "Project $PROJECT (org ${ORG:-<ORG>}, billing ${BILLING:-<BILLING>})"
  if [ "$APPLY" = 1 ] && gcloud projects describe "$PROJECT" >/dev/null 2>&1; then echo "  = exists"
  else run gcloud projects create "$PROJECT" --name="Principia Cloud" --organization="$ORG"; fi
  run gcloud billing projects link "$PROJECT" --billing-account="$BILLING"
  run "${G[@]}" services enable compute.googleapis.com
fi

if has network; then
  say "Static IP $IP_NAME and firewall for 80/443"
  if [ "$APPLY" = 1 ] && "${G[@]}" compute addresses describe "$IP_NAME" --region "$REGION" >/dev/null 2>&1; then echo "  = ip exists"
  else run "${G[@]}" compute addresses create "$IP_NAME" --region "$REGION"; fi
  if [ "$APPLY" = 1 ] && "${G[@]}" compute firewall-rules describe allow-web >/dev/null 2>&1; then echo "  = firewall exists"
  else run "${G[@]}" compute firewall-rules create allow-web --allow=tcp:80,tcp:443 --target-tags=web; fi
fi

if has vm; then
  say "VM $VM ($MACHINE, Debian 12, 30 GB, Docker)"
  if [ "$APPLY" = 1 ] && "${G[@]}" compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then echo "  = vm exists"
  else
    run "${G[@]}" compute instances create "$VM" --zone "$ZONE" --machine-type "$MACHINE" \
      --image-family debian-12 --image-project debian-cloud --boot-disk-size 30GB --tags web \
      --address "$IP_NAME" --shielded-secure-boot \
      --metadata startup-script='#!/bin/bash
command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh)'
  fi
fi

if has ship; then
  say "Copy hive and open-passport source, build, start with Caddy"
  ip='<IP>'
  [ "$APPLY" = 1 ] && ip="$("${G[@]}" compute addresses describe "$IP_NAME" --region "$REGION" --format='value(address)')"
  tarball="${TMPDIR:-/tmp}/principia-cloud-src.tgz"
  # the working trees as they are (uncommitted work included), but only what git tracks or would track: .gitignore
  # keeps out dev data dirs (.hive-dev-data holds app data), node_modules, build output and local env files
  list() { git -C "$1" ls-files -co --exclude-standard -z | grep -zvE '^(docs/qa/|website/|site/screenshots/)' | D="$1" P="$(basename "$1")/" perl -0ne 'chomp; print "$ENV{P}$_\0" if -e "$ENV{D}/$_"'; }
  printf '  $ (git ls-files of hive and open-passport) | tar -czf %s\n' "$tarball"
  if [ "$APPLY" = 1 ]; then
    { list "$hive"; list "$op"; } | tar -czf "$tarball" -C "$(dirname "$hive")" --no-recursion --null -T -
  fi
  if [ "$APPLY" = 1 ]; then
    for _ in $(seq 1 30); do "${G[@]}" compute ssh "$VM" --zone "$ZONE" --command 'command -v docker' >/dev/null 2>&1 && break; sleep 10; done
  fi
  run "${G[@]}" compute scp "$tarball" "$VM:~/src.tgz" --zone "$ZONE"
  remote="set -e; sudo rm -rf /opt/principia-src; sudo mkdir -p /opt/principia-src; sudo tar -xzf ~/src.tgz -C /opt/principia-src
cd /opt/principia-src/$(basename "$hive")
export OPEN_PASSPORT_SRC=../../$(basename "$op") PRINCIPIA_DOMAIN=cloud.$ip.sslip.io PASSPORT_DOMAIN=passport.$ip.sslip.io
sudo -E docker compose -f cloud/compose.yml -f cloud/compose.build.yml --profile caddy up --build -d
sleep 5; sudo docker compose -f cloud/compose.yml logs principia | grep -A1 'Connect link' | tail -2"
  run "${G[@]}" compute ssh "$VM" --zone "$ZONE" --command "$remote"
  echo
  echo "Principia Cloud: https://cloud.$ip.sslip.io/console    Passport: https://passport.$ip.sslip.io"
fi

[ "$APPLY" = 1 ] || echo -e "\nDry run complete. Re-run with --apply to execute."
