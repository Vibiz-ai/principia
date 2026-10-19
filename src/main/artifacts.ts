/** Artifacts indexer (CONTRACT §7): chokidar watch on <userData>/artifacts + full rescans. */
import fs from 'node:fs'
import path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { Artifact, Id } from '../shared/types'
import { ownerOfArtifactDir } from '../shared/ids'
import type { Store } from './db/store'
import { classify, isIgnoredRel } from './artifactKinds'
import { isInside } from './pathGuard'

const MAX_DEPTH = 8
const MAX_FILES_PER_SCAN = 20000

export interface IndexerEvents {
  added(a: Artifact): void
  removed(id: Id): void
}

export class ArtifactIndexer {
  private watcher: FSWatcher | null = null
  constructor(
    private root: string,
    private store: Store,
    private events: IndexerEvents,
    private onRemovedFile: (a: Artifact) => void = () => {}
  ) {}

  /** Index (or refresh) one file. Returns the artifact, or null if ignored / not a file. */
  indexFile(abs: string): Artifact | null {
    const rel = path.relative(this.root, abs)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || isIgnoredRel(rel)) return null
    const segs = rel.split(path.sep)
    if (segs.length < 2) return null // files directly in the artifacts root have no owner
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      return null
    }
    if (!st.isFile()) return null
    const owner = ownerOfArtifactDir(segs[0])
    const { kind, mime } = classify(abs)
    const res = this.store.upsertArtifact({
      runId: owner.runId,
      sessionId: owner.sessionId,
      path: abs,
      relPath: segs.join('/'),
      name: path.basename(abs),
      kind,
      mime,
      bytes: st.size,
      mtime: st.mtime.toISOString()
    })
    if (res.changed) this.events.added(res.artifact)
    return res.artifact
  }

  removeFile(abs: string): void {
    const a = this.store.getArtifactByPath(abs)
    if (!a) return
    this.store.deleteArtifact(a.id)
    this.onRemovedFile(a)
    this.events.removed(a.id)
  }

  /** Full rescan of a directory under the root (run end, session exit, boot). Adds new files, drops vanished rows. */
  rescan(dir: string = this.root): { added: number; removed: number } {
    if (!isInside(dir, this.root)) return { added: 0, removed: 0 }
    const seen = new Set<string>()
    let added = 0
    let count = 0
    const walk = (d: string, depth: number) => {
      if (depth > MAX_DEPTH || count > MAX_FILES_PER_SCAN) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue
        const abs = path.join(d, e.name)
        if (e.isDirectory()) walk(abs, depth + 1)
        else if (e.isFile()) {
          count++
          const before = this.store.getArtifactByPath(abs)
          const a = this.indexFile(abs)
          if (a) {
            seen.add(abs)
            if (!before) added++
          }
        }
      }
    }
    walk(dir, 0)
    let removed = 0
    const existing = dir === this.root ? this.store.listArtifacts({ limit: 5000 }) : this.store.artifactsUnder(dir)
    for (const a of existing) {
      if (!seen.has(a.path) && !fs.existsSync(a.path)) {
        this.removeFile(a.path)
        removed++
      }
    }
    return { added, removed }
  }

  start(): void {
    if (this.watcher) return
    this.watcher = watch(this.root, {
      ignoreInitial: true,
      depth: MAX_DEPTH,
      ignored: (p: string) => isIgnoredRel(path.relative(this.root, p)),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    })
    this.watcher.on('add', (p) => this.indexFile(p))
    this.watcher.on('change', (p) => this.indexFile(p))
    this.watcher.on('unlink', (p) => this.removeFile(p))
    this.watcher.on('unlinkDir', (d) => {
      for (const a of this.store.artifactsUnder(d)) this.removeFile(a.path)
    })
    this.watcher.on('error', () => {
      /* EMFILE etc. -> rescans on run end still keep the index right */
    })
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
  }
}
