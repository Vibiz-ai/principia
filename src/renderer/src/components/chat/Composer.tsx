/**
 * CHAT-UI.md §4.2 Composer: one rounded box at the bottom. Enter sends, Shift+Enter is a new line, Esc stops Claude.
 * `/` opens the command menu (terminal-only commands greyed: picking one opens the terminal), `@` mentions a file,
 * images paste or drop in. Chips for the model and the permission mode; a quiet context and plan meter.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatImage, ChatMeta, ChatTurn } from '@shared/chat'
import { TERMINAL_ONLY_COMMANDS } from '@shared/chat'
import { Icon } from '../Icon'
import { hive, nativeMenu } from '../../lib/hive'

const drafts = new Map<string, string>()
const MAX_IMAGE = 5 * 1024 * 1024
const MODES: { value: string; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask before edits', hint: 'Claude asks before it edits files or runs commands' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits go through; commands still ask' },
  { value: 'plan', label: 'Plan first', hint: 'Claude only reads and proposes a plan for you to approve' },
  { value: 'auto', label: 'Auto', hint: 'Claude decides what is safe to run without asking' }
]

export const modeLabel = (m: string | null, bypass: boolean): string => (bypass ? 'Runs without asking' : (MODES.find((x) => x.value === m)?.label ?? 'Ask before edits'))

interface Attached extends ChatImage {
  url: string
  name: string
}

/** A ~96 px JPEG of an image for the sent bubble (the full image goes to Claude). */
async function thumbOf(url: string): Promise<string | undefined> {
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const k = Math.min(1, 96 / Math.max(img.naturalWidth, img.naturalHeight, 1))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(img.naturalWidth * k))
    c.height = Math.max(1, Math.round(img.naturalHeight * k))
    c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height)
    const out = c.toDataURL('image/jpeg', 0.7)
    return out.length < 60_000 ? out : undefined
  } catch {
    return undefined
  }
}

type Menu = { kind: 'slash' | 'mention'; query: string; start: number; index: number }

