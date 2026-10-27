/**
 * CHAT-UI.md §4.2: the pieces of a chat transcript. White line art on the dark surface, cool accent only; "working"
 * reuses the shimmer classes from tokens.css.
 */
import { createContext, Fragment, useContext, useEffect, useRef, useState } from 'react'
import type { ChatDecision, ChatNoticeItem, ChatPermissionItem, ChatPlanItem, ChatQuestionItem, ChatTextItem, ChatThinkingItem, ChatToolItem, ChatTurnEndItem, ChatUserItem } from '@shared/chat'
import type { ChatBlock } from '@shared/chatView'
import { duration } from '@shared/chatView'
import { baseName, editDiff, groupSummary, partialField, permissionTitle, toolLine, type ToolIcon } from '@shared/toolVerbs'
import { tildify } from '../../lib/format'
import { Icon } from '../Icon'
import { MarkdownLite } from '../diagrams/MarkdownLite'
import { TextWithDiagrams } from '../diagrams/TextWithDiagrams'
import { blockKey, stampLabel } from '../../lib/agentChatView'
import { chatTaskCard } from '@shared/taskCard'
import { TaskCardView } from '../conversations/TaskCard'

const ICON: Record<ToolIcon, string> = {
  file: 'file',
  search: 'search',
  edit: 'edit',
  terminal: 'terminal',
  globe: 'globe',
  agents: 'agents',
  spark: 'spark',
  list: 'list',
  memory: 'memory',
  tasks: 'tasks',
  code: 'code'
}

/** AGENT CHAT: who answers in this chat ("Vitruvius", "Codex"); the cards say it instead of "Claude". */
export const ChatWho = createContext<string>('Claude')
/** "Claude wants to run a command" in the chat's own name */
function askTitle(tool: string, input: unknown, who: string): string {
  return permissionTitle(tool, input).replace(/^Claude\b/, who)
}

export interface CardActions {
  answer(requestId: string, d: ChatDecision): void
  /** the newest open request of the focused pane: it takes ↵ / esc */
  hotkeyFor: string | null
  /** the chat's folder: paths inside it show relative ("notes/plan.md"), never /private/tmp/… */
  cwd?: string | null
}

/** A path as a person reads it: relative to the chat's folder, else ~/…; null when the title already names it. */
export function friendlyPath(p: string, cwd: string | null | undefined): string | null {
  if (!p) return null
  const norm = (x: string): string => x.replace(/^\/private(?=\/)/, '').replace(/\/+$/, '')
  const a = norm(p)
  const c = cwd ? norm(cwd) : ''
  if (/^https?:/.test(p)) return p
  if (c && a.startsWith(`${c}/`)) {
    const rel = a.slice(c.length + 1)
    return rel === baseName(a) ? null : rel
  }
  return `${tildify(a)} (outside this chat’s folder)`
}

function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="chat-chev" />
}

function Spinner(): React.JSX.Element {
  return <span className="chat-spin" aria-hidden />
}

function StatusMark({ status }: { status: ChatToolItem['status'] }): React.JSX.Element | null {
  if (status === 'pending' || status === 'running') return <Spinner />
  if (status === 'ok') return <Icon name="check" size={13} className="chat-ok" />
  if (status === 'error') return <Icon name="close" size={13} className="chat-bad" />
  // the verb already says it ("Didn't edit", "Stopped before creating")
  return <Icon name="close" size={12} className="chat-dim" />
}

export function UserMessage({ item }: { item: ChatUserItem }): React.JSX.Element {
  return (
    <div className="chat-user selectable">
      {item.images > 0 && (
        <div className="chat-user__att">
          {Array.from({ length: Math.min(item.images, 6) }, (_, i) =>
            item.thumbs?.[i] ? (
              <img key={i} className="chat-thumb chat-thumb--img" src={item.thumbs[i]} alt="Sent image" />
            ) : (
              <span key={i} className="chat-thumb" title="Image">
                <Icon name="artifacts" size={13} />
              </span>
            )
          )}
        </div>
      )}
      <div className="chat-user__text">{item.text}</div>
    </div>
  )
}

