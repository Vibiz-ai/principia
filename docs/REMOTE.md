# Phone: this Mac on your phone (REMOTE.md)

A small web app on your phone to watch what the agents are doing and keep the work going: answer what needs you,
continue a chat, message an agent, talk in the team room. Everything else stays on the Mac.

## RA1. Amends SPEC A1 ("zero TCP listeners")

- **Off by default.** With Phone off (every launch starts off), Principia opens no listener and starts no process for it.
  The CONTRACT §9 `lsof -iTCP -sTCP:LISTEN` check stays empty.
- **On** (Settings › App › Phone, one switch): main starts one HTTP + WebSocket server bound to **127.0.0.1 only**, on a
  random port. Nothing on the network can reach it directly.
- **Reach it from the phone** (one button, "Share over the internet"): Principia runs `cloudflared tunnel --url
  http://127.0.0.1:<port>` (a quick tunnel: outbound only, a random `https://….trycloudflare.com` address). If
  `cloudflared` is not installed, the page says `brew install cloudflared`. Principia never downloads it.
- **Turn off** stops the tunnel and the server, closes every socket and ends every phone session. Quitting does the same.
- The tunnel is the only outbound traffic Phone adds, and only while it is on. While it runs, `cloudflared` also opens
  its own metrics listener on `localhost` (20241-20245 by default), loopback only, and it closes with the tunnel.
- An address `cloudflared` prints in an error line (`https://api.trycloudflare.com`, its own service) is never taken as
  the tunnel address.

## RA2. Pairing and devices

- **Pair a phone**: the Mac shows a QR code and a link `<url>/#pair=<code>`. The code is random (128 bits), lives
  5 minutes and works once. Only the newest code works: New code cancels the earlier ones. It is in the URL fragment, so it never reaches a server log or the tunnel.
- The phone sends the code with a name ("My iPhone"), and gets a **device token** (256 bits) in an `httpOnly`,
  `Secure`, `SameSite=Strict` cookie. Only the SHA-256 of the token is kept, in memory: turning Phone off (or quitting)
  signs every phone out.
- Writes need the CSRF header (`x-principia-csrf`, from `GET /api/me`, bound to the device). The WebSocket checks the
  cookie and the `Origin`.
- Wrong codes are rate limited per caller (5 a minute; through the tunnel the caller is Cloudflare's
  `CF-Connecting-IP`), with a ceiling of 60 a minute across everyone. A live code always pairs, so someone who found
  the address cannot lock the founder out by sending junk. A wrong or used code says "This link expired".
- Hosted mode (RA6) carries the same token as a bearer header instead of a cookie.
- Settings lists every device with its last use and a **Revoke** button; revoking closes its socket at once.
- Every request checks the token. Unknown `Host` headers are refused (only `127.0.0.1`, `localhost` and the current
  tunnel host), which stops DNS rebinding.

## RA3. What the phone can and cannot do

Can: see companies; per company see who is working (the desktop's one live source, LIVE.md and five doors A2), recent
finished work, Pause and Resume the company; answer asks and permission requests (Allow, Deny, an option, text);
approve or send back drafts; answer an agent's question on a task; turn down a task that waits on you (Not needed:
it is canceled, never deleted, and can be reopened from the Board on the Mac); read a chat live and continue it (send, queued
while it works, Stop); message an agent (the desk path: a task, or a comment on its open task); read and post in the
team room (Forum channels), with @mentions that wake agents through the Forum responder.

A chat that runs in a terminal on the Mac can get a reply only when it waits at its prompt, and only plain words:
text that starts with `!`, `/` or `#` (a shell command, a slash command such as `/permissions`, a memory note) is
refused, and control characters and line breaks are taken out before it is typed in.

Cannot: settings, keys, terminals (beyond that plain reply), repositories, workflow editing, deleting anything, starting new companies, spending
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
  sends a bearer on its own). The Mac keeps only its SHA-256, in memory, as before. A pairing request from a browser
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
- **Signed out.** Revoke and Turn off work as before (bye, then close). The app then deletes its token. When the Mac's
  last address does not answer at all (the quick tunnel stopped or changed), the app keeps the address and says "Scan
  again on your Mac", with Try again and Forget this Mac.
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
  Revoke or Turn off makes a copied token worthless at once.
- **A stolen token is worth what the phone is worth, and that is a lot.** The phone cannot open settings, keys,
  terminals or repositories itself (RA3), but it can message agents, approve their drafts and answer their asks, and
  those agents run shell, git and file tools on the Mac. So a stolen bearer means: prompts to agents that execute code
  on the Mac, until Revoke or Turn off. Treat it like a signed-in laptop.
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

A fixed address (a named tunnel or Cloud): a quick tunnel gets a new address each time, so a phone pairs again after
Phone was turned off. Push notifications. Images from the phone. LAN mode.

## RA7. The native iPhone app

`ios/` holds a native app (SwiftUI, Liquid Glass) that speaks this same API in hosted mode: it names the pairing
link's site as its `Origin`, keeps the token in the Keychain and sends it as a bearer and as the socket's first
message. See docs/IOS.md.
