# Principia for iPhone (IOS.md)

A native app for the Phone feature (docs/REMOTE.md): watch the agents and keep the work going from the iPhone. It
talks to the same Phone API as the web phone app (`src/cloud/phone`), in hosted mode (RA6), so the Mac needs no change
beyond what the web app already uses. SwiftUI, iOS 26, Liquid Glass, no third-party code.

## What is in `ios/`

| Path | What |
|---|---|
| `project.yml` | XcodeGen project (`xcodegen generate` makes `Principia.xcodeproj`, not committed) |
| `Principia/Core` | `PairLink` (the `#mac=&code=` link), `APIClient` (routes, bearer, errors), `LiveSocket` (WebSocket, auth first, backoff), `ChatReplica` (the Mac's chat ops, chat lines), `Markdown` (blocks and AttributedString), `MacStore` (Keychain), `MacMove` (RA8: the Mac's new address, the hello proof, what counts as "the Mac is gone"), `Push` (client side), `DemoMac` (demo mode: the sample company behind the same transport and socket protocols) |
| `Principia/App` | `AppModel` (state and actions), `PrincipiaApp` |
| `Principia/UI` | Pair, signed-out and Waiting for your Mac screens, Now, the board (from Now), Needs you, Chats (chat, terminal, agent thread), Team room, Settings |
| `Principia/Resources` | Cinzel (static Medium and SemiBold instances, OFL), the asset catalog: engravings, persona busts, app icon (1024, no alpha); `PrivacyInfo.xcprivacy` |
| `PrincipiaTests` | Unit tests: link parsing, API client, the board's routes and decoding, socket auth order and reconnects, markdown, chat replica, the Mac's new address (error classification, words and move links, hello proof against the web app's fixture) |
| `PrincipiaLiveUITests` | UI tests against a real, paired Mac (scheme `PrincipiaLive`, skipped unless told where) |
| `PrincipiaDemoUITests` | Demo mode end to end, no Mac (scheme `PrincipiaDemo`; `TEST_RUNNER_PRINCIPIA_SHOTS=<folder>` saves each screen) |

`node scripts/ios-assets.mjs` copies the engravings (`src/cloud/phone/public/art`), every bust
(`src/cloud/console/busts.gen.ts`, as vector SVG) and the arch icon into the asset catalog. Run it when they change.
The Cinzel files are static instances of `src/cloud/phone/public/fonts/Cinzel-Variable.woff2` (weights 500 and 600,
made once with fontTools' `varLib.instancer`), because iOS does not load woff2.

## How it talks to the Mac

- **Pairing.** The QR code (VisionKit's DataScanner) or a pasted link: `<site>/#mac=<the Mac's address>&code=<code>`.
  The app sends `POST /api/pair` to the Mac with `Origin: <site>`, exactly what the hosted web app sends, so the Mac
  returns the device token in the body. The token goes to the Keychain (this device only, after first unlock). No
  cookies, ever.
- **Calls.** `Authorization: Bearer <token>` and the same `Origin`. A 401 means signed out (the app forgets the
  token). Cloudflare answering for a gone tunnel (530, error 1033 as HTML or JSON, a 502/503/504 that is not the
  Mac's own JSON), a name that no longer resolves, a refused or timed-out connection: the Mac moved or is off (never a
  status code on screen; the token stays). No internet on the phone says so instead. A Mac's own error without a
  message reads "Your Mac could not do that just now".
- **Waiting for your Mac** (REMOTE.md RA8). When the Mac is gone the app shows this screen: type the words shown on
  the Mac under Paired phones (`quiet-tree-forty-two`, becomes `https://quiet-tree-forty-two.trycloudflare.com`),
  paste the move link (`<site>/#move=…`, only for this phone's site) or a full address, or scan the Mac's QR (a move
  link or a pairing link). The new address must answer `POST /api/hello {device, nonce}` (24 random bytes, base64url)
  with `hex HMAC-SHA256(key = sha256hex(token), "principia-hello-v1|<address>|<nonce>")`, compared in constant time,
  before the token goes there; then it is saved and REST and the live socket reconnect. A wrong proof, an unknown
  device (it forgets the Mac: pair again) or no answer never sends the token. Try again, Disconnect from this Mac (with
  a confirmation), and the last address is retried on the foreground and every 20 s. The live socket asks for the
  same check when two upgrades in a row fail that way.
- **Disconnect.** Settings opens full height; right under Your Mac: Disconnect from this Mac (this phone only, after a
  confirmation) and, while the Mac answers, Sign out on this phone and the Mac.
- **Live.** `wss://<mac>/api/live` with the same `Origin`; the first message is `{t:'auth', token}` (never the URL),
  then the subscription. A ping every 25 s, reconnect with backoff (0.5 s doubling, at most 15 s), and at once when the
  app comes back to the foreground. A 4401 close with no `bye` before it signs out; `bye` says Phone was turned off or
  this phone was revoked.
- **Links into the app.** `principia://pair?site=<site>#mac=…&code=…` pairs (the site defaults to the official one),
  `principia://pair?site=<site>#move=<the Mac's address>` checks and moves to the Mac's new address,
  `principia://tab/needs`, `principia://chat/session/<id>`, `principia://chat/agent/<id>`, `principia://settings`.
- **A terminal on the Mac** reads as its chat (REMOTE.md RA3): its transcript through the same replica and ops, its
  screen (`{t:'screen'}`) until it has one (an empty `{t:'chat'}` reloads it), its open asks as cards, a composer
  whenever it runs (`…/send`; while it asks something the box shows why and Send is off; no Stop: that stays on the
  Mac), and Continue once it ended (`POST /api/c/:companyId/sessions/:sessionId/continue`, then the
  app follows the session it returns). An older Mac still gets the old card.
- **The board** (REMOTE.md RA3, read only): The board on Now opens Needs you, Working (with the agent and its live
  line), Planned and Done this week; a task shows its description, assignee, status, report and dates, and, when it
  waits on you, the same card as Needs you (Approve, Send back, answer, Not needed). `GET …/tasks` and `…/tasks/:taskId`.
- **Not needed** on a Needs you task calls `POST /api/c/:companyId/tasks/:taskId/cancel` (added with this app; the web
  app has it too): only a task that waits on you, only to canceled, reopen it from the Board.

## Build and run on the simulator

```bash
brew install xcodegen          # once
cd ios
xcodegen generate
xcodebuild -project Principia.xcodeproj -scheme Principia \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build CODE_SIGN_IDENTITY=- build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/Principia.app
xcrun simctl launch booted ai.principia.phone
```

`CODE_SIGN_IDENTITY=-` signs ad hoc: no team is needed, and the Keychain works (an unsigned build cannot keep the
token). Unit tests: the same command with `test` instead of `build`.

Lint: `swiftlint lint --config ios/.swiftlint.yml` from the repository root (errors fail, warnings are reported).

### CI

`.github/workflows/ios.yml` runs on pull requests and `main` pushes that touch `ios/` (called from Checks, so
`all-green` counts it when it ran): SwiftLint 0.65.1 in its container on ubuntu, then on `macos-15` with Xcode 26.2
`xcodegen generate` and the two commands above (`build`, then `test` on an iPhone simulator of the newest iOS 26+ runtime the image ships, created if the image has
none), with
DerivedData cached by `project.yml` and the sources. No Apple team, account or secret is involved. The
`PrincipiaLiveUITests` target is not run there: it needs a real, paired Mac. When the runner image changes its Xcode
versions, update `DEVELOPER_DIR` and the DerivedData cache key in that file together.

### Check it against your Mac (simulator)

The simulator reaches the Mac's `127.0.0.1`, so no tunnel is needed:

1. In a test Principia (never your daily one), set Settings › App › Phone › Phone app address to a loopback site, for
   example `http://127.0.0.1:5199` (serve the web phone app there with `npm run preview:phone-site -- --port 5199` if
   you want the browser too), and turn Phone on. Do not press Share over the internet.
2. Copy the pairing link (`http://127.0.0.1:5199/#mac=…&code=…`) and open it in the app: paste it on the pairing
   screen, or `xcrun simctl openurl booted 'principia://pair?site=http%3A%2F%2F127.0.0.1%3A5199#mac=…&code=…'`.
3. Debug builds also read `SIMCTL_CHILD_PRINCIPIA_OPEN_URL=principia://…` at launch (and `SIMCTL_CHILD_PRINCIPIA_AUTOPAIR=1`
   to press Pair), so `xcrun simctl launch` can open any screen without a tap.
4. UI tests against that Mac: `TEST_RUNNER_PRINCIPIA_OPEN_URL=principia://chat/session/<id> xcodebuild test -scheme
   PrincipiaLive …` taps Allow on a waiting permission; `TEST_RUNNER_PRINCIPIA_SHOTS=<folder>` saves the dialogs.

The camera does not scan in the simulator (the scan sheet says so); paste the link there.

## On your own iPhone

1. Open `ios/Principia.xcodeproj` in Xcode (after `xcodegen generate`), select the Principia target › Signing &
   Capabilities, tick Automatically manage signing and choose your Team (your Apple ID; add it in Xcode › Settings ›
   Accounts). If `ai.principia.phone` is taken for a personal team, change the bundle id to one of yours. Do not commit
   your team id: set it in Xcode, or in `project.yml` locally only.
2. Plug in the iPhone, trust the Mac, turn on Developer Mode (Settings › Privacy & Security), pick it as the run
   destination and press Run. A free Apple ID works from Xcode, and the app expires after 7 days; a paid developer
   account ($99/year) lasts a year and allows command-line device builds.
3. On the Mac: Settings › App › Phone, turn it on and Share over the internet. The Phone app address stays the official
   one (`https://principia-phone.vibiz.dev`). Scan the QR code with the app's Scan button (not the Camera app, which
   would open Safari), and pair.
4. Optional: Settings in the app › Lock with Face ID.

### Push notifications (deferred)

The client side is wired: Settings › Allow notifications asks iOS, registers with APNs and hands the device token to
`PushRegistration`. Today that is `DeferredPushRegistration`, which keeps the token on the phone and sends nothing.
To turn pushes on:

- add the Push Notifications capability (Signing & Capabilities; needs the paid account) and an `aps-environment`
  entitlement;
- build the relay: the Mac cannot reach APNs on its own, so a small Principia relay holds the APNs key and sends
  "something needs you" (no work content: a count and an id, the app fetches the rest from the Mac); the app registers
  its token with the Mac, and the Mac tells the relay when to push;
- replace `DeferredPushRegistration` with a call to that registration; a tap opens `principia://tab/needs` or the chat.

## Demo mode ("Try it without a Mac")

The first screen offers **Try it without a Mac** under Scan and paste. It opens Northwind, a made-up company that
lives only in the app's memory: Now (who is working, what finished), the board, Needs you (a command to allow, a page
to approve, a question with choices), Chats (open "Plan this week" and its reply streams in and finishes; anything
typed gets an honest, streamed answer), and the Team room. `DEMO` sits next to the company on every tab; tapping it,
the card on Now, or Settings › Leave the demo returns to the pairing screen. Opening a pairing link from the demo pairs
as usual and leaves it.

It is `Principia/Core/DemoMac.swift`: a `DemoTransport` (the `HTTPTransport` the real API client uses) and a
`DemoLiveConnector` (the `LiveConnector` the live socket uses) answer from memory, so every screen runs the real code.
The demo's address is `https://demo.principia.invalid` (a reserved name that never resolves), nothing goes to the
Keychain or the last-company preference, and no URLSession or socket is created. `DemoModeTests` checks that the real
transport and connector are never touched; `PrincipiaDemoUITests` walks it like a reviewer would. Debug builds also
open it at launch with `SIMCTL_CHILD_PRINCIPIA_DEMO=1`.

## TestFlight

Anyone can install the app from a public TestFlight link before the App Store has it. Apple reviews the first build
for external testers (Beta App Review, usually within a day or two); the demo mode is what the reviewer uses, since
they have no Mac to pair.

What is ready in the repository:

- `ITSAppUsesNonExemptEncryption: false` (project.yml, Info.plist): the app uses only standard HTTPS/TLS (URLSession,
  WebSocket) and HMAC-SHA256 from CryptoKit for the Mac's hello proof. That is exempt, so TestFlight asks no export
  compliance question.
- `Principia/Resources/PrivacyInfo.xcprivacy`: no tracking, no collected data (the app talks only to the user's own
  Mac), and the one required-reason API it uses: UserDefaults (`CA92.1`, its own settings). The Keychain holds the
  Mac's address and device key.
- The app icon: `AppIcon.appiconset/icon-1024.png`, 1024 × 1024, no alpha, the white line arch on near-black
  (`scripts/ios-assets.mjs` makes it from `src/cloud/phone/public/icon.svg`).
- Permission strings: camera (scan the pairing code), Face ID (the optional lock), local network (a Mac on the same
  network). Notifications need no string.
- Versions: `MARKETING_VERSION` in project.yml is the App Store version (0.1.0); the build number
  (`CURRENT_PROJECT_VERSION`) is the testflight workflow's run number, a new one every upload.
- `scripts/ios-testflight.mjs` (`npm run release:ios`): `xcodegen generate`, `xcodebuild archive` (Release, generic
  iOS, automatic signing with `-allowProvisioningUpdates` and the API key), `xcodebuild -exportArchive` with an
  ExportOptions plist (`method` app-store-connect), then `xcrun altool --upload-app` with the same key. `--dry-run`
  prints every command with the credentials as placeholders; `--unsigned` archives with `CODE_SIGNING_ALLOWED=NO`
  (no Apple account; proves the Release build and checks the archive holds the privacy manifest and icons);
  `--skip-upload` stops at the .ipa. Output goes to `ios/build/testflight` (git-ignored).
- `.github/workflows/testflight.yml`: by hand (Actions › testflight › Run workflow) or on a tag `ios-vX.Y.Z`, in the
  `release` environment (it waits for approval), with pinned actions, read-only permissions, a temporary keychain for
  the certificate Xcode fetches and the key in the runner's temp folder, both deleted at the end.
- The privacy policy for the app record: `website/public/privacy/index.html`, served at
  `https://useprincipia.com/privacy/` (website/README.md).

### One time: the Apple side

1. **Join the Apple Developer Program** ($99 a year): [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll),
   as an individual or as the company (a company needs its D-U-N-S number). Wait for the approval email.
2. **Register the bundle id.** [developer.apple.com/account](https://developer.apple.com/account) › Certificates,
   Identifiers & Profiles › Identifiers › **+** › App IDs › App › Continue. Description `Principia`, Bundle ID
   **Explicit** `ai.principia.phone`, no capabilities › Continue › Register.
3. **Create the app record.** [appstoreconnect.apple.com](https://appstoreconnect.apple.com) › Apps › **+** › New App:
   Platforms iOS, Name `Principia` (if taken, something like `Principia: Company Agents`), Primary Language English
   (U.S.), Bundle ID `ai.principia.phone`, SKU `principia-ios`, User Access Full Access › Create.
4. **Privacy.** In the app › App Privacy: Privacy Policy URL
   `https://useprincipia.com/privacy/`. Data Collection
   › Get Started › **No, we do not collect data from this app** › Save › Publish.
5. **The API key.** App Store Connect › Users and Access › Integrations › App Store Connect API › Team Keys (the first
   time, the Account Holder clicks Request Access) › **+** (Generate API Key): name `Principia CI`, access **App
   Manager** › Generate. Download the `.p8` (only possible once), and note the **Key ID** (in the row) and the
   **Issuer ID** (above the table). The Mac release can use the same key (docs/RELEASING.md §3.2); if it already has
   one with a lower role, make this one and replace the three secrets.
6. **The team id.** developer.apple.com/account › Membership details › **Team ID** (10 characters). Never commit it.
7. **GitHub secrets**, in the `release` environment (Settings › Environments › release), the same names as the Mac
   release:

   ```bash
   gh secret set APPLE_API_KEY_P8 --env release --repo Vibiz-ai/principia < AuthKey_<KEY ID>.p8
   gh secret set APPLE_API_KEY_ID --env release --repo Vibiz-ai/principia
   gh secret set APPLE_API_ISSUER --env release --repo Vibiz-ai/principia
   gh secret set APPLE_TEAM_ID --env release --repo Vibiz-ai/principia
   ```

If the archive step says the key may not create a certificate or profile, the key's role is too low for Xcode's
automatic signing on this account: generate one with the **Admin** role and set the three key secrets again.

### Each build: upload

- GitHub: Actions › testflight › Run workflow (on `main`), or tag a version:
  `git tag ios-v0.1.0 && git push origin ios-v0.1.0` (the tag's version replaces project.yml's). Approve the run in
  the `release` environment. The build number is the run number.
- Or from a Mac with the key: `APPLE_TEAM_ID=… APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_<KEY ID>.p8
  APPLE_API_KEY_ID=… APPLE_API_ISSUER=… npm run release:ios -- --build-number <higher than the last one>`.

App Store Connect › the app › TestFlight shows the build as Processing for 5 to 30 minutes, then Ready to Submit
(no export compliance question: the plist answers it).

### One time: the public link

1. TestFlight › **Test Information** (left column): Beta App Description (for example "Principia's iPhone app: watch
   your agents and keep the work going from your phone. Try it without a Mac from the first screen."), Feedback Email,
   Marketing URL `https://useprincipia.com`, Privacy Policy URL (as above).
2. Same page, **Beta App Review Information**: the contact's first and last name, phone and email (the founder's), and
   **Sign-in required: off**. Review Notes:

   > Principia for iPhone is a remote for the open-source Principia app on the user's own Mac. There is no account and
   > no server of ours. To review without a Mac, tap "Try it without a Mac" on the first screen: it opens a sample
   > company that runs entirely on the phone, with no network. Try Now and The board, Needs you (Allow, Approve, the
   > choices), Chats (open "Plan this week" to see a reply stream in, or type a message), and Team room. "DEMO" at the
   > top, or Settings › "Leave the demo and pair your Mac", goes back to the pairing screen. Pairing a real Mac needs
   > Principia for Mac (github.com/Vibiz-ai/principia) with Settings › App › Phone turned on; the camera scans the QR
   > code it shows. The camera is used only for that code.

3. TestFlight › **External Testing** › **+** › Create a group `Public` › in the group, Builds › **+** › pick the build
   › What to Test (one or two lines) › Submit for Review.
4. Once Beta App Review approves it (an email): the `Public` group › **Public Link** › Enable Public Link (optionally a
   tester limit) › copy `https://testflight.apple.com/join/…`.
5. Put the link in the README (the `TESTFLIGHT_LINK` placeholder under "Run from your phone") and on the website.

### Each later build

Upload as above, then add it to the `Public` group (or turn on automatic distribution in the group's settings). A new
build of the same version usually goes out without another full review; a new version may be reviewed again. Testers
with the TestFlight app get it automatically. Builds expire after 90 days, so upload at least that often.

## Not in this version

Images from the phone, starting new companies, settings, keys or terminals (RA3 holds for the app too), iPad layouts,
a widget or Live Activity for "working now", and the push relay above.
