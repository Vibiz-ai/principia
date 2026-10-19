import fs from 'node:fs'
import path from 'node:path'

/** Pure: true when `child` is `parent` or below it (both absolute, already normalized/realpath'd). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

/** realpath that tolerates a missing leaf (falls back to resolving the parent). */
export function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p))
    } catch {
      return path.resolve(p)
    }
  }
}

export function isInsideAny(p: string, roots: string[]): boolean {
  const real = safeRealpath(p)
  return roots.some((r) => isInside(real, safeRealpath(r)))
}
