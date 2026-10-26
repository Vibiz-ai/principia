/**
 * CHAT-UI.md §3: the chat hub inside Principia's main process: its spawner for SessionManager, the Needs-you link
 * (SessionLive) and the chat:* IPC handlers.
 */
import type { Hive } from '../hive'
import type { Ask, AskAnswer } from '../../shared/live'
import type { ChatDecision } from '../../shared/chat'
import type { Id } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { emit, handle } from '../ipc'
import { claudeDataDir } from '../claudeTrust'
import { ChatHub, type ChatHubDeps } from './chatHub'
import { chatTitle, isDefaultTitle } from '../../shared/chatTitle'

export function createChatHub(h: Hive, o: Pick<ChatHubDeps, 'userData' | 'emit' | 'redact' | 'killGroup' | 'log'> & { baseEnv(): Record<string, string | undefined> }): ChatHub {
  const hub = new ChatHub({
    ...o,
    openChatsAs: () => h.store.getSettings().openChatsAs ?? 'auto',
    claudeVersion: () => {
      try {
        return h.engine.providers.cached().find((p) => p.id === 'claude')?.version ?? null
      } catch {
        return null
      }
    },
    codexVersion: () => {
      try {
        return h.engine.providers.cached().find((p) => p.id === 'codex')?.version ?? null
      } catch {
        return null
      }
    },
    // AGENT CHAT: a new Codex thread is the session's conversation (Restart and a revived agent chat resume it)
    onConversation: (sid, conv) => {
      const s = h.store.getSession(sid)
      if (!s || s.agentSessionId === conv) return
      try {
        const next = h.store.updateSession(sid, { agentSessionId: conv })
        emit('session:updated', next)
      } catch {
        /* the row may be written a tick later; the chat index keeps the id too */
      }
    },
    registerPid: (sid, pid) => h.reaper?.register(sid, pid),
    // an agent's chat is titled "Julia · Code Reviewer" (agentChat.ts): its asks and notices speak as Julia
    speakerOf: (sid) => {
      const s = h.store.getSession(sid)
      return s?.companyAgentId ? (s.title.split(' · ')[0]?.trim() || null) : null
    },
    asks: (sid) => {
      const sl = h.sessionLive?.get(sid)
      if (!sl) return null
      return {
        open: (e) => {
          sl.chat ??= chatLink(h, hub, sid)
          sl.openChatAsk(e)
          h.statusChanged()
        },
        close: (rid, summary) => {
          sl.closeChatAsk(rid, summary)
          h.statusChanged()
        },
        stopped: () => {
          sl.chatStopped()
          h.statusChanged()
        },
        working: () => {
          sl.chatWorking()
          h.statusChanged()
        },
        turnEnded: (report) => {
          if (sl.chatTurnEnded(report)) h.statusChanged()
        }
      }
    },
    terminalWorking: (sid) => {
      const root = h.sessionLive?.get(sid)?.root
      const cur = root ? h.live.getAgent(root.id) : null
      return cur?.status === 'working'
    },
    onTitle: (sid, text) => titleChat(h, sid, text),
    claudeDir: () => claudeDataDir(o.baseEnv())
  })
  return hub
}

function titleChat(h: Hive, sid: Id, text: string, tries = 0): void {
  const s = h.store.getSession(sid)
  if (!s) {
    if (tries < 5) setTimeout(() => titleChat(h, sid, text, tries + 1), 200)
    return
  }
  const t = chatTitle(text)
  // an agent's chat keeps the agent's name
  if (!t || s.companyAgentId || !isDefaultTitle(s.title, s.cwd) || s.title === t) return
  try {
    h.sessions.rename(sid, t)
    h.sessionLive?.get(sid)?.retitle(t)
  } catch {
    /* a title never matters enough to fail */
  }
}

