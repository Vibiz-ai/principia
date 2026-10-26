/**
 * Five doors step 3: the pieces Home, Team, the agent page and Chats share.
 * - AskBox: Home's "Ask your team…" (a real input). As you type it says who will get it ("→ Marcus · Content
 *   Writer"), from an @name or the request's words; the name is a menu to pick someone else. Enter sends it to that
 *   agent (state/desk.ts) and opens the agent's page.
 * - AgentChat: the one conversation with an agent, the same on the agent page and in Chats: the agent's own live
 *   chat (AGENT CHAT), drawn by the Claude chat's ChatPane in the agent's name (AgentConversation lays it out with
 *   the agent's right panel). DraftCard: a draft waiting for your OK.
 * - useAgentStatus / AgentAction: the status sentence (design §2.6) and the one primary button of an agent.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CompanyAgent, CompanyTask } from '@shared/company'
import type { Artifact, Id } from '@shared/types'
import { Button } from '../ui'
import { Icon } from '../Icon'
import { ArtifactThumb } from '../ArtifactThumb'
import { AgentBust } from '../../shell/DepartmentGroup'
import { errorMessage, hive, nativeMenu } from '../../lib/hive'
import { routeAsk, statusSentence, taskName, waitsOnOther, type DeskAgent, type StatusSentence } from '../../lib/desk'
import { MarkdownLite } from '../diagrams/MarkdownLite'
import { seatState } from '../../lib/departments'
import { openAskRuns } from '../../lib/departments'
import { reposOf } from '../../lib/companyModel'
import { useCompanyShortName } from '../../lib/company'
import { firstLine } from '../../lib/format'
import { age } from '../../lib/time'
import { useWorking } from '../../state/live'
import { agentAutonomy, type useAgentChat, useDeskWho, sendToAgent, useDeskAgents } from '../../state/desk'
import { ChatSurface } from '../chat/ChatSurface'
import { Composer } from '../chat/Composer'
import { EMPTY_CHAT_META } from '@shared/chat'
import '../../styles/chat.css'
import { attempt, companyName, getState, navigate, openAgentSeat, openBoard, openChat, refreshTasks, setAgentPaused, setCompanyPaused, toast, useStore } from '../../state/store'
import '../../styles/diagrams.css'
import '../../styles/desk.css'

// ---------- company facts ----------

/** A code company has at least one repository (the sidebar's REPOSITORIES rule): task codes, Terminal and PRs show. */
export function useIsCode(companyId: Id | null | undefined): boolean {
  return useStore((s) => !!companyId && reposOf(s.repos, companyId).length > 0)
}

// ---------- the Ask box ----------

export function AskBox({ companyId, autoFocus = false }: { companyId: Id; autoFocus?: boolean }): React.JSX.Element {
  const agents = useDeskAgents(companyId)
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<Id | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  const routed = useMemo(() => routeAsk(text, agents), [text, agents])
  const target: DeskAgent | null = (picked && agents.find((a) => a.id === picked)) || routed?.agent || null
  const code = useIsCode(companyId)
  const example = useMemo(() => exampleAsk(agents, code), [agents, code])
  const pick = async (): Promise<void> => {
    if (!agents.length) return
    const id = await nativeMenu(agents.map((a) => ({ id: a.id, label: `${a.name} · ${a.role}${a.paused ? ' (paused)' : ''}`, type: 'checkbox' as const, checked: a.id === target?.id })))
    if (id) setPicked(id)
    ref.current?.focus()
  }
  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t || busy) return
    if (!target) {
      // no team here (Personal, or no departments yet): a chat with Claude, the words on the clipboard to paste
      try {
        await navigator.clipboard.writeText(t)
      } catch {
        /* clipboard refused: the chat still opens */
      }
      void openChat(true, companyId)
      toast('A new chat with Claude is open. Your words are copied: paste them with ⌘V.')
      setText('')
      return
    }
    setBusy(true)
    const res = await sendToAgent(target.id, t, { open: true })
    setBusy(false)
    if (res) {
      setText('')
      setPicked(null)
      toast(`Sent to ${target.name} · ${target.role}`)
    }
  }
  return (
    <form
      className="ask-box"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <Icon name="chat" size={15} />
      <input
        ref={ref}
        className="ask-box__input"
        value={text}
        disabled={busy}
        maxLength={8000}
        aria-label="Ask your team"
        placeholder={agents.length ? `Ask your team… e.g. ${example}` : 'Ask Claude anything…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setText('')
            setPicked(null)
          }
        }}
      />
      {text.trim() &&
        (target ? (
          <button type="button" className="ask-box__route" onClick={() => void pick()} title={routed?.unknown && !picked ? `Nobody called ${routed.unknown} works in ${companyName(companyId)}. Pick who gets it` : 'Pick who gets it'}>
            {routed?.unknown && !picked && <span className="ask-box__unknown">No {routed.unknown} here ·</span>}→ {target.name} · {target.role}
            <Icon name="chevronDown" size={10} />
          </button>
        ) : (
          <span className="ask-box__route ask-box__route--plain">→ New chat with Claude</span>
        ))}
      <Button type="submit" size="sm" variant="primary" icon="send" disabled={busy || !text.trim()} title="Send (↵)" aria-label="Send" />
    </form>
  )
}

