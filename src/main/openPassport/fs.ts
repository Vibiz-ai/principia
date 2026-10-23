// Vendored from open-passport 0.1.0 (packages/js/src/node/fs.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Reading and writing passport folders and `.passport.zip` files (node only).
import fs from 'node:fs'
import path from 'node:path'
import { ALLOWED_EXT, MAX_FILE_BYTES, MAX_FILES, safeRelPath } from './screen'
import { buildManifest, manifestJson, MANIFEST, type AnyFiles, type BuildOptions, type Manifest } from './manifest'
import { readZip, writeZip } from './zip'

const TEXT = /\.(md|json|txt|csv)$/i

/** Every allowed file under `dir` (dot folders and symlinks skipped), text decoded as UTF-8. */
export function readFolder(dir: string): AnyFiles {
  const out: AnyFiles = new Map()
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      const a = path.join(abs, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(a, r)
      else if (e.isFile() && (ALLOWED_EXT.test(e.name) || r === MANIFEST)) {
        if (out.size >= MAX_FILES) throw new Error(`more than ${MAX_FILES} files`)
        const st = fs.statSync(a)
        if (st.size > MAX_FILE_BYTES) continue
        const buf = fs.readFileSync(a)
        out.set(r, TEXT.test(r) ? buf.toString('utf8') : new Uint8Array(buf))
      }
    }
  }
  walk(dir, '')
  return out
}

/** A folder or a `.zip` file. */
export function readPassport(p: string): AnyFiles {
  return fs.statSync(p).isDirectory() ? readFolder(p) : readZip(fs.readFileSync(p))
}

/** Writes files under `dir` (creating folders); refuses unsafe paths. */
export function writeFiles(dir: string, files: AnyFiles): void {
  for (const [rel, v] of files) {
    if (!safeRelPath(rel)) throw new Error(`unsafe path ${rel}`)
    const abs = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, v)
  }
}

/** Rebuilds passport.json and the renders of a folder in place. */
export function buildFolder(dir: string, opts: BuildOptions): Manifest {
  const files = readFolder(dir)
  const { manifest, renders } = buildManifest(files, opts)
  fs.rmSync(path.join(dir, 'renders'), { recursive: true, force: true })
  writeFiles(dir, renders)
  fs.writeFileSync(path.join(dir, MANIFEST), manifestJson(manifest))
  return manifest
}

export function packFiles(files: AnyFiles): Uint8Array {
  return writeZip(files)
}

export { readZip, writeZip }
