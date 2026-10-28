/**
 * Files dropped or pasted into a box that only carries text (New conversation, New chat): each one becomes an @path
 * mention the agent opens itself, as the chat composer does for non-image files. A file from Finder keeps its own
 * path; a pasted screenshot (no file behind it) is saved first. Anything else is skipped, by name.
 */
import { useRef, useState } from 'react'
import { PASTED_IMAGE_TYPES, type PastedImageType } from '@shared/ipc'

const isPastedImage = (t: string): t is PastedImageType => (PASTED_IMAGE_TYPES as readonly string[]).includes(t)

export interface DropIO {
  /** the file's path on disk, '' when it has none (a pasted screenshot, an image dragged from a web page) */
  pathFor(f: File): string
  /** saves an image with no file behind it, returns its path */
  saveImage(data: Uint8Array, type: PastedImageType): Promise<string>
}

/** `@path`, quoted when the path has spaces (as @ in the composer writes it). */
export const mentionOf = (p: string): string => (/\s/.test(p) ? `@"${p}"` : `@${p}`)

/** `text` with the mentions added at the end, one space between, a space after so you can keep typing. */
export function withMentions(text: string, mentions: string[]): string {
  if (!mentions.length) return text
  return `${text}${text && !/\s$/.test(text) ? ' ' : ''}${mentions.join(' ')} `
}

export async function dropMentions(files: FileList | File[], io: DropIO): Promise<{ mentions: string[]; skipped: string[] }> {
  const mentions: string[] = []
  const skipped: string[] = []
  for (const f of Array.from(files)) {
    let p: string
    try {
      p = io.pathFor(f)
      if (!p && isPastedImage(f.type)) p = await io.saveImage(new Uint8Array(await f.arrayBuffer()), f.type)
    } catch {
      p = ''
    }
    if (p) mentions.push(mentionOf(p))
    else skipped.push(f.name || 'a file')
  }
  return { mentions, skipped }
}

/** Does this drag carry files (not text or a link)? */
export const draggingFiles = (e: { dataTransfer: DataTransfer | null }): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files')

/**
 * Drag handlers for an element that takes dropped files (`off`: ignore drops), and whether files are over it now.
 * Counts enter/leave so moving over its children does not flicker the overlay (as the chat pane does).
 */
export function useFileDrop(onFiles: (files: FileList) => void, off = false): { dragging: boolean; handlers: Pick<React.DOMAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'> } {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  return {
    dragging: dragging && !off,
    handlers: {
      onDragEnter: (e) => {
        if (off || !draggingFiles(e)) return
        depth.current++
        setDragging(true)
      },
      onDragOver: (e) => {
        if (off || !draggingFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setDragging(false)
      },
      onDrop: (e) => {
        depth.current = 0
        setDragging(false)
        if (off || !e.dataTransfer.files.length) return
        e.preventDefault()
        e.stopPropagation()
        onFiles(e.dataTransfer.files)
      }
    }
  }
}