/** "@Marcus draft a holiday post" from the company's own team (never another company's names). */
function exampleAsk(agents: DeskAgent[], code = false): string {
  // a code company leads with its developer ("@Livia fix the failing test"), a shop with its writer
  const dev = agents.find((a) => /develop|builder|engineer/i.test(a.role))
  if (code && dev) return `@${dev.name} fix the failing test`
  const writer = agents.find((a) => /writer|content|copy|brand|marketing/i.test(a.role))
  if (writer) return `@${writer.name} draft a post about this week’s news`
  if (dev) return `@${dev.name} fix the failing test`
  const first = agents[0]
  return first ? `@${first.name} what should we do this week?` : ''
}

// ---------- status ----------

/** The agent's status sentence, from its seat, its company and the one live source (the current run's activity). */
/** An agent's seat as the desk reads it: its To do marked with what waits on another task. */
export type DeskSeat = Omit<ReturnType<typeof seatState>, 'queue'> & { queue: (CompanyTask & { waiting: boolean })[] }
export function useAgentStatus(agent: CompanyAgent): StatusSentence & { seat: DeskSeat } {
  const tasks = useStore((s) => s.tasks)
  const asks = useStore((s) => s.asks)
  const pausedCompany = useStore((s) => {
    const c = s.companies.find((x) => x.id === agent.companyId)
    return c?.pausedAt ? c.name : null
  })
  const code = useIsCode(agent.companyId)
  const working = useWorking(agent.companyId)
  const seat = useMemo((): DeskSeat => {
    const st = seatState(agent, tasks, openAskRuns(asks))
    // work that can start comes first; work waiting on another task is marked, so it is never "Ready" with a Start
    const queue = st.queue.map((t) => ({ ...t, waiting: waitsOnOther(t, tasks) })).sort((a, b) => Number(a.waiting) - Number(b.waiting))
    return { ...st, queue }
  }, [agent, tasks, asks])
  const live = seat.current?.runId ? working.items.find((i) => i.runId === seat.current!.runId || i.sessionId === seat.current!.runId) : undefined
  // the same clock as LIVE and Home: since the work began
  const s = statusSentence({ seat, agentPaused: !!agent.pausedAt, companyPaused: pausedCompany, code, since: seat.current ? age(live?.startedAt ?? seat.current.updatedAt) : null, activity: live?.detail && live.detail !== 'Starting' ? live.detail : null })
  return { ...s, seat }
}

export function StatusLine({ status, className }: { status: StatusSentence; className?: string }): React.JSX.Element {
  return (
    <span className={['desk-status', `desk-status--${status.kind}`, className].filter(Boolean).join(' ')}>
      <span className="desk-status__glyph" aria-hidden>
        {status.glyph}
      </span>
      <span className="desk-status__text">{status.text}</span>
    </span>
  )
}

