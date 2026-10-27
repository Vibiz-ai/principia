# Releasing Principia for macOS

How a Mac download gets from this repository to people's Macs: signed with our Developer ID, notarized by Apple
(so it opens with no Gatekeeper warning), published as a GitHub release, and picked up by the app's updater.

Once the one-time setup (§3) is done, a release is one command on your Mac (§5.1) or one tag pushed to GitHub
(§5.2).

## 1. What a release is

A GitHub release `vX.Y.Z` on https://github.com/Vibiz-ai/principia with:

| File | For |
| --- | --- |
| `Principia-arm64.dmg` | the website's Download button (always the newest, same name every release) |
| `Principia-X.Y.Z-arm64.dmg` | a versioned copy, for links to one exact version |
| `Principia-arm64.zip` | the updater installs from the zip (whole: differential downloads are off, so no blockmap) |
| `latest-mac.yml` | the updater reads this to learn the newest stable version (stable releases only) |
| `beta-mac.yml` | the same for people on the beta channel (§4.1); every release has it |
| `SHA256SUMS.txt` | the SHA-256 of every file above, to check a download (§5.3) |

Releases built by GitHub Actions (§5.2) also carry a **build-provenance attestation** for the dmg, the zip and
`SHA256SUMS.txt`: a Sigstore-signed statement that those exact bytes were built by this repository's `release`
workflow from the tagged commit (§5.3).

A release is created as a **draft**, every file is uploaded to it and checked there (names, sizes and SHA-256), and
only then is it published. With **immutable releases** on (Settings › General › Releases), a published release can
never gain, lose or replace a file and its tag can never move, so nothing is ever added after publishing: a fix is a
new version. That includes `latest-mac.yml`: it cannot be edited in place.

Because the names stay the same, these links always point at the newest release:

- https://github.com/Vibiz-ai/principia/releases/latest/download/Principia-arm64.dmg
- https://github.com/Vibiz-ai/principia/releases/latest/download/latest-mac.yml

A beta (`vX.Y.Z-beta.N`) is published as a GitHub **pre-release** (§4.1). GitHub's `releases/latest` never points at a
pre-release, so the links above and the stable updater feed always stay on the newest stable release.

Apple Silicon only, macOS 13 (Ventura) or later.

## 2. Signing and entitlements

