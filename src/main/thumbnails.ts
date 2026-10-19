/** Quick Look thumbnails (SPEC A9): macOS thumbnailer -> PNG data URL, cached in <userData>/thumbs/. */
import fs from 'node:fs'
import path from 'node:path'
import { app, nativeImage } from 'electron'
import type { Artifact } from '../shared/types'

export function thumbPath(thumbsDir: string, id: string, size: number): string {
  return path.join(thumbsDir, `${id}-${size}.png`)
}

export async function thumbnailFor(thumbsDir: string, a: Artifact, size = 320): Promise<string> {
  const cache = thumbPath(thumbsDir, a.id, size)
  try {
    const st = fs.statSync(cache)
    if (st.mtime.toISOString() >= a.mtime) return `data:image/png;base64,${fs.readFileSync(cache).toString('base64')}`
  } catch {
    /* no cache */
  }
  try {
    const img = await nativeImage.createThumbnailFromPath(a.path, { width: size, height: size })
    if (!img.isEmpty()) {
      const png = img.toPNG()
      try {
        fs.writeFileSync(cache, png, { mode: 0o600 })
      } catch {
        /* cache is best-effort */
      }
      return `data:image/png;base64,${png.toString('base64')}`
    }
  } catch {
    /* unsupported type -> file icon */
  }
  const icon = await app.getFileIcon(a.path, { size: 'large' })
  return icon.toDataURL()
}

export function removeThumbs(thumbsDir: string, id: string): void {
  try {
    for (const f of fs.readdirSync(thumbsDir)) if (f.startsWith(`${id}-`)) fs.rmSync(path.join(thumbsDir, f), { force: true })
  } catch {
    /* ignore */
  }
}