/**
 * C9: a task in flight is paused (tasks:pause): its run ends, the task goes back to To do with its work and a note of
 * where it stopped, and it waits there for Start. Never a failure, never in Needs you.
 */
export async function pauseTask(task: CompanyTask): Promise<void> {
  if (!task.runId) return
  const ok = await attempt(() => hive.tasks.pause({ id: task.id }), 'Pause this task')
  if (ok) {
    await refreshTasks()
    toast(`Paused ${task.title}. The work so far is kept; Start picks it up again.`)
  }
}
export async function startTask(task: CompanyTask): Promise<void> {
  const ok = await attempt(() => hive.tasks.start({ id: task.id }), 'Start')
  if (ok) {
    await refreshTasks()
    toast(`Started ${task.title}`)
  }
}

/** The one primary action of an agent (Team card, agent page). */
export function AgentAction({ agent, status, size = 'sm', wide }: { agent: CompanyAgent; status: ReturnType<typeof useAgentStatus>; size?: 'sm' | 'md'; wide?: boolean }): React.JSX.Element | null {
  const cls = wide ? 'desk-action--wide' : undefined
  const short = useCompanyShortName(agent.companyId)
  if (agent.archivedAt) return null
  const btn = (p: Parameters<typeof Button>[0]): React.JSX.Element => <Button size={size === 'sm' ? 'sm' : undefined} className={cls} {...p} />
  if (status.kind === 'paused') {
    const companyPaused = !!getState().companies.find((c) => c.id === agent.companyId)?.pausedAt
    return companyPaused
      ? btn({ variant: 'primary', icon: 'play', onClick: () => void setCompanyPaused(agent.companyId, false), children: `Resume ${short}` })
      : btn({ variant: 'primary', icon: 'play', onClick: () => void setAgentPaused(agent, false), children: 'Resume' })
  }
  const cur = status.seat.current
  if (cur && status.kind === 'working') return btn({ icon: 'pause', onClick: () => void pauseTask(cur), children: 'Pause this task' })
  if (status.kind === 'needs' || status.kind === 'failed') return btn({ variant: 'primary', onClick: () => void navigate({ name: 'home' }), children: 'See what’s needed' })
  const next = status.seat.queue.find((t) => !t.waiting)
  if (next) return btn({ variant: 'primary', icon: 'play', onClick: () => void startTask(next), children: 'Start' })
  // only work that waits on another task: nothing to start yet, show what it waits on
  const waiting = status.seat.queue[0]
  if (waiting) return btn({ onClick: () => openBoard(waiting.companyId, { taskId: waiting.id }), children: 'See what it waits on' })
  return btn({ onClick: () => openAgentSeat(agent, { focus: true }), children: 'Give a task' })
}

// ---------- the conversation ----------