export function Composer({
  sessionId,
  turn,
  meta,
  disabled,
  exited,
  focused,
  onSend,
  onStop,
  onTerminal,
  onSetMode,
  onSetModel
}: {
  sessionId: string
  turn: ChatTurn
  meta: ChatMeta
  disabled: boolean
  exited: boolean
  focused: boolean
  onSend(text: string, images: ChatImage[]): Promise<boolean>
  onStop(): void
  onTerminal(command?: string): void
  onSetMode(mode: string): void
  onSetModel(model: string): void
}): React.JSX.Element {
  const [text, setTextState] = useState(drafts.get(sessionId) ?? '')
  const [images, setImages] = useState<Attached[]>([])
  const [menu, setMenu] = useState<Menu | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const ta = useRef<HTMLTextAreaElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const working = turn === 'working' || turn === 'starting'
  const needs = turn === 'needs'

  const setText = (v: string): void => {
    setTextState(v)
    drafts.set(sessionId, v)
  }
  useEffect(() => {
    if (focused && !disabled) ta.current?.focus({ preventScroll: true })
  }, [focused, disabled])
  // auto-grow up to ~10 lines
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  // @ mentions: ask main for matching files (debounced)
  useEffect(() => {
    if (menu?.kind !== 'mention') return
    const t = setTimeout(() => {
      void hive.chat.files({ id: sessionId, query: menu.query }).then(setFiles, () => setFiles([]))
    }, 80)
    return () => clearTimeout(t)
  }, [menu?.kind, menu?.query, sessionId])

  const slashItems = useMemo(() => {
    if (menu?.kind !== 'slash') return []
    const q = menu.query.toLowerCase()
    const rank = (n: string): number => (n.toLowerCase().startsWith(q) ? 0 : 1)
    const here = meta.commands.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length).slice(0, 40).map((c) => ({ name: c.name, description: c.description, terminal: false }))
    const known = new Set(meta.commands.map((c) => c.name))
    const term = TERMINAL_ONLY_COMMANDS.filter((c) => !known.has(c.name) && c.name.includes(q)).map((c) => ({ ...c, terminal: true }))
    return [...here, ...term]
  }, [menu, meta.commands])
  const menuItems = menu?.kind === 'slash' ? slashItems.length : files.length

  const detectMenu = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const slash = /^\/([\w:.-]*)$/.exec(before)
    if (slash) return setMenu({ kind: 'slash', query: slash[1] ?? '', start: 0, index: 0 })
    const at = /(?:^|\s)@([^\s@]*)$/.exec(before)
    if (at) return setMenu({ kind: 'mention', query: at[1] ?? '', start: caret - (at[1]?.length ?? 0) - 1, index: 0 })
    setMenu(null)
  }

  const pick = (i: number): void => {
    if (!menu) return
    if (menu.kind === 'slash') {
      const c = slashItems[i]
      if (!c) return
      if (c.terminal) {
        setText('')
        setMenu(null)
        onTerminal(`/${c.name}`)
        return
      }
      setText(`/${c.name} `)
    } else {
      const f = files[i]
      if (!f) return
      const caret = ta.current?.selectionStart ?? text.length
      const next = `${text.slice(0, menu.start)}@${f} ${text.slice(caret)}`
      setText(next)
    }
    setMenu(null)
    ta.current?.focus()
  }

  const addFiles = async (list: FileList | File[]): Promise<void> => {
    const out: Attached[] = []
    for (const f of Array.from(list)) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type) || f.size > MAX_IMAGE) continue
      const buf = new Uint8Array(await f.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      const url = URL.createObjectURL(f)
      out.push({ mediaType: f.type as ChatImage['mediaType'], data: btoa(bin), url, name: f.name || 'image', thumb: await thumbOf(url) })
    }
    if (out.length) setImages((cur) => [...cur, ...out].slice(0, 6))
  }

  const submit = async (): Promise<void> => {
    const t = text.trim()
    if (!t && !images.length) return
    if (/^\/[\w:.-]+/.test(t)) {
      const name = t.slice(1).split(/\s/)[0]!
      // /model is the model chip here: bare opens the picker, "/model sonnet" switches
      if (name === 'model') {
        const arg = t.slice(6).trim()
        setText('')
        setMenu(null)
        if (arg) onSetModel(arg)
        else void modelMenu()
        return
      }
      if (TERMINAL_ONLY_COMMANDS.some((c) => c.name === name) && !meta.commands.some((c) => c.name === name)) {
        onTerminal(t)
        setText('')
        return
      }
    }
    const imgs = images.map(({ mediaType, data, thumb }) => ({ mediaType, data, ...(thumb ? { thumb } : {}) }))
    const ok = await onSend(t, imgs)
    if (ok) {
      setText('')
      for (const i of images) URL.revokeObjectURL(i.url)
      setImages([])
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menu && menuItems > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setMenu({ ...menu, index: (menu.index + d + menuItems) % menuItems })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(menu.index)
        return
      }
    }
    if (e.key === 'Escape') {
      if (menu) {
        e.preventDefault()
        setMenu(null)
        return
      }
      if (working || needs) {
        e.preventDefault()
        onStop()
      }
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const modelMenu = async (): Promise<void> => {
    if (!meta.models.length) return
    const id = await nativeMenu(meta.models.map((m) => ({ id: m.value, label: m.description ? `${m.label} — ${m.description}` : m.label, type: 'checkbox' as const, checked: meta.model === m.value })))
    if (id) onSetModel(id)
  }
  const modeMenu = async (): Promise<void> => {
    if (meta.bypass) return
    const id = await nativeMenu(MODES.map((m) => ({ id: m.value, label: `${m.label} — ${m.hint}`, type: 'checkbox' as const, checked: (meta.permissionMode ?? 'default') === m.value })))
    if (id) onSetMode(id)
  }

  const modelName = meta.models.find((m) => m.value === meta.model || meta.model?.includes(m.value))?.label ?? (meta.model ? meta.model.replace(/^claude-/, '') : 'Model')
  const placeholder = exited
    ? 'Send a message to pick this chat up again…'
    : disabled
      ? 'This conversation is open in the terminal'
      : needs
        ? 'Answer above, or type what Claude should do instead…'
        : working
          ? 'Add to the queue — Claude reads it when it finishes…'
          : 'Ask Claude anything. / for commands, @ for files'

  return (
    <div
      className="chat-composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void addFiles(e.dataTransfer.files)
      }}
    >
      {menu && menuItems > 0 && (
        <div className="chat-menu" role="listbox">
          {menu.kind === 'slash' ? (
            <>
              {slashItems.map((c, i) => (
                <div key={c.name} className={`chat-menu__h-wrap`}>
                  {i === slashItems.findIndex((x) => x.terminal) && <div className="chat-menu__h">Only in the terminal</div>}
                  <button type="button" role="option" aria-selected={i === menu.index} className={`chat-menu__i ${i === menu.index ? 'is-sel' : ''} ${c.terminal ? 'is-terminal' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
                    <b>/{c.name}</b>
                    <span>{c.description}</span>
                    {c.terminal && <em>terminal</em>}
                  </button>
                </div>
              ))}
            </>
          ) : (
            files.map((f, i) => (
              <button key={f} type="button" role="option" aria-selected={i === menu.index} className={`chat-menu__i ${i === menu.index ? 'is-sel' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
                <Icon name="file" size={12} />
                <b>{f.slice(f.lastIndexOf('/') + 1)}</b>
                <span>{f}</span>
              </button>
            ))
          )}
        </div>
      )}
      {images.length > 0 && (
        <div className="chat-attrow">
          {images.map((im, i) => (
            <span key={im.url} className="chat-attchip">
              <img src={im.url} alt="" />
              <span>{im.name}</span>
              <button type="button" aria-label="Remove image" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Message Claude"
        onChange={(e) => {
          setText(e.target.value)
          detectMenu(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={onKey}
        onBlur={() => setTimeout(() => setMenu(null), 120)}
        onPaste={(e) => {
          const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
          if (imgs.length) {
            e.preventDefault()
            void addFiles(imgs)
          }
        }}
      />
      <div className="chat-cbar">
        <button type="button" className="chat-iconbtn" title="Attach images" aria-label="Attach images" disabled={disabled} onClick={() => fileInput.current?.click()}>
          <Icon name="plus" size={14} />
        </button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
        <button
          type="button"
          className="chat-iconbtn"
          title="Mention a file"
          aria-label="Mention a file"
          disabled={disabled}
          onClick={() => {
            const next = `${text}${text && !text.endsWith(' ') ? ' ' : ''}@`
            setText(next)
            setMenu({ kind: 'mention', query: '', start: next.length - 1, index: 0 })
            ta.current?.focus()
          }}
        >
          @
        </button>
        <button type="button" className="chat-pill" onClick={() => void modelMenu()} disabled={disabled || !meta.models.length} title={`Model: ${modelName}`}>
          <span className="chat-pill__l">{modelName}</span> <Icon name="chevronDown" size={10} />
        </button>
        <button type="button" className="chat-pill" onClick={() => void modeMenu()} disabled={disabled || meta.bypass} title={meta.bypass ? 'Settings › Agents: Claude sessions skip permission prompts' : `When Claude asks you first: ${modeLabel(meta.permissionMode, meta.bypass)}`}>
          <Icon name="shield" size={11} /> <span className="chat-pill__l">{modeLabel(meta.permissionMode, meta.bypass)}</span> {!meta.bypass && <Icon name="chevronDown" size={10} />}
        </button>
        <span className="flex1" />
        <Meter meta={meta} />
        {working || needs ? (
          <button type="button" className="chat-stop" onClick={onStop} title="Stop (esc)">
            <i /> Stop
          </button>
        ) : (
          <button type="button" className="chat-send" onClick={() => void submit()} disabled={disabled || (!text.trim() && !images.length)} aria-label="Send" title="Send (↵)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 13V3M4 7l4-4 4 4" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

function Meter({ meta }: { meta: ChatMeta }): React.JSX.Element | null {
  if (meta.contextPct == null && meta.planPct == null) return null
  const pct = meta.contextPct ?? 0
  const r = 6
  const c = 2 * Math.PI * r
  const resets = meta.planResetsAt ? new Date(meta.planResetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null
  return (
    <span className="chat-meter" title={[meta.contextPct != null ? `${meta.contextPct}% of the context window used` : '', meta.planPct != null ? `${meta.planPct}% of your 5-hour plan window${resets ? `, resets ${resets}` : ''}` : '', meta.plan ?? ''].filter(Boolean).join('\n')}>
      {[meta.contextPct != null ? `${meta.contextPct}% context` : '', meta.planPct != null ? `${meta.planPct}% of plan` : ''].filter(Boolean).join(' · ')}
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="1.5" />
        <circle cx="8" cy="8" r={r} fill="none" stroke="var(--text-secondary)" strokeWidth="1.5" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 8 8)" strokeLinecap="round" />
      </svg>
    </span>
  )
}
