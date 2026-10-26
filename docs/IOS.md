# Principia for iPhone (IOS.md)

A native app for the Phone feature (docs/REMOTE.md): watch the agents and keep the work going from the iPhone. It
talks to the same Phone API as the web phone app (`src/cloud/phone`), in hosted mode (RA6), so the Mac needs no change
beyond what the web app already uses. SwiftUI, iOS 26, Liquid Glass, no third-party code.

## What is in `ios/`

| Path | What |
|---|---|
| `project.yml` | XcodeGen project (`xcodegen generate` makes `Principia.xcodeproj`, not committed) |
| `Principia/Core` | `PairLink` (the `#mac=&code=` link), `APIClient` (routes, bearer, errors), `LiveSocket` (WebSocket, auth first, backoff), `ChatReplica` (the Mac's chat ops, chat lines), `Markdown` (blocks and AttributedString), `MacStore` (Keychain), `MacMove` (RA8: the Mac's new address, the hello proof, what counts as "the Mac is gone"), `Push` (client side) |
| `Principia/App` | `AppModel` (state and actions), `PrincipiaApp` |
| `Principia/UI` | Pair, signed-out and Waiting for your Mac screens, Now, the board (from Now), Needs you, Chats (chat, terminal, agent thread), Team room, Settings |
| `Principia/Resources` | Cinzel (static Medium and SemiBold instances, OFL), the asset catalog: engravings, persona busts, app icon |
| `PrincipiaTests` | Unit tests: link parsing, API client, the board's routes and decoding, socket auth order and reconnects, markdown, chat replica, the Mac's new address (error classification, words and move links, hello proof against the web app's fixture) |
| `PrincipiaLiveUITests` | UI tests against a real, paired Mac (scheme `PrincipiaLive`, skipped unless told where) |

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

### TestFlight (later)

Needs the paid account: an App Store Connect app record for the bundle id, an app icon and privacy answers (the app
collects nothing; everything stays between the phone and the Mac), then Product › Archive in Xcode and Distribute App ›
TestFlight. Testers install it from the TestFlight app.

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

## Not in this version

Images from the phone, starting new companies, settings, keys or terminals (RA3 holds for the app too), iPad layouts,
a widget or Live Activity for "working now", and the push relay above.
