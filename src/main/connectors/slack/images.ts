/**
 * Desktop ImageSink (SLACK.md §9.6): thread images land in one folder of the run's artifacts, each file 0600, created
 * exclusively (never overwrites), names already sanitized by core/files.ts and re-checked here.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ImageSink } from './core/files'

export function diskImageSink(destDir: string): ImageSink {
  return {
    async write(name, bytes) {
      const safe = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'image'
      await fs.promises.mkdir(destDir, { recursive: true, mode: 0o700 })
      let file = path.join(destDir, safe)
      for (let n = 2; fs.existsSync(file); n++) file = path.join(destDir, `${n}-${safe}`)
      await fs.promises.writeFile(file, bytes, { mode: 0o600, flag: 'wx' })
      return file
    }
  }
}
