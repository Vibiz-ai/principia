# Cloud chats

A chat can run on the person's cloud machine instead of the Mac. It looks and works like any other chat (the same
chat view, asks and approvals, Search, the phone), with a **Cloud** mark everywhere it shows, and it keeps going
with the Mac closed.

## What the person sees

- **New chat** has *This Mac | Cloud* once a cloud is linked (the last choice is remembered). With a repository
  picked in *To*, the cloud works in a clone of that repository from GitHub.
- While it starts, the chat says what it is doing: *Starting in your cloud*, *Getting acme/app from GitHub…*,
  *Signing in…*, *Reconnecting to your cloud…*. A sleeping managed cloud is woken first (docs/FLEET.md §6).
- The chat row, the sidebar row and the chat's header carry the **Cloud** mark; the header says *runs in your cloud*.
  There is no Terminal toggle for it: the conversation lives on that machine.
- The phone (web and iPhone) shows the **Cloud** pill on the row and *In your cloud* in the chat, and its New chat
  has *On your Mac | In your cloud*.
- Deleting the chat on the Mac deletes its folder and history in the cloud.

## How it works

```
ChatSession ──spawnChild──▶ CloudChild (src/main/cloud/chatChild.ts)
                              │ POST /v1/chats/:conversationId   (the choices, the repository)
                              │ WS   /v1/chats/:id/attach?from=N (stdin up, stdout down)
                              ▼
control plane (src/cloud/control/chats.ts) ──▶ runtime.chats (src/cloud/agent/chats.ts)
                                                 clone → home with the Claude sign-in → `claude -p` as the agent user
```

- **Nothing from the Mac's argv is sent.** The Mac sends the conversation id, resume, model, permission mode, bypass
  and the system prompt (`chatChoices`); the cloud builds its own argv (`chatArgv`). No Mac path or flag reaches it.
  The Claude sign-in, the GitHub token and the shared keys come from the cloud's own store.
- **The same chat protocol.** The CLI speaks stream-json over the socket exactly as it does over a local pipe, so
  permission prompts (`--permission-prompt-tool stdio`), questions and plans come back to the Mac and the phone.
- **Nothing lost on a dropped connection.** The cloud numbers every character of output and keeps the newest 8 M;
  the Mac reconnects with what it has seen (`?from=N`) and gets exactly the rest.
- **Keyed by the conversation.** The chat's home (Claude's history) and folder are `chat_<conversation id>`, so a
  Restart, which is a new session resuming the same conversation, finds them. `cloudOfConversation` sends it there.
- **It never keeps a machine awake for nothing.** A live chat process counts as running (`activity.json`), so the
  machine doesn't sleep under it. The Mac's chat stops the process after 10 idle minutes, and the cloud stops one
  that nobody follows after 20.
- **The process has no local pid** (0); `killGroup` refuses pid ≤ 0, and the chat signals it over the socket.

## Not yet

- Codex chats (Claude only for now).
- Files from the Mac (a dropped file, a pasted screenshot) in a cloud chat: New chat refuses them for now.
- A cloud chat's history, read on the Mac, comes from the chat itself; Search over sessions covers this Mac's only.
- The Mac's uncommitted changes don't go with it: the cloud starts from the branch on GitHub (pushed branches only),
  else the default branch.
