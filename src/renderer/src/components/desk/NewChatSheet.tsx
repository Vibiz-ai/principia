/**
 * Five doors §4.6 "New chat": two questions and the first message.
 * - With: one of this company's agents (the message goes to that agent's desk, like the Ask box), or Claude directly
 *   (in a code company also Codex and the other installed agent CLIs).
 * - Where (code companies, direct chats only): no folder, or one of the company's repositories.
 * A company with no code never lands in a terminal (C7): its direct chat starts with your message and reads as a
 * conversation in Chats. A code company's direct chat opens its Claude Code session, as before.
 */
import { useMemo, useState } from 'react'
import type { AdapterId, Id } from '@shared/types'
import { Sheet } from '../ui'
import { reposOf } from '../../lib/companyModel'
import { taskTitleFor } from '../../lib/desk'
import { sendToAgent, useDeskAgents } from '../../state/desk'
import { closeNewChat, companyName, navigate, providerLabel, startSession, toast, useStore } from '../../state/store'

type With = { kind: 'agent'; id: Id } | { kind: 'direct'; adapter: AdapterId }

export function NewChatSheet(): React.JSX.Element | null {
  const open = useStore((s) => s.newChat)
  if (!open) return null
  return <NewChat key={open.nonce} companyId={open.companyId} />
}

function NewChat({ companyId }: { companyId: Id }): React.JSX.Element {
  const agents = useDeskAgents(companyId).filter((a) => !a.paused)
  const allRepos = useStore((s) => s.repos)
  const repos = useMemo(() => reposOf(allRepos, companyId), [allRepos, companyId])
  const code = repos.length > 0
  const allProviders = useStore((s) => s.providers)
  const providers = useMemo(() => allProviders.filter((p) => p.id !== 'shell' && p.available), [allProviders])
  const direct: AdapterId[] = code ? providers.map((p) => p.id) : providers.some((p) => p.id === 'claude') ? ['claude'] : providers.slice(0, 1).map((p) => p.id)
  const [withWho, setWith] = useState<With>(agents[0] ? { kind: 'agent', id: agents[0].id } : { kind: 'direct', adapter: direct[0] ?? 'claude' })
  const [where, setWhere] = useState<Id | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const agent = withWho.kind === 'agent' ? agents.find((a) => a.id === withWho.id) : undefined
  // an agent needs to hear what you want; a direct chat in a company with no code starts from your message (no terminal)
  const needsText = withWho.kind === 'agent' || !code
  const go = async (): Promise<void> => {
    const t = text.trim()
    if (busy || (needsText && !t)) return
    setBusy(true)
    try {
      if (withWho.kind === 'agent') {
        const res = await sendToAgent(withWho.id, t, { open: true })
        if (res) {
          closeNewChat()
          toast(res.merged ? `${agent?.name ?? 'The agent'} added it to work already queued` : res.started ? `Sent to ${agent?.name ?? 'the agent'}` : `Queued for ${agent?.name ?? 'the agent'}`)
        }
        return
      }
      const sess = await startSession({
        repoId: code ? where : null,
        forceNew: true,
        companyId,
        adapter: withWho.adapter,
        ...(t ? { initialPrompt: t, title: taskTitleFor(t).slice(0, 80) } : {}),
        focus: code
      })
      if (!sess) return
      closeNewChat()
      if (!code) void navigate({ name: 'chats', filter: 'direct', chat: `session:${sess.id}` })
    } finally {
      setBusy(false)
    }
  }
  const primary = withWho.kind === 'agent' ? `Send to ${agent?.name ?? 'agent'}` : code ? `Open ${providerLabel(withWho.adapter)}${where ? ` in ${repos.find((r) => r.id === where)?.name ?? 'the repository'}` : ''}` : `Ask ${providerLabel(withWho.adapter)}`
  return (
    <Sheet title={`New chat in ${companyName(companyId)}`} onCancel={closeNewChat} onPrimary={() => void go()} primaryLabel={busy ? 'Starting…' : primary} primaryDisabled={busy || (needsText && !text.trim())} width={560}>
      <div className="newchat">
        <div>
          <div className="newchat__label">With</div>
          <div className="newchat__opts" role="group" aria-label="With">
            {agents.map((a) => (
              <button key={a.id} type="button" className="newchat__opt" aria-pressed={withWho.kind === 'agent' && withWho.id === a.id} onClick={() => setWith({ kind: 'agent', id: a.id })}>
                {a.name} · {a.role}
              </button>
            ))}
            {direct.map((id) => (
              <button key={id} type="button" className="newchat__opt" aria-pressed={withWho.kind === 'direct' && withWho.adapter === id} onClick={() => setWith({ kind: 'direct', adapter: id })}>
                {providerLabel(id)} directly
              </button>
            ))}
          </div>
        </div>
        {code && withWho.kind === 'direct' && (
          <div>
            <div className="newchat__label">Where</div>
            <div className="newchat__opts" role="group" aria-label="Where">
              <button type="button" className="newchat__opt" aria-pressed={where === null} onClick={() => setWhere(null)}>
                No folder
              </button>
              {repos.map((r) => (
                <button key={r.id} type="button" className="newchat__opt" aria-pressed={where === r.id} onClick={() => setWhere(r.id)}>
                  {r.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="newchat__label">{withWho.kind === 'agent' ? `What should ${agent?.name ?? 'they'} do?` : code ? 'First message (optional)' : 'What do you want to ask?'}</div>
          <textarea
            className="input"
            rows={3}
            maxLength={8000}
            data-autofocus
            value={text}
            disabled={busy}
            placeholder={withWho.kind === 'agent' ? `e.g. draft three posts for next week` : 'Ask anything'}
            onChange={(e) => setText(e.target.value)}
            aria-label="Message"
          />
          <div className="newchat__hint">
            {withWho.kind === 'agent'
              ? `It lands in ${agent?.name ?? 'the agent'}’s Queue; the answer comes back in your conversation with ${agent?.name ?? 'them'}.`
              : code
                ? 'A Claude Code session: its terminal opens next to the conversation.'
                : `The chat is saved in ${companyName(companyId)} only. ⌘↵ sends.`}
          </div>
        </div>
      </div>
    </Sheet>
  )
}
