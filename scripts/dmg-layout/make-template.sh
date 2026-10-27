#!/bin/sh
# docs/RELEASING.md §5.5: regenerate build/dmg/DS_Store, the release dmg window's layout (which icon where, window
# size, toolbar hidden, the background picture). Run on a Mac only when build/dmg/layout.json changes:
#   npm run make:dmg-layout
# dmgbuild (pinned by hash in requirements.txt) goes into a throwaway venv, builds a scratch dmg named like the real
# one, and the .DS_Store it wrote is copied out (normalize.py points its background reference at /Volumes/<name>).
# Releases never run Python: scripts/mac-sign.mjs copies this file into the dmg.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/principia-dmg-layout.XXXXXX")
mnt="$work/mnt"
cleanup() {
  [ -d "$mnt" ] && hdiutil detach "$mnt" -quiet -force 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

python3 -m venv "$work/venv"
"$work/venv/bin/pip" install --quiet --disable-pip-version-check --no-deps --require-hashes --only-binary :all: -r "$root/scripts/dmg-layout/requirements.txt"

mkdir -p "$work/Principia.app"
volname=$(/usr/bin/plutil -extract volumeName raw -o - "$root/build/dmg/layout.json")
"$work/venv/bin/python" -I -m dmgbuild -s "$root/scripts/dmg-layout/settings.py" \
  -D layout="$root/build/dmg/layout.json" -D app="$work/Principia.app" -D background="$root/build/dmg/background.tiff" \
  "$volname" "$work/layout.dmg"

mkdir "$mnt"
hdiutil attach "$work/layout.dmg" -nobrowse -noautoopen -noverify -readonly -mountpoint "$mnt" -quiet
cp "$mnt/.DS_Store" "$work/DS_Store"
"$work/venv/bin/python" -I "$root/scripts/dmg-layout/normalize.py" "$work/DS_Store" "$volname"
cp "$work/DS_Store" "$root/build/dmg/DS_Store"
echo "wrote build/dmg/DS_Store"