`scripts/mac-sign.mjs` signs a release with Apple's `codesign`, inside-out: every Mach-O file and nested bundle
first (the Electron framework and its libraries, the helper apps, Squirrel's ShipIt, the database and terminal native
modules, node-pty's `spawn-helper`), each with `build/entitlements.mac.inherit.plist`, then the app itself with
`build/entitlements.mac.plist`. Everything gets the **hardened runtime** (Apple requires it for notarization) and a
secure timestamp. electron-builder only builds the app, unsigned (§5.1). The entitlements grant only what Principia
needs; `electron-builder.yml` says why for each one:

- **allow-jit**: JavaScript (V8) needs it, in the app, its helpers, and the MCP servers Principia runs on its own
  binary.
- **automation.apple-events** (app only): agents in Principia's terminals may use `osascript`; macOS asks the
  founder first.

Not granted: `allow-unsigned-executable-memory` and `disable-library-validation`. Every library Principia loads
(Electron, the database and terminal modules) is inside the app and signed with the same Developer ID, and the
`claude` / `codex` CLIs run as separate programs with their own signatures.

The dry run (§6) signs ad-hoc, without a certificate. An ad-hoc signature has no Team ID, so that build alone uses
`build/entitlements.mac.adhoc.plist`, which adds `disable-library-validation`. Without it macOS refuses to load
Electron into an ad-hoc hardened app. It is never used for a release.

No certificate name, team ID, key or password is ever written in this repository. They come from your keychain and
environment when you release.

## 3. One-time setup

You need the Account Holder role in the Apple Developer team that publishes Principia, and Xcode installed.

### 3.1 The Developer ID Application certificate

1. Open Xcode › Settings › Accounts. Add your Apple ID if it is not there.
2. Select the team, then **Manage Certificates…**
3. Click **+** › **Developer ID Application**. Xcode creates the certificate and puts it with its private key in
   your login keychain.
4. Check it is there:

   ```sh
   security find-identity -v -p codesigning
   ```

   One line reads `"Developer ID Application: <Team name> (<TEAM ID>)"`.

Back up the certificate with its key (Keychain Access › My Certificates › right-click › Export, as a .p12 with a
strong password), and keep the backup somewhere safe outside any repository. Losing it means making a new one.

### 3.2 The App Store Connect API key (for notarization)

1. Open App Store Connect › Users and Access › Integrations › App Store Connect API › **Team Keys**.
2. Click **+** (Generate API Key). Name: `Principia notarization`. Access: **Developer**.
3. Download the key (`AuthKey_<KEY ID>.p8`). Apple lets you download it **once**.
4. Note the **Key ID** (in the key's row) and the **Issuer ID** (above the table).
5. Put the key outside every repository and make it private to you:

   ```sh
   mkdir -p ~/.appstoreconnect/private_keys
   mv ~/Downloads/AuthKey_<KEY ID>.p8 ~/.appstoreconnect/private_keys/
   chmod 700 ~/.appstoreconnect/private_keys
   chmod 600 ~/.appstoreconnect/private_keys/AuthKey_<KEY ID>.p8
   ```

### 3.3 The environment

Keep the values in a file outside the repository, readable only by you:

```sh
cat > ~/.principia-release.env <<'EOF'
export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_<KEY ID>.p8"
export APPLE_API_KEY_ID="<KEY ID>"
export APPLE_API_ISSUER="<ISSUER ID>"
# only if the keychain holds more than one Developer ID Application certificate:
# export CSC_NAME="<Team name> (<TEAM ID>)"      (without the "Developer ID Application: " prefix)
EOF
chmod 600 ~/.principia-release.env
```

Instead of the three `APPLE_API_*` variables you can store the key in the keychain once and use its name:

```sh
xcrun notarytool store-credentials principia-notary --key <path to .p8> --key-id <KEY ID> --issuer <ISSUER ID>
export APPLE_KEYCHAIN_PROFILE=principia-notary
```

Also sign in the GitHub CLI with an account that can publish releases on https://github.com/Vibiz-ai/principia: `gh auth login`.

## 4. App updates

The packaged app (`src/main/updates.ts`, policy in `src/shared/updates.ts`):

- checks 30 seconds after launch, then every 4 hours, by reading `latest-mac.yml` from the newest release;
- downloads a newer version in the background;
- shows one quiet toast, **Update ready - restart to install**, with a **Restart** button;
- Settings › About shows the version, the update state and **Check for updates**.

It never restarts by itself. **Restart** is refused while an agent session or a workflow run (running or queued) is
working, and says so. A downloaded update also installs when Principia quits normally.

macOS installs an update only when it is signed by the same Developer ID as the running app, so updates work from
the first signed release on. A build without a Developer ID (an ad-hoc preview, §6.2, or `npm run dist`) never downloads
updates it could not install: the updater asks `codesign` once (`appCannotSelfUpdate`), still checks, and on a newer
version says **A new version is out: download it from useprincipia.com** (phase `available`, a toast and Settings ›
About with **Download**). Updates are off in development builds and in test instances (`HIVE_USER_DATA`,
`HIVE_SMOKE`); `HIVE_NO_UPDATES=1` turns them off on a Mac.

### 4.1 Beta channel

Settings › About › **Get beta updates** (off by default, stored as `betaUpdates`).

- **Off**: the updater reads `releases/latest/download/latest-mac.yml`, the newest **stable** release. Someone already
  on a beta stays on it until a stable version is newer; the updater never downgrades.
- **On**: the updater reads the repository's release list (`releases.atom`, no API call and no rate limit), takes the
  newest stable or beta release, and reads its `beta-mac.yml`. Stable releases carry `beta-mac.yml` too, so beta users
  also get every stable release.

Which files a version publishes (`scripts/update-info.mjs`, tested in `scripts/update-info.test.mjs`):

| Version | GitHub release | Update manifests |
| --- | --- | --- |
| `0.3.0` | normal, marked latest | `latest-mac.yml` and `beta-mac.yml` |
| `0.3.0-beta.1` (`-beta` only: `-rc`/`-alpha` are refused, the updater's beta channel never offers them) | pre-release, never latest | `beta-mac.yml` only |

The policy lives in `src/shared/updates.ts` (`updateChannelPolicy`): channel `latest` or `beta`, `allowPrerelease`,
and `allowDowngrade` always false (electron-updater turns it on whenever the channel is set, so it is set back).

To ship a beta, push its tag (`git tag v0.3.0-beta.1 && git push origin v0.3.0-beta.1`, §5.2) or run
`npm run release:mac -- 0.3.0-beta.1`. `package.json` is not changed for a beta: the version comes from the tag.
Dogfood a beta on your own Macs first (turn the switch on in each one).

## 5. Releasing

There are two ways to run the same release script, `scripts/release-mac.mjs`. Both publish exactly the same files.

### 5.1 From your Mac

Run it in a **separate checkout**, never the folder your own Principia runs from: the build replaces `out/`, which
a running Principia loads its pages and MCP servers from. The script refuses when it sees a Principia running from
the folder. Use a clean clone of the public repository, so the release matches the published source:

```sh
git clone https://github.com/Vibiz-ai/principia ~/principia-release   # once
cd ~/principia-release
git pull && npm ci
```

Then the one command:

```sh
source ~/.principia-release.env
npm run release:mac -- 0.2.0
```

Add `--notes notes.md` to use your own release notes (otherwise GitHub writes them from the commits).

What it does, stopping at the first problem (nothing is published unless every step passes):

1. **Preflight**: clean working tree; the version is new and higher than the latest release; a Developer ID
   Application certificate in the keychain; notary credentials set (the key outside the repository, `chmod 600`);
   `gh` signed in; Xcode tools present.
2. **Build** the app **unsigned** into `release/<version>/mac-arm64/` (electron-builder, identity off). The version
   comes from the command, so `package.json` is not edited (release-please bumps it, §5.2).
3. **Sign and package** (`scripts/mac-sign.mjs`, Apple's tools only): sign the app inside-out with the hardened
   runtime (§2); notarize it (`xcrun notarytool submit --wait`) and staple the ticket; zip the stapled app for the
   updater (`ditto`); make the dmg (`hdiutil`: the app, an Applications link and the install window of §5.5); sign,
   notarize and staple the dmg.
   A rejected notarization prints Apple's log and stops.
4. **Verify**: `codesign --verify --deep --strict` on the app and on the app inside the zip, hardened runtime, Team
   ID and entitlements; `spctl` must report `source=Notarized Developer ID` for the app and the dmg; `stapler
   validate` on the app, the zip's app and the dmg; the app's version.
5. **Update manifests and checksums**: writes `latest-mac.yml` and `beta-mac.yml` (a beta: `beta-mac.yml` only) with
   the zip's sha512 and size (`scripts/update-info.mjs`), then `SHA256SUMS.txt` for the dmg (both names), the zip and
   the manifests, checked with `shasum -a 256 -c`.
6. **Draft, then publish**: `gh release create vX.Y.Z --draft` with all those files and `SHA256SUMS.txt` (a beta:
   `--prerelease --latest=false`); checks the draft holds exactly them (sizes and SHA-256 as GitHub reports them); then
   publishes the draft (`gh release edit vX.Y.Z --draft=false`) and checks that the site's download link answers. A
   draft left by an earlier failed attempt (or made by release-please) was never public and is replaced, keeping its
   notes. If a run stops after the draft was made, `npm run release:mac -- 0.2.0 --publish-draft` checks and publishes
   it without building again.

The stages can also run apart, which is what GitHub Actions does (§5.2): `--build-only` stops after step 2, and
`--prepackaged <Principia.app>` starts at step 3 with an app built elsewhere (it must be outside `release/<version>/`,
which is emptied, and carry the release's version).

Notarization usually takes a few minutes per file.

### 5.2 From GitHub (push a tag)

`.github/workflows/release.yml` runs the same script on GitHub-hosted Apple Silicon Macs for a `v*` tag, split so
that no dependency's code ever runs next to the signing secrets:

| Job | Secrets | What runs |
| --- | --- | --- |
| **build** | none (no environment, read-only token) | `npm ci` (every package's install scripts), then `release-mac.mjs --ci --build-only`: the unsigned `Principia.app`, archived with `ditto` and uploaded as an artifact; its SHA-256 goes to the next job as an output |
| **sign-and-publish** | the `release` environment: approval, certificate, notary key | **no `npm ci`, no `node_modules`**: a checkout for the release scripts (Node built-ins and Apple's tools only). Downloads the app and checks its SHA-256, imports the certificate into a temporary keychain, runs `release-mac.mjs --ci --prepackaged <app> --draft-only` (steps 3 to 6 of §5.1), deletes the keychain and key, attests the files, publishes the draft |
| **post-release** | none (`actions: write` only) | dispatches `post-release.yml` (§5.4) |

The certificate is imported into a temporary keychain made for the job (random password), the API key is written to
the runner's temp folder with `chmod 600`, and both are deleted right after signing even if a step fails. In this mode
(`--ci`) the script releases only the run's tag, refuses to build and sign in one process, and signs only with the
identity in that temporary keychain.

The split protects the certificate and the notary key from a compromised dependency. It does not make the build
trustworthy by itself: the app is what `npm ci` and the build produced from `package-lock.json`, which is why the
lockfile needs the code owner's review (§9) and pull requests run dependency review.

**Once: add the secrets** to Settings › Environments › `release` › Environment secrets (never as repository secrets):

| Secret | Value |
| --- | --- |
| `MAC_CERT_P12_BASE64` | the Developer ID Application certificate with its private key, as a .p12, base64-encoded |
| `MAC_CERT_PASSWORD` | the password you gave the .p12 when exporting it |
| `APPLE_API_KEY_P8` | the whole text of `AuthKey_<KEY ID>.p8` (§3.2), including the BEGIN/END lines |
| `APPLE_API_KEY_ID` | the key's Key ID |
| `APPLE_API_ISSUER` | the Issuer ID |

To make the .p12 (on the Mac that holds the certificate, §3.1):

1. Keychain Access › login › **My Certificates**. Expand `Developer ID Application: <Team name> (<TEAM ID>)` and check
   it shows its private key.
2. Select the certificate (not the key alone), right-click › **Export…**, format **Personal Information Exchange
   (.p12)**, and give it a long random password. That password is `MAC_CERT_PASSWORD`.
3. Store it as a secret straight from the file, without it ever touching the clipboard or a repository, then delete the
   file:

   ```sh
   base64 -i ~/Desktop/principia-developer-id.p12 | gh secret set MAC_CERT_P12_BASE64 --env release --repo Vibiz-ai/principia
   gh secret set MAC_CERT_PASSWORD --env release --repo Vibiz-ai/principia          # paste the password when asked
   gh secret set APPLE_API_KEY_P8 --env release --repo Vibiz-ai/principia < ~/.appstoreconnect/private_keys/AuthKey_<KEY ID>.p8
   gh secret set APPLE_API_KEY_ID --env release --repo Vibiz-ai/principia
   gh secret set APPLE_API_ISSUER --env release --repo Vibiz-ai/principia
   rm -P ~/Desktop/principia-developer-id.p12
   ```

**Each release (release-please):** `.github/workflows/release-please.yml` keeps one pull request open, titled
`chore(main): release …`. It bumps the version in `package.json` / `package-lock.json` and adds the changelog
section to `CHANGELOG.md`, from the Conventional Commit titles merged since the last release (`feat` → minor while
below 1.0, `fix` → patch, `feat!` → breaking; CONTRIBUTING.md). Config: `release-please-config.json` and
`.release-please-manifest.json` (the current version).

1. Review the release pull request like any other and merge it when you want to ship.
2. release-please then creates the tag `vX.Y.Z` on the merge commit and a **draft** release holding the changelog
   section. A draft, because a published release could never gain the dmg and zip with immutable releases on.
3. It starts `release.yml` on that tag itself (workflow_dispatch). A tag created with the workflow's `GITHUB_TOKEN`
   triggers no other workflow; dispatch is GitHub's one exception, so no personal token or GitHub App is needed. The
   `Protect release tags` ruleset blocks moving and deleting `v*` tags, not creating them, so release-please may
   create the tag.
4. Open Actions › **release**, check the run is for the tag you meant, and **Approve and deploy**. The release keeps
   release-please's notes.

A pull request opened by `GITHUB_TOKEN` gets no `pull_request` Checks run either, so release-please.yml also
dispatches **Checks** on the release branch each time it opens or updates the pull request; `all-green` then shows on
it. To choose a version yourself, put `Release-As: 1.0.0` in the body of a commit merged to `main`.

**Or push a tag yourself** (a beta, or a release outside release-please): from an up-to-date `main` of the public
repository,

```sh
git checkout main && git pull
git tag v0.3.0-beta.1 && git push origin v0.3.0-beta.1
```

then approve the run as above. The **build** job's log shows the preflight and build (§5.1 steps 1-2); the
**sign-and-publish** job's log shows signing, notarization, verification and the draft (steps 3-6, `--draft-only`).
Then that job deletes the keychain and the API key, attests the dmg, zip and `SHA256SUMS.txt`
(`actions/attest-build-provenance`), and publishes the draft (`--publish-draft`). Tags `v*` cannot be moved or
deleted, so a failed run is fixed with a new version, not by re-tagging; if it failed after the draft was made, re-run
the failed jobs (the draft is replaced). The unsigned app artifact is kept 3 days. The `cloud-images`
workflow publishes the cloud image for the same tag; it uses the same `release` environment, so it waits for its own
approval.

### 5.3 Verifying a download

Anyone can check that a dmg or zip is the one this repository's release workflow built and published:

```sh
cd ~/Downloads
# 1. the checksums: download SHA256SUMS.txt from the same release, then
curl -fsSLO https://github.com/Vibiz-ai/principia/releases/latest/download/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt --ignore-missing      # "Principia-arm64.dmg: OK"

# 2. the build provenance (GitHub CLI): built by .github/workflows/release.yml in Vibiz-ai/principia
gh attestation verify Principia-arm64.dmg -R Vibiz-ai/principia \
  --signer-workflow Vibiz-ai/principia/.github/workflows/release.yml

# 3. the release itself (with immutable releases on): tag, commit and files as published
gh release verify vX.Y.Z -R Vibiz-ai/principia
gh release verify-asset vX.Y.Z Principia-arm64.dmg -R Vibiz-ai/principia
```

The cloud image is attested the same way: `gh attestation verify oci://ghcr.io/vibiz-ai/principia-cloud:X.Y.Z -R
Vibiz-ai/principia` ([CLOUD.md](CLOUD.md) §12.1).

### 5.4 Post-release verification

`.github/workflows/post-release.yml` checks every published release on a fresh GitHub-hosted Mac, downloading it the
way a person does: `releases/latest/download/...` for a stable release (and it checks that `releases/latest` is that
release), the tag's own download links for a beta. It checks:

- `SHA256SUMS.txt` against the dmg and zip, and `latest-mac.yml` / `beta-mac.yml` (version, sha512, size) against the
  zip;
- the dmg: `spctl -a -t open --context context:primary-signature` must say `source=Notarized Developer ID` (on a Mac
  with Gatekeeper assessments off spctl accepts anything, so the source is required), and `xcrun stapler validate`;
- the app inside the dmg and the app inside the updater zip: `codesign --verify --deep --strict`, `spctl -t exec`
  (notarized), `stapler validate`, and the version;
- `gh attestation verify` for the dmg and zip, signed by this repository's `release.yml`. A release published from a
  Mac (`npm run release:mac`) has no attestation; that is a warning, not a failure.

If anything fails it opens an issue, `Post-release verification failed for vX.Y.Z` (or comments on the open one), and
the run fails: then follow §8.1. It runs when a person publishes a release, and `release.yml` dispatches it after
publishing (a release published with the workflow's `GITHUB_TOKEN` fires no `release` event). Run it by hand from
Actions › **post-release** › Run workflow (empty tag: the latest release; untick *check-latest* to verify an older
stable release).

### 5.5 The dmg window and the app icon

Opening the dmg shows the standard install window: Principia on the left, the Applications folder on the right, a
white line-art arrow between them and "Drag Principia to Applications" on a near-black background; no toolbar,
sidebar or status bar; a fixed size; the app icon as the volume icon. It lives in `build/dmg/`:

| File | What it is | Made by |
| --- | --- | --- |
| `layout.json` | window position and size, icon size and positions, the text: the one place the numbers live | by hand |
| `background.tiff` | the window art at 1x (660×400) and 2x (1320×800) | `npm run make:icons` (`scripts/make-icons.swift`) |
| `DS_Store` | Finder's settings for the window, copied into the dmg as `.DS_Store` | `npm run make:dmg-layout` |

`scripts/mac-sign.mjs` (`makeDmg`) copies the three into the dmg with `build/icon.icns` as `.VolumeIcon.icns`, makes
it read-write (HFS+), mounts it without Finder seeing it (`-nobrowse`), writes the new volume's UUID into the
background bookmark of `.DS_Store` (Finder finds the picture by that UUID, and every dmg gets a new one), marks the
volume as having a custom icon (`xattr com.apple.FinderInfo`), detaches it and converts it to the compressed dmg
that is then signed, notarized and stapled exactly as before. Before building it checks the template places
`Principia.app` and `Applications` and was made for the volume name `Principia`; it stops otherwise.

Why a committed `.DS_Store` instead of generating one at release time: the signing job installs nothing (§5.2), and
dmgbuild (the tool that writes `.DS_Store` files) is Python from PyPI. The template is generated once, on a
maintainer's Mac, by `scripts/dmg-layout/make-template.sh`: it installs dmgbuild, ds_store and mac_alias into a
throwaway venv with `pip --require-hashes` (versions and SHA-256 in `scripts/dmg-layout/requirements.txt`), builds a
scratch dmg, copies its `.DS_Store` out and points its background reference at `/Volumes/Principia`. No Finder or
AppleScript automation is used anywhere. Regenerate it only when `layout.json` changes; `node --test
scripts/mac-sign.test.mjs` fails when the two disagree.

The app icon (`build/icon.icns`, `build/icon.png`) and the menu bar icon (`resources/trayTemplate*.png`) come from
the same script, `npm run make:icons`: the temple mark of the website, white line art on a cool graphite body on
Apple's macOS grid (824/1024 body, continuous corners), strokes snapped to the pixel grid below 128 px.

## 6. Dry run (no certificate needed)

```sh
npm run release:mac -- --dry-run
```

Does everything except Developer ID signing, notarizing and publishing: the build is signed ad-hoc with the
hardened runtime, verified, and the `gh release create` command it would run is printed. Gatekeeper rejects an
ad-hoc build; that is expected.

To try the packaged app without touching your own data:

```sh
HIVE_USER_DATA=/tmp/principia-try HIVE_NO_SCHEDULER=1 \
  release/<version>/mac-arm64/Principia.app/Contents/MacOS/Principia --use-mock-keychain
```

`--use-mock-keychain` keeps a test copy away from the keychain item your installed Principia uses (otherwise macOS
asks for your password, because the test copy is signed differently). `HIVE_UPDATES_IN_TEST=1` turns on update
checks in such a test copy, to try the updater; it can only ever replace that copy.

### 6.1 Packaged-app smoke test

```sh
npm run pack:dir                # unsigned Principia.app in release/mac-arm64 (no dmg, no signing, no notarization)
npm run smoke:packaged          # Playwright drives it: e2e/packaged.spec.ts
```

The test launches the packaged app with a throwaway `HIVE_USER_DATA`, `HIVE_NO_SCHEDULER=1` and
`--use-mock-keychain`, makes no AI or network calls, and checks: the window opens from the asar with the bridge and
no Node in the renderer, Home renders, the database opens and takes a new company, a shell terminal spawns through
node-pty and echoes, no uncaught errors, and the app quits with exit code 0. It takes a few seconds. To test another
build: `PRINCIPIA_APP=/path/to/Principia.app npm run smoke:packaged` (or `-- -c.directories.output=<dir>` on
`pack:dir` to package elsewhere). On a failure, `test-results/e2e` has the app's log and the last screenshot.

CI (`.github/workflows/smoke.yml`, macOS) runs it nightly on `main`, and from Checks on pull requests and `main` pushes
that touch `src/main`, `src/preload`, `build/`, `electron-builder.yml`, `electron.vite.config.ts`, `package.json`,
`package-lock.json` or the test itself. `all-green` counts it when it ran.

### 6.2 Unsigned preview (before the Developer ID exists)

A preview is the dry-run build (ad-hoc signature, hardened runtime, `build/entitlements.mac.adhoc.plist`) at a
`X.Y.Z-preview.N` version, published by hand as a GitHub **pre-release** so `releases/latest` never serves it:

- build: the §6 steps with `-c.extraMetadata.version=X.Y.Z-preview.N` (package.json is not changed, so release-please
  is unaffected), then `packageRelease` from `scripts/mac-sign.mjs` with identity `-` and the adhoc entitlements;
- assets: `Principia-X.Y.Z-preview.N-arm64.dmg`, the zip and `SHA256SUMS.txt`, never `latest-mac.yml` /
  `beta-mac.yml` (the app cannot update itself, §4);
- check it first: `npm run smoke:packaged` with `PRINCIPIA_APP`, and Gatekeeper on a quarantined copy (it is rejected:
  people open it once through System Settings › Privacy & Security › **Open Anyway**);
- `gh release create vX.Y.Z-preview.N --draft --prerelease ...`, check the assets' digests, then publish it with
  `make_latest=false`. `release.yml` and `cloud-images.yml` ignore `v*-preview.*` tags and `post-release.yml` skips them.

The website links the preview's exact asset (website README, "Download").

## 7. The website

The site (https://useprincipia.com) serves the build named by `RELEASE` in `website/src/main.tsx`: `'preview'` (the
unsigned preview's exact asset, with the Open Anyway steps), `'signed'` or `'none'`. After the first
`npm run release:mac` succeeds, set `RELEASE = 'signed'` and deploy. Later releases need nothing on the site: the
button then always points at `releases/latest/download/Principia-arm64.dmg`.

## 8. If something fails

- **The release run fails at preflight with "no Developer ID Application certificate"**: the .p12 holds the
  certificate without its private key, or it is a different certificate type. Export again (§5.2).

- **"no Developer ID Application certificate"**: §3.1. The certificate needs its private key on this Mac; a
  certificate downloaded from the developer website without the key does not sign.
- **Notarization rejected**: the script prints Apple's submission ID. See why with
  `xcrun notarytool log <submission id> --keychain-profile principia-notary` (or `--key/--key-id/--issuer`).
- **First launch of a signed release asks for your keychain password** (only on a Mac that ran an earlier unsigned
  or development Principia): choose Always Allow once. The signed app is a new program to the keychain.

### 8.1 Pulling a bad release (rollback)

electron-updater never moves anyone back to an older version, and with immutable releases a published release's
files can never be changed or removed. So a bad release is never "fixed in place": it is pulled from the download
links, and a fixed **newer** version replaces it.

1. **Stop new downloads**: point `releases/latest` back at the previous good release, and mark the bad one as a
   pre-release so it can never become latest again:

   ```sh
   gh release edit vX.Y.(Z-1) --repo Vibiz-ai/principia --latest           # the last good release
   gh release edit vX.Y.Z --repo Vibiz-ai/principia --prerelease --latest=false
   ```

   The website's Download button and the stable update feed (`releases/latest/download/...`) now serve the previous
   good release; Macs that have not updated yet stop being offered the bad one. Beta users still see it (the beta feed
   includes pre-releases) until the fix is out.
2. **Say so**: edit the bad release's notes to say it was pulled and why (`gh release edit vX.Y.Z --notes-file ...`;
   immutable releases lock the files and the tag, not the notes).
3. **Ship the fix as a new patch version**, `vX.Y.(Z+1)`: revert or fix on `main`, then release it as usual (§5.2; the
   release-please pull request, or a tag). Macs on the bad version update to it like any update. The whole path takes
   under 30 minutes plus Apple's notarization.
4. **If the bad build must not stay downloadable at all** (for example it leaks something), delete the release:
   `gh release delete vX.Y.Z --repo Vibiz-ai/principia` (keep the tag: the `Protect release tags` ruleset forbids
   deleting it, and the version number is never reused). Do this after step 1, so `releases/latest` never points at
   nothing.
5. **Check**: run Actions › post-release on the good release (§5.4) and download the dmg from the website once.

Never re-tag, never upload a replacement file under the same version, never edit `latest-mac.yml`: a version number
names one build forever.

## 9. Code owners

`.github/CODEOWNERS` names the founder as owner of everything that decides what ships and how it is signed:
`.github/` (workflows, Dependabot, this file), `scripts/release*`, `scripts/mac-sign*`, `scripts/update-info*`,
`scripts/prepare-public-release*`, `electron-builder.yml`, `build/entitlements*`, `package-lock.json`, the
release-please config, `cloud/Dockerfile` and `SECURITY.md`. It takes effect for merging once **Require review from
Code Owners** is on in the `main` ruleset. The public export (`scripts/prepare-public-release.mjs`) keeps the `@owner`
entries of this one file as they are.