/** A draft waiting for your OK: what the agent made (pictures first), Approve and Send back, right here. */
export function DraftCard({ task, code, onHome = false }: { task: CompanyTask; code: boolean; onHome?: boolean }): React.JSX.Element {
  const [files, setFiles] = useState<Artifact[] | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [sendBack, setSendBack] = useState(false)
  const [busy, setBusy] = useState(false)
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (!task.runId) return setFiles([])
    hive.artifacts.list({ runId: task.runId, companyId: task.companyId, limit: 12 }).then(setFiles, () => setFiles([]))
  }, [task.runId, task.companyId])
  // with no written report, what the agent said last in its run is the draft you are approving
  useEffect(() => {
    setSaid(null)
    if (task.report?.summary || !task.runId) return
    let live = true
    hive.runs.get({ id: task.runId }).then(
      (d) => {
        const out = [...d.steps].reverse().find((x) => !!x.output?.trim())?.output?.trim() ?? null
        if (live) setSaid(out)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [task.runId, task.report?.summary])
  const work = task.report?.summary?.trim() || said
  const long = !!work && work.length > 900
  const pr = task.work?.pr ?? null
  const pictures = (files ?? []).filter((a) => /image/.test(a.mime ?? '') || a.kind === 'image').slice(0, 6)
  const others = (files ?? []).filter((a) => !pictures.includes(a)).slice(0, 4)
  const approve = async (): Promise<void> => {
    setBusy(true)
    const summary = firstLine(task.report?.summary ?? task.title, 200)
    const ok = await attempt(() => hive.tasks.approve({ id: task.id, doneNote: `Approved: ${summary}` }), 'Approve')
    setBusy(false)
    if (ok) {
      await refreshTasks()
      toast(`Approved ${task.title}`)
    }
  }
  const back = async (): Promise<void> => {
    if (!note.trim()) return
    setBusy(true)
    const ok = await attempt(() => hive.tasks.sendBack({ id: task.id, note: note.trim() }), 'Send back')
    if (!ok) return setBusy(false)
    // the agent picks it up now when it is free and the company runs; otherwise it says where it waits
    const st = getState()
    const co = st.companies.find((c) => c.id === task.companyId)
    const agent = task.agentId ? st.companyAgents.find((a) => a.id === task.agentId) : undefined
    const busyAgent = !!agent && st.tasks.some((t) => t.agentId === agent.id && t.status === 'in_progress' && t.id !== task.id)
    let started = false
    if (agent && !co?.pausedAt && !agent.pausedAt && !busyAgent) started = !!(await hive.tasks.start({ id: task.id }).then(() => true, () => false))
    setBusy(false)
    await refreshTasks()
    setNote('')
    setSendBack(false)
    toast(started ? `Sent back. ${task.title} is being reworked with your note.` : co?.pausedAt ? `Sent back. ${task.title} waits in its agent’s queue until you resume ${co.name}.` : `Sent back. ${task.title} is back in its agent’s queue with your note.`)
  }
  return (
    <div className="draft-card">
      <div className="draft-card__head">
        <span className="draft-card__pill">◆ Needs your OK</span>
        <span className="draft-card__title">{taskName(task, code)}</span>
        <span className="flex1" />
        {!onHome && <span className="text-tertiary draft-card__also">Also in Home › Needs you</span>}
      </div>
      {work && (
        <div className={`draft-card__work ${long && !full ? 'is-clipped' : ''}`}>
          <MarkdownLite text={long && !full ? `${work.slice(0, 900).replace(/\s+\S*$/, '')}…` : work} />
          {long && (
            <button type="button" className="link-btn draft-card__more" onClick={() => setFull((v) => !v)}>
              {full ? 'Show less' : 'Show all of it'}
            </button>
          )}
        </div>
      )}
      {code && task.work && (
        <div className="draft-card__code">
          <Icon name="branch" size={12} /> <span className="mono">{task.work.branch}</span>
          {pr ? (
            <button type="button" className="link-btn" onClick={() => void hive.app.openExternal({ url: pr.url }).catch(() => undefined)}>
              Pull request #{pr.number} · {pr.state === 'MERGED' ? 'merged' : pr.isDraft ? 'draft' : 'open'} <Icon name="external" size={10} />
            </button>
          ) : (
            <span className="text-tertiary">no pull request yet</span>
          )}
        </div>
      )}
      {!work && files !== null && files.length === 0 && !(code && task.work) && <div className="draft-card__none text-tertiary">{task.agentId ? 'It finished without writing anything down here.' : 'Nothing was written down.'} Open the task to see what it did before you approve.</div>}
      {pictures.length > 0 && (
        <div className="draft-card__pics">
          {pictures.map((a) => (
            <ArtifactThumb key={a.id} artifact={a} size={240} className="draft-card__pic" />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="draft-card__files">
          {others.map((a) => (
            <button key={a.id} type="button" className="draft-card__file" onClick={() => void hive.artifacts.open({ id: a.id }).catch((e: unknown) => toast(errorMessage(e), 'error'))}>
              <Icon name="file" size={12} /> {a.name}
            </button>
          ))}
        </div>
      )}
      {sendBack ? (
        <div className="draft-card__back">
          <textarea
            className="input"
            rows={2}
            autoFocus
            maxLength={4000}
            placeholder="What should change? (⌘↵ sends)"
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            aria-label="What should change"
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void back()
              } else if (e.key === 'Escape') setSendBack(false)
            }}
          />
          <div className="desk-msg__actions">
            <Button size="sm" variant="primary" icon="reply" disabled={busy || !note.trim()} onClick={() => void back()}>
              Send back
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSendBack(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="desk-msg__actions">
          <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void approve()}>
            Approve
          </Button>
          <Button size="sm" icon="reply" disabled={busy} onClick={() => setSendBack(true)}>
            Send back…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openBoard(task.companyId, { taskId: task.id })}>
            Open the task
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * AGENT CHAT: the conversation with an agent is its own live chat (the same chat as Claude's: streaming, tool lines,
 * Allow / Deny, helper subagents, the composer, Chat | Terminal), in the agent's name and face. `chat` is the agent's
 * chat as useAgentChat opens (or resumes) it; the conversation layout holds it so its header and panel read the same one.
 */
export function AgentChat({ agent, chat, autoFocus = true }: { agent: CompanyAgent; chat: ReturnType<typeof useAgentChat>; autoFocus?: boolean }): React.JSX.Element {
  const who = useDeskWho(agent)
  const code = useIsCode(agent.companyId)
  if (agent.archivedAt)
    return (
      <div className="desk-thread desk-thread--empty">
        <p>{who.name} is archived. Restore {who.name} from Team to chat again.</p>
      </div>
    )
  if (chat.error)
    return (
      <div className="desk-thread desk-thread--empty">
        <p>{chat.error}</p>
      </div>
    )
  const intro = `Message ${who.name}, your ${who.role}. ${who.name} answers here, works with ${code ? 'the code' : 'your files'} and company tools, can start helper agents for bigger jobs, and puts work on the board when it should be tracked.`
  // no chat yet: nothing runs until the first message (looking at an agent never starts its CLI)
  if (!chat.session) return <AgentChatStart agent={agent} name={who.name} intro={intro} autoFocus={autoFocus} />
  return (
    <div className="agent-chat">
      <ChatSurface
        session={chat.session}
        focused={autoFocus}
        who={{
          name: who.name,
          face: <AgentBust agent={agent} size={56} />,
          intro,
          sendEnded: async (text) => !!(await sendToAgent(agent.id, text))
        }}
      />
    </div>
  )
}

/** An agent's chat before its first message: the same empty chat and composer; sending starts the chat. */
function AgentChatStart({ agent, name, intro, autoFocus }: { agent: CompanyAgent; name: string; intro: string; autoFocus: boolean }): React.JSX.Element {
  return (
    <div className="agent-chat">
      <div className="chat-pane chat-pane--agent" data-turn="idle">
        <div className="chat-scroll">
          <div className="chat-col">
            <div className="chat-empty chat-empty--agent">
              <AgentBust agent={agent} size={56} />
              <div className="chat-empty__name">{name}</div>
              <div>{intro}</div>
            </div>
          </div>
        </div>
        <div className="chat-dock">
          <Composer
            sessionId={`agent-new:${agent.id}`}
            turn="idle"
            meta={EMPTY_CHAT_META}
            disabled={false}
            exited={false}
            focused={autoFocus}
            onSend={async (text) => !!(await sendToAgent(agent.id, text))}
            onStop={() => undefined}
            onTerminal={() => toast(`Send ${name} a first message; the terminal opens on its chat after that`)}
            onSetMode={() => toast(`Send ${name} a first message, then choose how it asks`)}
            onSetModel={() => toast(`Send ${name} a first message, then choose its model`)}
            who={name}
          />
        </div>
      </div>
    </div>
  )
}

export { agentAutonomy, companyName }
