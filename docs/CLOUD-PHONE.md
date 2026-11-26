# Your cloud on your phone

The phone talks to the person's cloud machine directly. The Mac can be closed, asleep or gone: the cloud runs the
chat, keeps it, and answers the phone. This is what a hosted agent computer does (a box per person, the real Claude
Code inside, signed in once), with the code open and the machine on the person's own cloud.

## What the person sees

1. On the Mac, **Cloud › ⋯ › Use on your phone** shows a QR code. The phone opens `https://<your cloud>/`, pairs once,
   and can be added to the Home Screen.
2. **Chats › New chat**: pick one of your GitHub repositories (the most recently pushed first, or none), say what you
   need, Send. The cloud clones the repository, starts Claude with your sign-in, and the answer streams in.
3. When Claude asks before acting (run a command, approve a plan, a question), it shows in the chat and in
   **Needs you**. Allow, Deny or answer from the phone.
4. Close the app: the chat keeps going in the cloud. Open it again later: it is all there. A message to a chat that
   ended resumes the same conversation.
5. In a chat, **Chat · Files · Changes · Terminal** and **Preview**: browse the chat's folder and read its files, see
   what changed (git status, the diff, the branch's commits), type commands in a shell there, and open a server the
   chat started (`npm run dev`) in a new tab.

## How it works

```
phone ──https──▶ cloud control plane (src/cloud/control)
                  ├─ phoneApi.ts    the Phone API (src/shared/remote.ts), as the Mac answers it; me.host = 'cloud'
                  ├─ phoneChats.ts  ChatSession (src/main/chat/chatSession.ts, the Mac's own chat) per chat
                  └─ runtime.chats  the `claude -p` process: clone, sign-in, agent user (src/cloud/agent/chats.ts)
phone ◀──wss /api/live── numbered chat ops, "changed" pings (first message: { t: 'auth', token })
```

- **One chat engine.** The cloud runs the same `ChatSession` the Mac runs. Its process is the runtime's chat process
  (`RuntimeChild` adapts it): the chat can't tell it from a local `claude -p`.
- **The same Phone API.** The phone app (`src/cloud/phone`) and the iPhone app already speak it to the Mac. The cloud
  answers the subset that makes sense there: `pair`, `resume`, `me`, `signOut`, `now`, `needs`, `answerAsk`, `chats`
  (with `repos` and `host: 'cloud'`), `newChat` (with `repo`), `session`, `sessionSend`, `sessionStop`, `sessionFiles`, `sessionFile`, `sessionChanges`, `sessionPorts`, `sessionPreview`,
  `sessionAnswer`, and the live socket. Tasks are empty and the room is off (they are the Mac's).
- **Pairing.** `POST /v1/phone-link` (the Mac or the console) mints a one-time code (32 hex, 10 minutes). The link is
  `<cloud>/#mac=<cloud>&code=<code>`: the code stays in the fragment. `POST /api/pair` makes the phone a cloud device
  (platform `phone`) with a device token, kept in the phone's storage and sent as a bearer. It shows under Devices
  and is revoked there.
- **Kept.** A chat's row (title, repository, mode, last line) is in `control.db` (`phone_chats`). Its conversation is
  Claude's own transcript in the chat's home, so an ended chat opens from it and resumes from it.
- **Permission mode.** New chats run in Claude's `auto` mode: it acts on its own and asks for what is risky. The
  machine is the person's own, with no access to their Mac.
- **The front page.** The cloud serves the phone app at `/` (its build in `out-cloud/phone`) and the console at
  `/console/`. A cloud without the phone build sends `/` to the console as before.

## A chat's folder on the phone (phoneTools.ts)

Only for chats this cloud owns, only with a paired **phone's** token (a Mac's device token gets 403), and only inside
that chat's folder (`<workspace>/chat_<id>`, the clone inside it). `runtime.chats.workspace(id)` (ChatProcs) gives the
folder, the clone, the agent user and the chat's environment: its HOME and CLI homes, git's askpass, the workspace
keys, never Claude's sign-in.

- **Files** (`GET …/sessions/:id/files?path=`, `…/file?path=`): a folder at a time. A path is resolved, its real path
  must be inside the folder, and on Linux the opened descriptor is checked again through `/proc/self/fd` (a link
  swapped in between leads nowhere). A link out of the folder shows as "outside" and does not open. Files over 2 MB
  and binary files are refused; the first 256 KB of a text file shows.
- **Changes** (`GET …/changes`): git as the agent user, 10 s and 1 MB per command, `core.fsmonitor` off, no pager or
  external diff. Status, the working tree against HEAD, and the branch's commits and diff against origin's default
  branch (else its upstream), plus how many commits are not pushed.
- **Terminal** (WebSocket `/api/shell`, `{ t: 'auth', token }` first, then `{ t: 'open', sessionId }`): **line mode**.
  node-pty is a dependency of the Mac app, but not of the cloud build (not external in vite.cloud.config.ts, not
  rebuilt in cloud/Dockerfile), so v1 is `bash --noprofile --norc` on pipes, as the agent user, in the clone, with
  the chat's environment. Each line runs as it is sent; Ctrl-C reaches the command in front (bash traps INT, its
  children get it). No prompt, no full-screen programs (vim, top), ANSI stripped, output redacted like logs. One shell
  per chat, 200 K characters of scrollback replayed to a phone that comes back; nobody connected for 5 minutes: it is
  killed (with whatever it started in the foreground or background). A running shell counts as running in
  activity.json, so a managed machine never sleeps under it.
