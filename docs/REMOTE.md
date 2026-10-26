# Phone: this Mac on your phone (REMOTE.md)

A small web app on your phone to watch what the agents are doing and keep the work going: answer what needs you,
continue a chat, message an agent, talk in the team room. Everything else stays on the Mac.

## RA1. Amends SPEC A1 ("zero TCP listeners")

- **Off by default.** With Phone off, Principia opens no listener and starts no process for it. The CONTRACT §9
  `lsof -iTCP -sTCP:LISTEN` check stays empty. Once a phone is paired, "Turn Phone on when Principia starts" (RA8,
  default on from then) turns the server and the tunnel on at launch; with it off, every launch starts off as before.
- **On** (Settings › App › Phone, one switch): main starts one HTTP + WebSocket server bound to **127.0.0.1 only**, on a
  random port. Nothing on the network can reach it directly.
- **Reach it from the phone** (one button, "Share over the internet"): Principia runs `cloudflared tunnel --url
  http://127.0.0.1:<port>` (a quick tunnel: outbound only, a random `https://….trycloudflare.com` address). If
  `cloudflared` is not installed, the page says `brew install cloudflared`. Principia never downloads it.
- **Turn off** stops the tunnel and the server and closes every socket. Quitting does the same. Paired phones stay
  paired (RA2): they get back in when Phone is on again. Signing them out is its own action (Sign out all phones).
- The tunnel is the only outbound traffic Phone adds, and only while it is on. While it runs, `cloudflared` also opens
  its own metrics listener on `localhost` (20241-20245 by default), loopback only, and it closes with the tunnel.
- An address `cloudflared` prints in an error line (`https://api.trycloudflare.com`, its own service) is never taken as
  the tunnel address.

## RA2. Pairing and devices

- **Pair a phone**: the Mac shows a QR code and a link `<url>/#pair=<code>`. The code is random (128 bits), lives
  5 minutes and works once. Only the newest code works: New code cancels the earlier ones. It is in the URL fragment, so it never reaches a server log or the tunnel.
- The phone sends the code with a name ("My iPhone"), and gets a **device token** (256 bits) in an `httpOnly`,
  `Secure`, `SameSite=Strict` cookie. Only the SHA-256 of the token is kept, in hive.db (`phone_devices`: id, name,
  token hash, the previous hash and its grace, created, last seen, expires, revoked), so a phone stays paired across
  restarts and updates. The raw token is never written anywhere on the Mac (a test greps the database file).
- **Expiry.** A token lives 90 days after its last use; every request pushes it out (last seen is written at most once
  a minute). A phone unused for 90 days is signed out, and its hashes leave the disk at the next start.
