/**
 * Every text box takes a dropped image (or any file), not only the chat composers: a box that does not handle files
 * itself (a task brief, a Forum post, an agent's instructions, a note…) gets each file as an @path mention at the
 * caret, as New conversation does. A pasted screenshot with no file behind it is saved first. Boxes that take files
 * their own way (the chat composer attaches images, the terminal pastes paths) handle the event first and mark it
 * handled; this only picks up what nobody took.
 */
import { dropMentions, draggingFiles, type DropIO } from './dropFiles'

type TextField = HTMLInputElement | HTMLTextAreaElement

/** One-line inputs that hold free text (not a password, a number or a date). */
const TEXT_INPUTS = new Set(['', 'text', 'search', 'url'])

/** The editable text box at `target`, or null (a disabled or read-only box, the terminal's hidden one, not a box). */
export function textFieldAt(target: EventTarget | null): TextField | null {
  const el = target instanceof Element ? target.closest('textarea, input') : null
  if (!el || el.closest('.xterm, [data-no-field-drop]')) return null
  if (el instanceof HTMLInputElement && !TEXT_INPUTS.has(el.getAttribute('type')?.toLowerCase() ?? '')) return null
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) || el.disabled || el.readOnly) return null
  return el
}

/**
 * Where a dropped file goes: the text box under the pointer, else the box a drop zone around it names (a Forum
 * channel or thread marks itself `data-field-drop-zone` and its composer `data-field-drop-target`, so a file dropped
 * anywhere on the conversation lands in the message box, not only on its one-line field).
 */
export function dropFieldAt(target: EventTarget | null): TextField | null {
  const own = textFieldAt(target)
  if (own || (target instanceof Element && target.closest('textarea, input'))) return own
  const zone = target instanceof Element ? target.closest('[data-field-drop-zone]') : null
  return zone ? textFieldAt(zone.querySelector('[data-field-drop-target]')) : null
}

/**
 * `mentions` put into `value` over the selection `start..end`: one space before them unless the caret already
 * follows a space (or starts the box), one after so you can keep typing. Returns what to insert and the new caret.
 */
export function mentionInsert(value: string, start: number, end: number, mentions: string[]): { insert: string; caret: number } {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${mentions.join(' ')}${after && /^\s/.test(after) ? '' : ' '}`
  return { insert, caret: start + insert.length }
}

/** Put `mentions` at the box's caret (its end if it was never focused) so React's onChange sees it and ⌘Z undoes it. */
function insertMentions(el: TextField, mentions: string[], hadFocus: boolean): void {
  const len = el.value.length
  const start = hadFocus ? (el.selectionStart ?? len) : len
  const end = hadFocus ? (el.selectionEnd ?? len) : len
  const { insert, caret } = mentionInsert(el.value, start, end, mentions)
  el.focus()
  el.setSelectionRange(start, end)
  // execCommand keeps the native undo stack and fires `input`; fall back to setting the value React tracks
  if (!el.ownerDocument.execCommand('insertText', false, insert)) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, el.value.slice(0, start) + insert + el.value.slice(end))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  el.setSelectionRange(caret, caret)
}

const OVER = 'field-drop-over'

/**
 * Listen on `doc` (bubbling, after React's own handlers): files dragged over a text box show it takes them; dropped
 * or pasted ones become mentions. Returns a function that stops listening.
 */
export function wireFieldDrops(doc: Document, io: DropIO & { skipped(names: string[]): void }): () => void {
  let over: TextField | null = null
  const unmark = (): void => {
    over?.classList.remove(OVER)
    over = null
  }
  const take = (el: TextField, files: File[]): void => {
    const hadFocus = doc.activeElement === el
    void dropMentions(files, io).then(({ mentions, skipped }) => {
      if (mentions.length && el.isConnected && !el.disabled) insertMentions(el, mentions, hadFocus)
      if (skipped.length) io.skipped(skipped)
    })
  }
  const onOver = (e: DragEvent): void => {
    if (e.defaultPrevented || !draggingFiles(e)) return
    const el = dropFieldAt(e.target)
    if (el !== over) {
      unmark()
      if (el) (over = el).classList.add(OVER)
    }
    if (!el) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
  const onLeave = (e: DragEvent): void => {
    // still over the box, or still inside the zone that feeds it: keep it lit
    if (over && !(e.relatedTarget instanceof Node && (over.contains(e.relatedTarget) || over.closest('[data-field-drop-zone]')?.contains(e.relatedTarget)))) unmark()
  }
  const onDrop = (e: DragEvent): void => {
    unmark()
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (e.defaultPrevented || !files.length) return
    const el = dropFieldAt(e.target)
    if (!el) return
    e.preventDefault()
    take(el, files)
  }
  const onPaste = (e: ClipboardEvent): void => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
    // text on the clipboard too (a copied web page, a cell): that is what you meant to paste
    if (e.defaultPrevented || !files.length || e.clipboardData?.getData('text/plain')) return
    const el = textFieldAt(e.target)
    if (!el) return
    e.preventDefault()
    take(el, files)
  }
  doc.addEventListener('dragover', onOver)
  doc.addEventListener('dragleave', onLeave)
  doc.addEventListener('drop', onDrop)
  doc.addEventListener('dragend', unmark)
  doc.addEventListener('paste', onPaste)
  return () => {
    unmark()
    doc.removeEventListener('dragover', onOver)
    doc.removeEventListener('dragleave', onLeave)
    doc.removeEventListener('drop', onDrop)
    doc.removeEventListener('dragend', unmark)
    doc.removeEventListener('paste', onPaste)
  }
}