- **Preview** (`POST …/preview { port }` -> `<cloud>/preview/<chatId>/<port>/<token>/`): a reverse proxy (HTTP and
  WebSocket upgrades, for live reload) to `127.0.0.1:<port>` on this machine. Ports 1024-65535, never the control
  plane's own; where `/proc` is readable the port must be one the agent user listens on (`/proc/net/tcp{,6}`; the
  phone's list marks ports held by a process whose cwd is in the chat's folder). A tab sends no bearer, so the link
  carries an HMAC token in its path: 8 hours, bound to the phone, chat and port; signing the phone out (or revoking
  it) stops its links at once; a restart of the control plane voids them all (the key is per process).
  Caddy on a managed machine sends every path of the cloud's origin to the control plane (`reverse_proxy
  principia:8787`, src/main/cloud/machines/bootstrap.ts) and the chats run in the same container, so the path reaches
  it and 127.0.0.1 is the chat's own.

  **The page is sandboxed.** It is served on the cloud's own origin, where the phone keeps its device token
  (localStorage). So every preview response carries `Content-Security-Policy: sandbox allow-scripts allow-forms
  allow-popups allow-modals allow-downloads` (an opaque origin: it can't read this origin's storage or cookies), the
  proxy strips `Cookie`, `Authorization`, `Origin`, `Referer` and the `X-Forwarded-*` headers going in and `Set-Cookie`
  coming out, answers CORS preflights itself, and sends `Access-Control-Allow-Origin: *` (the page's own calls are
  cross-origin from its opaque origin). `Host` is `localhost:<port>` (Vite's allowedHosts). A redirect to `/x` or to
  `http://localhost:<port>/x` stays inside the preview.

  Known v1 limits: apps that use **absolute paths** (`/assets/app.js`, Vite's `/@vite/client`, Next's `/_next/…`)
  load them from the cloud's root and break: set the dev server's base to the preview path (`vite --base
  /preview/<chatId>/<port>/<token>/`) or serve a plain build. Inside the sandbox `localStorage` and `document.cookie`
  throw and the app's cookies never stick, so sign-in flows of the app itself don't work. The real fix is a host per
  preview (`<port>-<chat>.<cloud host>`, Caddy on-demand TLS): then no sandbox and no prefix.

## Not yet

- Waking a sleeping managed machine from the phone: it sleeps when nothing runs, and the phone can't reach it until
  something wakes it (the Mac, or a schedule). Next: a fleet wake link the phone opens first.
- A real terminal (a pty, xterm.js on the phone): needs node-pty in the cloud image. Editing files from the phone.
- Previews on their own host (see above), and a preview that wakes a sleeping machine.
- Chats started on the Mac in the cloud (docs/CLOUD-CHATS.md) are the Mac's: the phone sees the cloud's own chats.
- Codex chats in the cloud.