- **Rotation on resume.** When the phone app opens it calls `POST /api/resume`: the Mac swaps the token for a new one
  (hosted: in the body; the Mac's own page: a new cookie). The old one works for 2 more minutes, and only until the new
  one is first used, so a lost answer never signs the phone out. The iPhone app (RA7) does not rotate yet; its token
  still expires 90 days after its last use.
- Writes need the CSRF header (`x-principia-csrf`, from `GET /api/me`, bound to the device). The WebSocket checks the
  cookie and the `Origin`.
- Wrong codes are rate limited per caller (5 a minute; through the tunnel the caller is Cloudflare's
  `CF-Connecting-IP`), with a ceiling of 60 a minute across everyone. A live code always pairs, so someone who found
  the address cannot lock the founder out by sending junk. A wrong or used code says "This link expired".
- Hosted mode (RA6) carries the same token as a bearer header instead of a cookie.
- Settings lists every device with its last use and a **Revoke** button; revoking closes its socket at once. **Sign
  out all phones** does the same for every device. Both set `revoked_at` and clear the hashes in hive.db, so a restart
  never brings them back. The list shows even while Phone is off.
- Every request checks the token. Unknown `Host` headers are refused (only `127.0.0.1`, `localhost` and the current
  tunnel host), which stops DNS rebinding.

## RA3. What the phone can and cannot do

Can: see companies; per company see who is working (the desktop's one live source, LIVE.md and five doors A2), recent
finished work, Pause and Resume the company; answer asks and permission requests (Allow, Deny, an option, text);
approve or send back drafts; answer an agent's question on a task; turn down a task that waits on you (Not needed:
it is canceled, never deleted, and can be reopened from the Board on the Mac); read a chat live and continue it (send, queued
while it works, Stop); message an agent (the desk path: a task, or a comment on its open task); read and post in the
team room (Forum channels), with @mentions that wake agents through the Forum responder.

A chat that runs in a terminal on the Mac (Claude Code or Codex in a pane, the default for repo sessions) reads on the
phone as a chat, live (`src/main/remote/terminalFeed.ts`):

- **What it says and does.** Its CLI's own transcript is tailed, read-only, while a phone looks at it (plus 30 s), and
  folded by the chat reducer into the same items and numbered ops a chat sends, redacted the same way, so the phone
  shows the same tool lines, plan and subagent cards. Claude Code: the `transcript_path` its hooks report (kept after
  the pane exits), else `<claude dir>/projects/<slug>/<conversation id>.jsonl`, and only inside those folders. Codex
  (no hooks): the rollout under `$CODEX_HOME/sessions/YYYY/MM/DD` that began in the session's folder right after it
  started (`transcript.ts` turns its records into the same shapes). Until there is a transcript (a CLI that writes
  none, a first-run dialog), the phone gets what the terminal shows instead (its last lines replayed onto a grid,
  `{ t: 'screen' }` while it changes) and switches to the chat once the transcript appears (an empty `{ t: 'chat' }`
  tells a phone with no chat yet to read it again; so does its ending or asking something).
- **Writing to it.** Any time it runs: waiting at its prompt it is the guarded reply (`agents:reply`, as before);
  while it works the words go in as one bracketed paste and then Enter, which Claude Code and Codex read right after
  the current step. Never into a dialog: an open ask (its card shows in the conversation), a prompt detected on
  screen, or any numbered choice on screen (`› 1. …`) refuses it in plain words and the composer says why. Only plain
  words: text that starts with `!`, `/` or `#` (a shell command, a slash command such as `/permissions`, a memory note)
  is refused; control characters are dropped, and line breaks stay inside the paste (a reply at the prompt joins them).
  The Enter is checked again after the paste: if a choice or ask opened meanwhile (a Codex approval has no hook) it
  is not pressed, the words stay unsent in its prompt, and the app log says so. The paste is only for Claude Code and
  Codex (a CLI that has not turned paste mode on would read its ESC as an interrupt): Gemini and Cursor take a message
  only at their prompt, and a shell has no composer. While it cannot take one, the composer stays with the reason as
  its placeholder and Send off. The app log notes that the phone typed (never the words).
- **Ended.** Its history reads, and **Continue** (`POST …/sessions/:id/continue`) is the Mac's Restart: the same
  profile, folder and company, resuming the same conversation (Claude Code sessions with a conversation id; a second
  tap or one continued on the Mac already follows the running session). Codex panes start fresh on Restart, so the
  phone offers no Continue for them.

Cannot: settings, keys, terminals (beyond those plain messages), repositories, workflow editing, deleting anything, starting new companies, spending
(no "always allow" rules, no plan or billing changes). The server serves only its own bundle (`out/phone/`), never
another file from disk.

Every view is scoped to one company: each id the phone sends (a chat, an agent, an ask, a task, a channel) is resolved
to its own company and must match the company in the request, or the answer is 404. Live pushes go only to sockets
subscribed to that company.

## RA4. Shapes

`src/shared/remote.ts` holds the routes (`REMOTE_ROUTES`), the view shapes and the socket messages. The phone app
(`src/cloud/phone`, built by `vite.phone.config.ts` into `out/phone`) only talks this API, so the same app can later
point at Principia Cloud (CLOUD.md §13.2) by serving the same routes there.

## RA6. Hosted mode: the phone app on its own site

The same phone app also builds as a static site (`npm run build:phone-site` -> `dist-phone-site/`, built by
`vite.phone-site.config.ts`, with `phone-site/vercel.json` copied in). It is meant for one https address (Vercel). The
Mac's own bundle (`out/phone`, same-origin, cookie + CSRF) keeps working unchanged.

- **Setting.** Settings › App › Phone › "Phone app address". Default: `PHONE_SITE_URL` in `src/shared/remote.ts`
  (null until the site is deployed: then the link opens the Mac's own page). Empty: always the Mac's own page. Only an
  https origin is accepted (loopback http for local testing); no path, no credentials, no wildcard.
- **Link.** With an address set, the code is `<site>/#mac=<this Mac's address>&code=<code>`. Both values live in the
  fragment, so neither reaches the site's server or a log. Without one: `<mac>/#pair=<code>` as before.
- **Pairing.** The phone posts the code to the Mac named in the link. The Mac gives the token **in the body** only when
  the request's `Origin` is exactly the configured site; the app keeps it in that site's `localStorage` and sends it as
  `Authorization: Bearer`. There are no cookies (Safari blocks third-party cookies) and no CSRF value (a browser never
  sends a bearer on its own). The Mac keeps only its SHA-256 (in hive.db, RA2), as before. A pairing request from a browser
  page on any other origin (neither the Mac's own page nor the configured site) is refused with 403 **before** the code
  is spent, so no orphan device appears and the same link works once the address is right.
- **Home Screen app (iPhone).** iOS gives a Home Screen web app its own storage, apart from Safari's, and the camera's
  QR always opens Safari. So the signed-out screen of the hosted app has a "Paste the pairing link" field: copy the
  link on the Mac (Copy link, which Universal Clipboard carries to the phone) or long-press the QR in the Camera and
  Copy Link, then paste. Only a link of this same site (or its bare `#mac=…&code=…` fragment) is accepted. In Safari the
  pairing screen says so: add it to the Home Screen first and pair there.
- **Another Mac already kept.** A link naming a different Mac than the one this phone is paired with says so on the
  pairing screen ("paired with another Mac (<host>)") and the button reads "Replace and pair".
- **CORS.** Only for the configured origin, compared exactly (`Access-Control-Allow-Origin: <that origin>`, `Vary:
  Origin`, never `*`, never credentials). Preflight answers 204 for GET/POST with `authorization`, `content-type`,
  `accept`; anything else gets 403. The Host allowlist (127.0.0.1, localhost, the tunnel host) still applies.
- **Live socket.** The upgrade needs `Origin` = the configured site (or the Mac's own page with its cookie). From the
  site, the first message must be `{ t: 'auth', token }` within 5 s; nothing is read or sent before it. A missing,
  unknown or revoked token closes the socket with 4401. The token is never in a URL. `Origin` is only a header (a
  script outside a browser can send any), so the waiting sockets are bounded per caller (CF-Connecting-IP through the
  tunnel, set by Cloudflare's edge; the socket address locally): at most 4 waiting at once and 30 hosted upgrades a
  minute (429 beyond), and when the whole pool (64) is full the oldest waiting socket is closed, never the newcomer. The
  real phone sends its auth within one round trip, so a flood can at worst make it reconnect, never keep it out.
- **Signed out.** Revoke and Sign out all phones say bye, then close; the app then deletes its token. Turn off closes
  the sockets without a bye (1001), so the app keeps its token. When the Mac's last address does not answer at all
  (Phone off, or a new quick-tunnel address after a restart), the app keeps the token and asks for the Mac's new address
  (RA8), with Try again and Forget this Mac.
- **Site headers** (`phone-site/vercel.json`): `default-src 'none'`; scripts, styles, fonts, images and the manifest
  from `'self'` only; `connect-src https://*.trycloudflare.com wss://*.trycloudflare.com` (plus
  `PHONE_SITE_CLOUD_ORIGIN` when set at build time); `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`;
  `require-trusted-types-for 'script'` with `trusted-types 'none'` (the app never writes HTML, so any HTML sink is
  refused); nosniff, `Referrer-Policy: no-referrer`, COOP and CORP same-origin, HSTS. No third-party script, style or
  font: Cinzel, Figtree and the engravings ship with the site. An SPA rewrite sends app paths (never `/api/`) to `index.html`.

### Threat model (hosted)

- **The static site holds no data.** It is HTML, CSS, JS, a font and four pictures. Everything on screen comes from the
  Mac, which is the authority: it decides who is paired, what a phone can see and do (RA3), and it can sign everyone out.
- **The token** is on the phone (the site's `localStorage`) and as a hash on the Mac. Anyone who runs script on the
  site's origin could read it, so the site runs none but its own (the CSP above, no third parties, no inline script).
  Revoke or Sign out all phones makes a copied token worthless at once (Turn off only stops the server until it is on again).
- **A stolen token is worth what the phone is worth, and that is a lot.** The phone cannot open settings, keys,
  terminals or repositories itself (RA3), but it can message agents, approve their drafts and answer their asks, and
  those agents run shell, git and file tools on the Mac. So a stolen bearer means: prompts to agents that execute code
  on the Mac, until Revoke or Sign out all phones (or 90 days unused). Treat it like a signed-in laptop.
- **A compromised deploy** of the site (anyone who can push to the Vercel project) could read the token from
  `localStorage` and so do all of the above while the tunnel is up. Keep the Vercel project to the owner, with 2FA,
  and deploy only from a reviewed build. The CSP still limits where the page may connect, but `connect-src` allows
  every `*.trycloudflare.com` (inherent to quick tunnels), so an injected script could send the token to its own tunnel;
  the CSP and Trusted Types keep script injection out in the first place. A fixed address (RA5) lets `connect-src` name
  one host.
- **A forged link** (`#mac=<someone else's tunnel>`) makes the phone pair with that address, not with the founder's
  Mac: it can show false content and read what the user types there, but it never receives the real Mac's token (the
  pair request carries none). The pairing screen names the Mac's address, and warns before replacing a different Mac
  already kept.
- **Other websites** cannot use the Mac's API: no CORS for them, no cookie crosses origins, and the bearer is never
  attached by the browser on its own.
- The tunnel address is random and short-lived; pairing codes are one-time, 5 minutes, rate limited (RA2).

- **Loopback http** is accepted as the Phone app address for local testing. Whoever already controls this Mac and its
  Settings could point it at a local port; that person already has the Mac.

## RA5. Not in v1

A fixed address (a named tunnel or Cloud, see RA8). Push notifications. Images from the phone. LAN mode.

## RA7. The native iPhone app

`ios/` holds a native app (SwiftUI, Liquid Glass) that speaks this same API in hosted mode: it names the pairing
link's site as its `Origin`, keeps the token in the Keychain and sends it as a bearer and as the socket's first
message. See docs/IOS.md.

## RA8. After a restart: Phone comes back, and a paired phone finds the Mac again

- **"Turn Phone on when Principia starts"** (Settings › App › Phone; `phoneAutoStart`). Unset: on once at least one
  phone is paired, off while none is. On: at launch Principia turns the server on and asks for the tunnel, exactly as
  the founder's two clicks would. Off: every launch starts off.
- **The address problem.** A quick tunnel gets a new random `https://<words>.trycloudflare.com` address each time it
  starts, and the Mac cannot reach the phone to tell it. The phone still holds a valid token, so what it needs is only
  the new address, and a way to be sure the new address is its own Mac before it sends that token there.
- **What we built (option c, made short).** Settings › App › Phone, under Paired phones, shows the tunnel's words
  (`quiet-tree-forty-two`), a QR code and Copy the new address (`<site>/#move=<the Mac's address>`; no code, no secret).
  On the phone, the "Waiting for your Mac" screen has one field: type the words (or paste the link, or open it). No new
  code, no new name, no new token.
- **Why it is safe.** Before it sends its token to a new address, the phone asks it to prove it is its Mac:
  `POST /api/hello { device, nonce }` (no token; a fresh random nonce). The Mac answers
  `HMAC-SHA256(key = sha256hex(token), "principia-hello-v1|<the address it was reached at>|<nonce>")`. Only the Mac
  (which keeps that hash) and the phone (which can compute it) know the key. The address is taken from the request's
  Host, already limited to the tunnel host and loopback, so a look-alike address that relays to the real Mac gets a
  proof for the real address, which the phone refuses. A wrong proof, an unknown device (revoked, expired: "pair
  again") or no answer never sends the token. Hello is rate limited (20 a minute per caller), refused from a foreign
  page, and says nothing beyond "known" or "not known" for a random 64-bit device id. The hashes in hive.db could make
  such a proof, so whoever can read hive.db can pose as this Mac to a paired phone; that person already has the Mac.

### Options we did not build (yet)

- **(a) A named Cloudflare tunnel with a stable hostname.** The founder creates a tunnel in their own Cloudflare account
  (`cloudflared tunnel create principia`, a DNS route such as `phone.example.com`), and Principia would run
  `cloudflared tunnel run --token <tunnel token>` instead of a quick tunnel. The address never changes, so nothing has to
  be found again, and the site's CSP could name that one host instead of `*.trycloudflare.com`. Needs: a domain on
  Cloudflare, the tunnel token kept with safeStorage like other keys, a Settings field for it and the hostname, and the
  hosted site built with that host in `connect-src` (`PHONE_SITE_CLOUD_ORIGIN`-style build variable). The best
  experience for a founder who has a domain; not built because it needs an account and a domain we cannot test here.
- **(b) A rendezvous on the phone site.** The Mac would publish its current address to a tiny endpoint on the
  principia-phone site (a Vercel function with a KV store) under `id = HMAC(sha256hex(token), "rdv-id")`, sealed with
  AES-GCM under `HMAC(sha256hex(token), "rdv-key")`, so the store only ever holds random ids and ciphertext; the phone
  derives both, fetches, decrypts, and still runs the hello check above before it sends its token. Fully automatic, but
  it needs a server-side store on the site (today a static site with no data), its own abuse limits and a deploy we
  cannot exercise from here, and it adds a write path from every Mac to a shared service. Worth doing once the site
  has a backend (or with Principia Cloud, CLOUD.md §13.2).
- The iPhone app (RA7) does not have the "new address" field yet: after a restart with a new quick-tunnel address it
  asks to pair again. It can use the same `POST /api/hello` check.