export function AssistantText({ item }: { item: ChatTextItem }): React.JSX.Element | null {
  if (!item.md.trim() && !item.streaming) return null
  return (
    <div className={`chat-text ${item.streaming ? 'is-streaming' : ''}`}>
      <TextWithDiagrams text={item.md} renderText={(t, i) => <MarkdownLite key={i} text={t} />} />
      {item.streaming && <span className="chat-caret" aria-hidden />}
    </div>
  )
}

export function ThinkingRow({ item }: { item: ChatThinkingItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const has = !!item.text.trim()
  return (
    <div className="chat-row-wrap">
      <button type="button" className="chat-row" onClick={() => has && setOpen(!open)} aria-expanded={has ? open : undefined} disabled={!has && !item.streaming}>
        {has ? <Chevron open={open} /> : <span className="chat-chev-sp" />}
        <Icon name="spark" size={13} />
        {item.streaming ? <span className="shimmer-text">Thinking…</span> : <span>{item.ms ? `Thought for ${duration(item.ms)}` : 'Thought'}</span>}
      </button>
      {open && has && <div className="chat-thinking selectable">{item.text}</div>}
    </div>
  )
}

export function ToolGroupRow({ tools, live }: { tools: ChatToolItem[]; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const running = tools.some((t) => t.status === 'pending' || t.status === 'running')
  const names = [...new Set(tools.map((t) => toolLine(t).target).filter(Boolean))]
  return (
    <div className="chat-row-wrap">
      <button type="button" className="chat-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Chevron open={open} />
        <Icon name="search" size={13} />
        <span className={running && live ? 'shimmer-text' : ''}>{groupSummary(tools)}</span>
        {names.length > 0 && <span className="chat-meta chat-row__names">· {names.slice(0, 3).join(', ')}{names.length > 3 ? '…' : ''}</span>}
      </button>
      {open && (
        <div className="chat-group">
          {tools.map((t) => (
            <ToolCard key={t.id} item={t} live={live} flat />
          ))}
        </div>
      )}
    </div>
  )
}

function DiffView({ item }: { item: ChatToolItem }): React.JSX.Element {
  const lines = editDiff(item.name, item.input)
  return (
    <div className="chat-diff mono selectable">
      {lines.map((l, i) => (
        <div key={i} className={l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}>
          <span className="chat-diff__sign">{l.t === ' ' ? ' ' : l.t === '-' ? '−' : '+'}</span>
          {l.text || ' '}
        </div>
      ))}
    </div>
  )
}

/** What a tool is writing while its input streams in: the file text so far (never raw JSON). */
function StreamingInput({ item }: { item: ChatToolItem }): React.JSX.Element | null {
  const field = item.name === 'Write' ? 'content' : item.name === 'Edit' ? 'new_string' : item.name === 'Bash' ? 'command' : null
  const text = field ? partialField(item.inputPartial, field) : null
  if (text === null) return field ? null : <div className="chat-out chat-out--input">Preparing…</div>
  if (item.name === 'Bash') return <pre className="chat-cmd mono">{text}</pre>
  const lines = text.split('\n')
  return (
    <div className="chat-diff mono">
      {lines.slice(-200).map((l, i) => (
        <div key={i} className="add">
          <span className="chat-diff__sign">+</span>
          {l || ' '}
        </div>
      ))}
    </div>
  )
}

function ToolBody({ item }: { item: ChatToolItem }): React.JSX.Element {
  const [all, setAll] = useState(false)
  const isEdit = item.name === 'Edit' || item.name === 'MultiEdit' || item.name === 'Write'
  const cmd = item.name === 'Bash' ? String(item.input.command ?? '') : ''
  const out = item.resultText
  const lines = out.split('\n')
  const shown = all ? out : lines.slice(-40).join('\n')
  const otherInput = !isEdit && !cmd && Object.keys(item.input).length > 0
  return (
    <div className="chat-card__b">
      {item.status === 'pending' && item.inputPartial && <StreamingInput item={item} />}
      {cmd && <pre className="chat-cmd mono selectable">{cmd}</pre>}
      {isEdit && item.status !== 'pending' && <DiffView item={item} />}
      {otherInput && <pre className="chat-out chat-out--input mono selectable">{JSON.stringify(item.input, null, 2).slice(0, 4000)}</pre>}
      {out && !isEdit && (
        <>
          <pre className={`chat-out mono selectable ${item.status === 'error' ? 'is-error' : ''}`}>{shown}</pre>
          {!all && (lines.length > 40 || item.resultTruncated) && (
            <button type="button" className="chat-link" onClick={() => setAll(true)}>
              Show all {item.resultTruncated ? '(trimmed)' : `${lines.length} lines`}
            </button>
          )}
        </>
      )}
      {out && isEdit && item.status === 'error' && <pre className="chat-out mono is-error">{out}</pre>}
    </div>
  )
}

export function ToolCard({ item, live, flat, children }: { item: ChatToolItem; live: boolean; flat?: boolean; children?: ChatBlock[] }): React.JSX.Element {
  const isEdit = item.name === 'Edit' || item.name === 'MultiEdit' || item.name === 'Write'
  const sub = item.name === 'Task' || item.name === 'Agent'
  const [open, setOpen] = useState<boolean | null>(null)
  const line = toolLine(item)
  // while the input streams in, the file name is already there: "Creating captions.md", not "Creating"
  const streamedPath = !line.target && item.inputPartial ? partialField(item.inputPartial, 'file_path') : null
  const l = streamedPath ? { ...line, target: baseName(streamedPath) } : line
  const running = item.status === 'pending' || item.status === 'running'
  // a live view of the file only while Claude writes it in a running turn (a stopped Write folds away)
  const isOpen = open ?? (item.status === 'error' || (isEdit && item.status === 'pending' && live) || (sub && running))
  const steps = children?.length ?? 0
  return (
    <div className={`chat-card ${flat ? 'chat-card--flat' : ''} ${item.status === 'error' ? 'is-error' : ''}`}>
      <button type="button" className="chat-card__h" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
        <Chevron open={isOpen} />
        <Icon name={ICON[l.icon]} size={13} className="chat-card__icon" />
        <span className={`chat-card__verb ${running && live ? 'shimmer-text' : ''}`}>{l.verb}</span>
        {l.target && <span className="chat-card__target mono">{l.target}</span>}
        {l.meta && <DiffMeta meta={l.meta} />}
        <span className="flex1" />
        {sub && steps > 0 && <span className="chat-meta">{steps} step{steps === 1 ? '' : 's'}</span>}
        {item.ms != null && !running && item.ms >= 1000 && <span className="chat-meta">{duration(item.ms)}</span>}
        {running && live && item.status === 'pending' && <span className="chat-meta">writing…</span>}
        <StatusMark status={item.status} />
      </button>
      {isOpen && (sub ? <div className="chat-sub">{children && <Blocks blocks={children} live={live} actions={null} />}{item.resultText && !running && <div className="chat-sub__report"><MarkdownLite text={item.resultText.slice(0, 6000)} /></div>}</div> : <ToolBody item={item} />)}
    </div>
  )
}

function DiffMeta({ meta }: { meta: string }): React.JSX.Element {
  const m = /^\+(\d+) −(\d+)$/.exec(meta)
  if (!m) return <span className="chat-meta">{meta}</span>
  return (
    <span className="chat-diffmeta mono">
      <span className="chat-plus">+{m[1]}</span> <span className="chat-minus">−{m[2]}</span>
    </span>
  )
}

export function TodoCard({ item, latest, live }: { item: ChatToolItem; latest: boolean; live: boolean }): React.JSX.Element {
  const todos = (Array.isArray(item.input.todos) ? item.input.todos : []) as { content?: string; status?: string; activeForm?: string }[]
  const done = todos.filter((t) => t.status === 'completed').length
  if (!latest)
    return (
      <div className="chat-row-wrap">
        <div className="chat-row chat-row--static">
          <span className="chat-chev-sp" />
          <Icon name="list" size={13} />
          <span>Updated the plan</span>
          <span className="chat-meta">· {done} of {todos.length} done</span>
        </div>
      </div>
    )
  return (
    <div className="chat-card">
      <div className="chat-card__h chat-card__h--static">
        <Icon name="list" size={13} className="chat-card__icon" />
        <span className="chat-card__verb">Plan</span>
        <span className="flex1" />
        <span className="chat-meta">
          {done} of {todos.length}
        </span>
      </div>
      <div className="chat-todo">
        {todos.map((t, i) => (
          <div key={i} className={`chat-todo__i is-${t.status ?? 'pending'}`}>
            {t.status === 'in_progress' ? <Spinner /> : <span className={`chat-box ${t.status === 'completed' ? 'is-done' : ''}`}>{t.status === 'completed' && <Icon name="check" size={10} />}</span>}
            <span className={t.status === 'in_progress' && live ? 'shimmer-text' : ''}>{t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function useHotkeys(enabled: boolean, onEnter: (() => void) | null, onEsc: (() => void) | null): React.RefObject<HTMLButtonElement | null> {
  const ref = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (enabled && ref.current && !document.activeElement?.closest('.chat-composer textarea:not(:placeholder-shown)')) ref.current.focus({ preventScroll: true })
  }, [enabled])
  useEffect(() => {
    if (!enabled) return
    const on = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      // typing in the composer (or any field) never answers a card
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && (t as HTMLInputElement).value) return
      if (e.key === 'Enter' && onEnter && !e.shiftKey && !e.metaKey) {
        // a focused button or field handles its own Return
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.isContentEditable)) return
        e.preventDefault()
        onEnter()
      }
      if (e.key === 'Escape' && onEsc && t?.closest('.chat-needs')) {
        e.preventDefault()
        e.stopPropagation()
        onEsc()
      }
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [enabled, onEnter, onEsc])
  return ref
}

export function PermissionCard({ item, actions }: { item: ChatPermissionItem; actions: CardActions | null }): React.JSX.Element {
  const who = useContext(ChatWho)
  const [instead, setInstead] = useState<string | null>(null)
  const open = item.state === 'open' && !!actions
  const allow = (): void => actions?.answer(item.requestId, { kind: 'allow' })
  const deny = (): void => actions?.answer(item.requestId, { kind: 'deny' })
  const ref = useHotkeys(open && actions?.hotkeyFor === item.requestId && instead === null, allow, deny)
  const cmd = item.tool === 'Bash' ? String(item.input.command ?? '') : ''
  const rawPath = String(item.input.file_path ?? item.input.notebook_path ?? item.input.url ?? '') || item.blockedPath || ''
  // the title names the file; the full system path never shows (a subfolder or "outside this chat's folder" does)
  const path = friendlyPath(rawPath, actions?.cwd)
  // the CLI's own description often just repeats the file (or its full path): say it once
  const desc = item.description && rawPath ? item.description.split(rawPath).join(path ?? baseName(rawPath)) : item.description
  const showDesc = !!desc && desc.trim() !== baseName(rawPath) && desc.trim() !== path
  const isEdit = item.tool === 'Edit' || item.tool === 'MultiEdit' || item.tool === 'Write'
  if (!open)
    return (
      <div className="chat-row-wrap">
        <div className="chat-row chat-row--static">
          <span className="chat-chev-sp" />
          <Icon name="shield" size={13} />
          <span>{askTitle(item.tool, item.input, who).replace(`${who} wants to`, 'Asked to')}</span>
          <span className="chat-meta">· {item.state === 'expired' ? 'no longer needed' : (item.outcome ?? item.state)}</span>
        </div>
      </div>
    )
  return (
    <div className="chat-card chat-needs" role="group" aria-label={askTitle(item.tool, item.input, who)}>
      <div className="chat-card__h chat-card__h--static">
        <Icon name="shield" size={14} className="chat-accent" />
        <span className="chat-card__verb">{askTitle(item.tool, item.input, who)}</span>
        <span className="flex1" />
        <span className="chat-meta">needs you</span>
      </div>
      <div className="chat-needs__body">
        {showDesc && <div className="chat-needs__desc">{desc}</div>}
        {cmd && <pre className="chat-cmd mono selectable">{cmd}</pre>}
        {!cmd && path && <div className="chat-cmd mono selectable">{path}</div>}
        {isEdit && <DiffView item={{ ...placeholderTool, name: item.tool, input: item.input }} />}
        {instead === null ? (
          <div className="chat-btns">
            <button ref={ref} type="button" className="chat-btn chat-btn--pri" onClick={allow}>
              Allow <kbd>↵</kbd>
            </button>
            {item.suggestions.map((s, i) => (
              <button key={i} type="button" className="chat-btn" onClick={() => actions?.answer(item.requestId, { kind: 'allowAlways', suggestion: i })} title={`Remembered by ${who === 'Codex' || who === 'Claude' ? who : 'the agent’s CLI'} for this folder or chat`}>
                <SuggestionLabel text={s.label} />
              </button>
            ))}
            <button type="button" className="chat-btn" onClick={deny}>
              Deny <kbd>esc</kbd>
            </button>
            <span className="flex1" />
            <button type="button" className="chat-btn chat-btn--ghost" onClick={() => setInstead('')}>
              Tell {who} what to do instead…
            </button>
          </div>
        ) : (
          <form
            className="chat-instead"
            onSubmit={(e) => {
              e.preventDefault()
              actions?.answer(item.requestId, { kind: 'deny', message: instead })
            }}
          >
            <input autoFocus className="chat-input" value={instead} placeholder="Do this instead…" onChange={(e) => setInstead(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setInstead(null)} />
            <button type="submit" className="chat-btn chat-btn--pri" disabled={!instead.trim()}>
              Send
            </button>
            <button type="button" className="chat-btn chat-btn--ghost" onClick={() => setInstead(null)}>
              Cancel
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const placeholderTool: ChatToolItem = { id: '', kind: 'tool', parent: null, toolUseId: '', name: '', input: {}, inputPartial: '', status: 'ok', resultText: '', resultTruncated: false, startedAt: null, ms: null }

/** "Always allow `git push` here" with the backticked part in mono. */
function SuggestionLabel({ text }: { text: string }): React.JSX.Element {
  const parts = text.split('`')
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <code key={i} className="mono">
            {p}
          </code>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

export function QuestionCard({ item, actions }: { item: ChatQuestionItem; actions: CardActions | null }): React.JSX.Element {
  const open = item.state === 'open' && !!actions
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const answers = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const q of item.questions) {
      const sel = picked[q.question] ?? []
      const labels = sel.map((l) => (l === '__other' ? (other[q.question] ?? '').trim() : l)).filter(Boolean)
      if (labels.length) out[q.question] = labels.join(', ')
    }
    return out
  }
  const ready = item.questions.every((q) => (answers()[q.question] ?? '') !== '')
  const submit = (): void => {
    if (ready) actions?.answer(item.requestId, { kind: 'answer', answers: answers() })
  }
  const ref = useHotkeys(open && actions?.hotkeyFor === item.requestId && ready, submit, () => actions?.answer(item.requestId, { kind: 'skip' }))
  if (!open)
    return (
      <div className="chat-row-wrap">
        <div className="chat-row chat-row--static">
          <span className="chat-chev-sp" />
          <Icon name="chat" size={13} />
          <span>{item.questions[0]?.question ?? 'Question'}</span>
          <span className="chat-meta">· {item.state === 'answered' ? Object.values(item.answers ?? {}).join(', ') : item.state === 'skipped' ? 'skipped' : 'no longer needed'}</span>
        </div>
      </div>
    )
  return (
    <div className="chat-card chat-needs" role="group">
      {item.questions.map((q, qi) => {
        const sel = picked[q.question] ?? []
        const toggle = (label: string): void =>
          setPicked((p) => ({ ...p, [q.question]: q.multiSelect ? (sel.includes(label) ? sel.filter((x) => x !== label) : [...sel, label]) : [label] }))
        return (
          <div key={qi} className="chat-q">
            <div className="chat-card__h chat-card__h--static">
              <Icon name="chat" size={14} className="chat-accent" />
              <span className="chat-card__verb">{q.question}</span>
              <span className="flex1" />
              <span className="chat-meta">{item.questions.length > 1 ? `question ${qi + 1} of ${item.questions.length}` : q.multiSelect ? 'pick any' : ''}</span>
            </div>
            <div className="chat-needs__body">
              {[...q.options, { label: '__other', description: 'Type your own answer' }].map((o) => (
                <button key={o.label} type="button" className={`chat-opt ${sel.includes(o.label) ? 'is-sel' : ''}`} onClick={() => toggle(o.label)} aria-pressed={sel.includes(o.label)}>
                  <span className={q.multiSelect ? 'chat-box' : 'chat-radio'} />
                  <span>
                    {o.label === '__other' ? 'Something else…' : o.label}
                    {o.description && <small>{o.description}</small>}
                  </span>
                </button>
              ))}
              {sel.includes('__other') && <input className="chat-input" autoFocus value={other[q.question] ?? ''} placeholder="Your answer" onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))} />}
            </div>
          </div>
        )
      })}
      <div className="chat-needs__body">
        <div className="chat-btns">
          <button ref={ref} type="button" className="chat-btn chat-btn--pri" disabled={!ready} onClick={submit}>
            Answer
          </button>
          <button type="button" className="chat-btn chat-btn--ghost" onClick={() => actions?.answer(item.requestId, { kind: 'skip' })}>
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}

export function PlanCard({ item, actions }: { item: ChatPlanItem; actions: CardActions | null }): React.JSX.Element {
  const who = useContext(ChatWho)
  const open = item.state === 'open' && !!actions
  const [why, setWhy] = useState<string | null>(null)
  const ref = useHotkeys(open && actions?.hotkeyFor === item.requestId && why === null, () => actions?.answer(item.requestId, { kind: 'approvePlan' }), null)
  return (
    <div className={`chat-card ${open ? 'chat-needs' : ''}`}>
      <div className="chat-card__h chat-card__h--static">
        <Icon name="plans" size={14} className={open ? 'chat-accent' : ''} />
        <span className="chat-card__verb">{open ? `${who} has a plan` : 'Plan'}</span>
        <span className="flex1" />
        <span className="chat-meta">{open ? 'needs you' : item.state === 'approved' ? 'approved' : item.state === 'rejected' ? 'kept planning' : ''}</span>
      </div>
      <div className="chat-needs__body">
        <div className="chat-plan selectable">
          <MarkdownLite text={item.plan} />
        </div>
        {open &&
          (why === null ? (
            <div className="chat-btns">
              <button ref={ref} type="button" className="chat-btn chat-btn--pri" onClick={() => actions?.answer(item.requestId, { kind: 'approvePlan' })}>
                Approve <kbd>↵</kbd>
              </button>
              <button type="button" className="chat-btn" onClick={() => actions?.answer(item.requestId, { kind: 'approvePlan', acceptEdits: true })}>
                Approve and let {who} edit
              </button>
              <button type="button" className="chat-btn chat-btn--ghost" onClick={() => setWhy('')}>
                Keep planning…
              </button>
            </div>
          ) : (
            <form
              className="chat-instead"
              onSubmit={(e) => {
                e.preventDefault()
                actions?.answer(item.requestId, { kind: 'rejectPlan', message: why })
              }}
            >
              <input autoFocus className="chat-input" value={why} placeholder="What should change?" onChange={(e) => setWhy(e.target.value)} />
              <button type="submit" className="chat-btn chat-btn--pri">
                Send
              </button>
            </form>
          ))}
      </div>
    </div>
  )
}

export function NoticeRow({ item, onAction }: { item: ChatNoticeItem; onAction?: (a: 'retry' | 'openTerminal') => void }): React.JSX.Element {
  return (
    <div className={`chat-notice is-${item.tone}`}>
      <span>{item.text}</span>
      {item.action && onAction && (
        <button type="button" className="chat-link" onClick={() => onAction(item.action!)}>
          {item.action === 'retry' ? 'Retry' : 'Open terminal'}
        </button>
      )}
    </div>
  )
}

export function TurnEnd({ item }: { item: ChatTurnEndItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const n = item.files.length
  return (
    <div className="chat-turnend-wrap">
      <button type="button" className="chat-turnend" onClick={() => n && setOpen(!open)} disabled={!n} title={item.costUsd != null ? `$${item.costUsd.toFixed(4)} at API prices` : undefined}>
        {item.error ? <Icon name="warning" size={12} className="chat-bad" /> : <Icon name="check" size={12} />}
        <span>
          {item.error ? 'Stopped with an error' : 'Worked'}
          {item.ms ? ` for ${duration(item.ms)}` : ''}
          {n ? ` · ${n} file${n === 1 ? '' : 's'} changed` : ''}
        </span>
        {n > 0 && <Chevron open={open} />}
      </button>
      {item.error && <div className="chat-turnend__err selectable">{item.error}</div>}
      {open && (
        <div className="chat-files mono">
          {item.files.map((f) => (
            <div key={f.path} title={f.path}>
              <span>{baseName(f.path)}</span>
              <span className="chat-plus">+{f.add}</span>
              <span className="chat-minus">−{f.del}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Draws blocks (top level and inside a subagent card). */
export function Blocks({ blocks, live, actions, onNotice, stamps }: { blocks: ChatBlock[]; live: boolean; actions: CardActions | null; onNotice?: (a: 'retry' | 'openTerminal') => void; stamps?: Map<string, number> }): React.JSX.Element {
  const now = Date.now()
  return (
    <>
      {blocks.map((b) => {
        const el = block(b, live, actions, onNotice)
        const at = stamps?.get(blockKey(b))
        if (at === undefined) return el
        return (
          <Fragment key={`s:${blockKey(b)}`}>
            <div className="chat-stamp" role="separator">
              <time dateTime={new Date(at).toISOString()}>{stampLabel(at, now)}</time>
            </div>
            {el}
          </Fragment>
        )
      })}
    </>
  )
}

function block(b: ChatBlock, live: boolean, actions: CardActions | null, onNotice?: (a: 'retry' | 'openTerminal') => void): React.JSX.Element | undefined {
  if (b.t === 'group') return <ToolGroupRow key={b.id} tools={b.tools} live={live} />
  if (b.t === 'todo') return <TodoCard key={b.item.id} item={b.item} latest={b.latest} live={live} />
  if (b.t === 'tool') {
    // CHAT-UI.md §8: a task this chat filed (company_file_task, task_create) is its live card, not a tool row
    const card = chatTaskCard(b.item)
    if (card) return <TaskCardView key={b.item.id} card={card} />
    return <ToolCard key={b.item.id} item={b.item} live={live} children={b.children} />
  }
  const it = b.item
  switch (it.kind) {
    case 'user':
      return <UserMessage key={it.id} item={it} />
    case 'text':
      return <AssistantText key={it.id} item={it} />
    case 'thinking':
      return <ThinkingRow key={it.id} item={it} />
    case 'permission':
      return <PermissionCard key={it.id} item={it} actions={actions} />
    case 'question':
      return <QuestionCard key={it.id} item={it} actions={actions} />
    case 'plan':
      return <PlanCard key={it.id} item={it} actions={actions} />
    case 'notice':
      return <NoticeRow key={it.id} item={it} onAction={onNotice} />
    case 'turnEnd':
      return <TurnEnd key={it.id} item={it} />
  }
}