/** asks:answer for a chat's ask (Needs you, notifications): the same answer as the card in the chat. */
export function chatLink(h: Hive, hub: ChatHub, sessionId: Id): { ownsAsks(): boolean; answer(ask: Ask, a: AskAnswer, gateId: string): Ask } {
  return {
    ownsAsks: () => hub.ownsAsks(sessionId),
    answer: (ask, a, gateId) => {
      const s = hub.get(sessionId)
      if (!s) throw new HiveError('conflict', 'This chat has ended')
      const item = s.items.find((i) => (i.kind === 'permission' || i.kind === 'question' || i.kind === 'plan') && i.requestId === gateId)
      if (!item) throw new HiveError('conflict', 'Already answered in the chat')
      const opt = a.optionId ? ask.options.find((x) => x.id === a.optionId) : null
      const words = a.message?.trim() || a.text?.trim() || ''
      let decision: ChatDecision
      if (item.kind === 'question') {
        const q = item.questions[0]?.question ?? 'answer'
        if (opt?.kind === 'choice') decision = { kind: 'answer', answers: { [q]: opt.label } }
        else if (opt?.kind === 'deny' || !words) decision = { kind: 'skip' }
        else decision = { kind: 'answer', answers: { [q]: words } }
      } else {
        const kind = opt?.kind ?? (words ? 'deny' : null)
        const sug = opt ? /^sug_(\d+)$/.exec(opt.id) : null
        if (sug && item.kind === 'permission' && item.suggestions[Number(sug[1])]) decision = { kind: 'allowAlways', suggestion: Number(sug[1]) }
        else if (kind === 'allow') decision = { kind: 'allow' }
        else if (kind === 'allow_step' || kind === 'allow_always') decision = item.kind === 'permission' && item.suggestions.length ? { kind: 'allowAlways', suggestion: 0 } : { kind: 'allow' }
        else if (kind === 'deny') decision = { kind: 'deny', ...(words ? { message: words } : {}) }
        else throw new HiveError('bad_request', 'Choose Allow or Deny')
      }
      hub.answer(sessionId, gateId, decision, 'needs')
      return h.live.getAsk(ask.id) ?? ask
    }
  }
}

export function registerChatHandlers(h: Hive): void {
  const hub = (): ChatHub => {
    if (!h.chats) throw new HiveError('internal', 'Chats are not available')
    return h.chats
  }
  const session = (id: Id) => {
    const s = h.store.getSession(id)
    if (!s) throw new HiveError('not_found', 'Session not found')
    return s
  }
  handle('chat:snapshot', ({ id }) => {
    const s = session(id)
    return hub().snapshot(id, s)
  })
  handle('chat:send', async ({ id, text, images }) => {
    await hub().send(id, text, images)
  })
  handle('chat:queueEdit', ({ id, queueId, text }) => hub().queueEdit(id, queueId, text))
  handle('chat:interrupt', async ({ id, sendNow }) => {
    await hub().interrupt(id, sendNow)
  })
  handle('chat:answer', ({ id, requestId, decision }) => {
    hub().answer(id, requestId, decision, 'chat')
    h.statusChanged()
  })
  handle('chat:setPermissionMode', async ({ id, mode }) => {
    await hub().setPermissionMode(id, mode)
  })
  handle('chat:setModel', async ({ id, model }) => {
    await hub().setModel(id, model)
  })
  handle('chat:files', async ({ id, query }) => hub().files(session(id).cwd, query))
  handle('chat:toTerminal', async ({ id, force }) => {
    await hub().toTerminal(id, force)
    h.statusChanged()
  })
  handle('chat:toChat', async ({ id, force }) => {
    await hub().toChat(id, force)
    h.statusChanged()
  })
  // AGENT CHAT: an agent's standing chat (started or resumed), and a message straight into it
  const agentChats = () => {
    if (!h.agentChats) throw new HiveError('internal', 'Agent chats are not available')
    return h.agentChats
  }
  // never (re)started while Principia quits: the chat comes back, resumed, on the next launch
  const notQuitting = (): void => {
    if (h.quitting) throw new HiveError('conflict', 'Principia is quitting')
  }
  handle('chat:openAgent', ({ agentId }) => {
    notQuitting()
    return agentChats().open(agentId)
  })
  handle('chat:sendAgent', async ({ agentId, text }) => {
    notQuitting()
    const s = agentChats().open(agentId)
    await hub().send(s.id, text)
    h.statusChanged()
    return h.store.getSession(s.id) ?? s
  })
}
