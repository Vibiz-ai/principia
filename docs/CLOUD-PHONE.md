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
  (with `repos` and `host: 'cloud'`), `newChat` (with `repo`), `session`, `sessionSend`, `sessionStop`,
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

## Not yet

- Waking a sleeping managed machine from the phone: it sleeps when nothing runs, and the phone can't reach it until
  something wakes it (the Mac, or a schedule). Next: a fleet wake link the phone opens first.
- A terminal and the files of a chat's folder on the phone; preview links for a server a chat starts.
- Chats started on the Mac in the cloud (docs/CLOUD-CHATS.md) are the Mac's: the phone sees the cloud's own chats.
- Codex chats in the cloud.
