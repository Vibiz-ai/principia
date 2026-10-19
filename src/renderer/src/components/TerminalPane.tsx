/**
 * Live PTY view. PTY lives in main; this attaches, replays the scrollback, then streams `pty:data`.
 * Ordering: events and the attach reply share one IPC pipe, so chunks that arrive before the reply are
 * already inside the scrollback snapshot and are dropped; chunks after it are live.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Id } from '@shared/types'
import { PASTED_IMAGE_TYPES, type PastedImageType } from '@shared/ipc'
import { errorMessage, hive } from '../lib/hive'
import { setTermSize } from '../state/store'
import { isWebLink } from '@shared/externalLinks'

export interface TerminalHandle {
  focus: () => void
  copyOutput: () => string
  openSearch: () => void
}

/** Terminal.app drop format: shell specials backslash-escaped, so `Screenshot 2026-… at 10.00.png` stays one path. */
export const quotePath = (p: string): string => p.replace(/([ \\'"()&;|<>$`!*?[\]{}#~])/g, '\\$1')

const isPastedImage = (t: string): t is PastedImageType => (PASTED_IMAGE_TYPES as readonly string[]).includes(t)

/** Finder files keep their path; images without one (clipboard, browser drag) are saved by main first. */
async function filePaths(sessionId: Id, files: File[]): Promise<string[]> {
  const out: string[] = []
  for (const f of files) {
    const p = hive.pathForFile(f)
    if (p) out.push(p)
    else if (isPastedImage(f.type)) out.push((await hive.sessions.saveImage({ id: sessionId, data: new Uint8Array(await f.arrayBuffer()), type: f.type })).path)
  }
  return out
}

/** onData within this long after a key/paste/IME event in the pane is the user typing. */
const GESTURE_MS = 400

const THEME = {
  background: '#17181b',
  foreground: '#e6e6e9',
  cursor: '#e6e6e9',
  cursorAccent: '#17181b',
  selectionBackground: 'rgba(110, 140, 255, 0.35)',
  black: '#1e1f22',
  brightBlack: '#6d6e76'
}

export const TerminalPane = forwardRef<TerminalHandle, { sessionId: Id; readOnly: boolean; fontSize: number; focused: boolean; onFocus?: () => void; onSize?: (cols: number, rows: number) => void }>(
  function TerminalPane({ sessionId, readOnly, fontSize, focused, onFocus, onSize }, ref) {
    const host = useRef<HTMLDivElement>(null)
    const termRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const searchRef = useRef<SearchAddon | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [search, setSearch] = useState<string | null>(null)
    const onSizeRef = useRef(onSize)
    onSizeRef.current = onSize
    const onFocusRef = useRef(onFocus)
    onFocusRef.current = onFocus
    const readOnlyRef = useRef(readOnly)
    readOnlyRef.current = readOnly

    useImperativeHandle(ref, () => ({
      focus: () => termRef.current?.focus(),
      copyOutput: () => {
        const t = termRef.current
        if (!t) return ''
        if (t.hasSelection()) return t.getSelection()
        const b = t.buffer.active
        const lines: string[] = []
        for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
        return lines.join('\n').replace(/\n+$/, '\n')
      },
      openSearch: () => setSearch((s) => s ?? '')
    }))

    useEffect(() => {
      const el = host.current
      if (!el) return
      let disposed = false
      let live = false
      // Scrollback replay re-runs the agent's old terminal queries (DA, cursor position, colors); xterm answers them
      // through onData. Those answers belong to nobody: drop them instead of typing them into the agent.
      let replaying = false
      // Last real user gesture in this pane (key, paste, IME). xterm also emits onData on its own (focus reports,
      // query replies on mount/resize); only data within a gesture window counts as typed (LIVE.md A4b).
      let gestureAt = -Infinity
      const term = new Terminal({
        fontFamily: "'Geist Mono', 'SF Mono', Menlo, monospace",
        fontSize,
        lineHeight: 1.2,
        cursorBlink: true,
        macOptionIsMeta: true,
        macOptionClickForcesSelection: true,
        allowProposedApi: true,
        linkHandler: {
          activate: (event, url) => {
            event.preventDefault()
            if (!isWebLink(url)) return
            void hive.app.openExternal({ url }).catch((e) => setError(errorMessage(e)))
          }
        },
        // each Claude redraw lands in scrollback (scrollOnEraseInDisplay); 10k lines x 4 panes x remounts was the bulk of the heap
        scrollback: 5000,
        // a restarted agent clearing the screen pushes the previous run's output into scrollback instead of erasing it
        scrollOnEraseInDisplay: true,
        theme: THEME,
        disableStdin: readOnly
      })
      const fit = new FitAddon()
      const search = new SearchAddon()
      term.loadAddon(fit)
      term.loadAddon(search)
      termRef.current = term
      fitRef.current = fit
      searchRef.current = search
      // ⌘ chords belong to Hive (menu + shortcuts); Ctrl/Option chords and Esc go to the PTY.
      term.attachCustomKeyEventHandler((e) => !e.metaKey)

      const offData = hive.on('pty:data', (p) => {
        if (p.sessionId === sessionId && live && !disposed) term.write(p.data)
      })
      const disposables: { dispose: () => void }[] = []
      let ro: ResizeObserver | null = null
      let raf = 0

      const start = async (): Promise<void> => {
        try {
          await document.fonts.load(`${fontSize}px 'Geist Mono'`)
        } catch {
          /* fallback font */
        }
        if (disposed) return
        term.open(el)
        try {
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => webgl.dispose())
          term.loadAddon(webgl)
        } catch {
          /* DOM renderer fallback */
        }
        try {
          fit.fit()
        } catch {
          /* not visible yet */
        }
        el.addEventListener('focusin', () => onFocusRef.current?.())
        const mark = (): void => {
          gestureAt = performance.now()
        }
        el.addEventListener('keydown', (e) => !e.metaKey && mark(), true)
        for (const ev of ['paste', 'input', 'compositionend', 'drop'] as const) el.addEventListener(ev, mark, true)
        // Drop files / ⌘V an image: type their paths like Terminal.app does; Claude Code turns image paths into [Image #n].
        const pastePaths = (files: File[]): void => {
          filePaths(sessionId, files)
            .then((paths) => {
              if (disposed || !paths.length) return
              mark()
              term.paste(paths.map(quotePath).join(' ') + ' ')
              term.focus()
            })
            .catch((e) => setError(errorMessage(e)))
        }
        el.addEventListener('dragover', (e) => {
          if (readOnlyRef.current || !e.dataTransfer?.types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        })
        el.addEventListener('drop', (e) => {
          const files = Array.from(e.dataTransfer?.files ?? [])
          if (readOnlyRef.current || !files.length) return
          e.preventDefault()
          pastePaths(files)
        })
        el.addEventListener(
          'paste',
          (e) => {
            const cd = e.clipboardData
            if (readOnlyRef.current || !cd || cd.getData('text/plain')) return
            const images = Array.from(cd.files).filter((f) => isPastedImage(f.type))
            if (!images.length) return
            e.preventDefault()
            e.stopPropagation()
            pastePaths(images)
          },
          true
        )
        disposables.push(
          term.onData((data) => {
            if (readOnly || replaying) return
            hive.send('sessions:write', { id: sessionId, data, typed: performance.now() - gestureAt < GESTURE_MS })
          }),
          term.onResize(({ cols, rows }) => {
            if (!readOnly) hive.send('sessions:resize', { id: sessionId, cols, rows })
            setTermSize(cols, rows)
            onSizeRef.current?.(cols, rows)
          })
        )
        ro = new ResizeObserver(() => {
          cancelAnimationFrame(raf)
          raf = requestAnimationFrame(() => {
            if (disposed || !el.offsetWidth) return
            try {
              fit.fit()
            } catch {
              /* ignore */
            }
          })
        })
        ro.observe(el)
        try {
          const { scrollback } = await hive.sessions.attach({ id: sessionId })
          if (disposed) return
          // writes are parsed in order: the callback runs before any live chunk queued after it
          replaying = true
          term.write(scrollback, () => {
            replaying = false
          })
          live = true
          if (!readOnly) hive.send('sessions:resize', { id: sessionId, cols: term.cols, rows: term.rows })
          onSizeRef.current?.(term.cols, term.rows)
          setTermSize(term.cols, term.rows)
        } catch (e) {
          setError(errorMessage(e))
        }
      }
      void start()
      return () => {
        disposed = true
        offData()
        ro?.disconnect()
        cancelAnimationFrame(raf)
        disposables.forEach((d) => d.dispose())
        // the WebGL addon never releases its context; Chromium keeps ~16 per renderer and they hold GPU + heap memory
        el.querySelectorAll('canvas').forEach((c) => (c.getContext('webgl2') as WebGL2RenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext())
        term.dispose()
        termRef.current = null
      }
      // fontSize/readOnly are applied live below; re-attaching only when the session changes
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId])

    useEffect(() => {
      const t = termRef.current
      if (!t) return
      t.options.fontSize = fontSize
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
    }, [fontSize])
    useEffect(() => {
      if (termRef.current) termRef.current.options.disableStdin = readOnly
    }, [readOnly])
    useEffect(() => {
      if (focused) termRef.current?.focus()
    }, [focused])

    const find = (q: string, back = false): void => {
      if (!q) return
      const opts = { decorations: { matchOverviewRuler: '#6e8cff', activeMatchColorOverviewRuler: '#6e8cff', matchBackground: '#6e8cff55', activeMatchBackground: '#6e8cffaa' } }
      if (back) searchRef.current?.findPrevious(q, opts)
      else searchRef.current?.findNext(q, opts)
    }

    return (
      <div className="term">
        <div className="term__host" ref={host} />
        {search !== null && (
          <div className="term__search">
            <input
              autoFocus
              className="input input--sm"
              placeholder="Find"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                find(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') find(search, e.shiftKey)
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  searchRef.current?.clearDecorations()
                  setSearch(null)
                  termRef.current?.focus()
                }
              }}
            />
          </div>
        )}
        {error && <div className="term__error selectable">Couldn’t attach: {error}</div>}
      </div>
    )
  }
)
