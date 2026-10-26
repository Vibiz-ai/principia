/**
 * CHAT-UI.md §3: the chat hub inside Principia's main process: its spawner for SessionManager, the Needs-you link
 * (SessionLive) and the chat:* IPC handlers.
 */
import type { Hive } from '../hive'
import type { Ask, AskAnswer } from '../../shared/live'
import type { ChatDecision } from '../../shared/chat'
import type { Id } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { handle } from '../ipc'
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
    registerPid: (sid, pid) => h.reaper?.register(sid, pid),
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
  if (!t || !isDefaultTitle(s.title, s.cwd) || s.title === t) return
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
}
