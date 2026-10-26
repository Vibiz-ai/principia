# Releasing Principia for macOS

How a Mac download gets from this repository to people's Macs: signed with our Developer ID, notarized by Apple
(so it opens with no Gatekeeper warning), published as a GitHub release, and picked up by the app's updater.

Once the one-time setup (§3) is done, a release is one command (§5).

## 1. What a release is

A GitHub release `vX.Y.Z` on https://github.com/Vibiz-ai/principia with:

| File | For |
| --- | --- |
| `Principia-arm64.dmg` | the website's Download button (always the newest, same name every release) |
| `Principia-X.Y.Z-arm64.dmg` | a versioned copy, for links to one exact version |
| `Principia-arm64.zip` + `.blockmap` | the updater installs from the zip |
| `latest-mac.yml` | the updater reads this to learn the newest version |

Because the names stay the same, these links always point at the newest release:

- https://github.com/Vibiz-ai/principia/releases/latest/download/Principia-arm64.dmg
- https://github.com/Vibiz-ai/principia/releases/latest/download/latest-mac.yml

Apple Silicon only, macOS 13 (Ventura) or later.

## 2. Signing and entitlements

`electron-builder.yml` turns on the hardened runtime (Apple requires it for notarization) and signs the app with
`build/entitlements.mac.plist` and every binary inside it with `build/entitlements.mac.inherit.plist`. They grant
only what Principia needs; `electron-builder.yml` says why for each one:

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

Also sign in the GitHub CLI with an account that can publish releases on https://github.com/example-org/principia: `gh auth login`.

## 4. App updates

The packaged app (`src/main/updates.ts`, policy in `src/shared/updates.ts`):

- checks 30 seconds after launch, then every 4 hours, by reading `latest-mac.yml` from the newest release;
- downloads a newer version in the background;
- shows one quiet toast, **Update ready - restart to install**, with a **Restart** button;
- Settings › About shows the version, the update state and **Check for updates**.

It never restarts by itself. **Restart** is refused while an agent session or a workflow run (running or queued) is
working, and says so. A downloaded update also installs when Principia quits normally.

macOS installs an update only when it is signed by the same Developer ID as the running app, so updates work from
the first signed release on. Updates are off in development builds and in test instances (`HIVE_USER_DATA`,
`HIVE_SMOKE`); `HIVE_NO_UPDATES=1` turns them off on a Mac.

## 5. Releasing

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
2. **Build** into `release/<version>/`: the app is signed with the hardened runtime, notarized by Apple and
   stapled; then the dmg and zip are made from it. The version comes from the command, so `package.json` is not
   edited (bump it afterwards in a normal pull request).
3. **The dmg** is signed, notarized and stapled too.
4. **Verify**: `codesign --verify --deep --strict` on the app, hardened runtime and entitlements, `spctl` (Gatekeeper)
   on the app and the dmg, `stapler validate` on both, `latest-mac.yml` and the app's version.
5. **Publish**: `gh release create vX.Y.Z` with the dmg (both names), zip, blockmap and `latest-mac.yml`, then checks
   that the site's download link answers.

Notarization usually takes a few minutes per file.

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

## 7. The website

The site's **Download for Mac** button is hidden until the first release exists, so the site never links to a
missing file. After the first `npm run release:mac` succeeds, set `RELEASE_PUBLISHED = true` in the website and
deploy it. Later releases need nothing on the site: the button always points at
`releases/latest/download/Principia-arm64.dmg`.

## 8. If something fails

- **"no Developer ID Application certificate"**: §3.1. The certificate needs its private key on this Mac; a
  certificate downloaded from the developer website without the key does not sign.
- **Notarization rejected**: the script prints Apple's submission ID. See why with
  `xcrun notarytool log <submission id> --keychain-profile principia-notary` (or `--key/--key-id/--issuer`).
- **First launch of a signed release asks for your keychain password** (only on a Mac that ran an earlier unsigned
  or development Principia): choose Always Allow once. The signed app is a new program to the keychain.
