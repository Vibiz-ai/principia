import type { Id } from './types'
import { ID_PREFIX } from './types'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** `<prefix>_<10 chars>`; uses Web Crypto (available in Node >= 19, Electron main, renderer). */
export function newId(kind: keyof typeof ID_PREFIX): Id {
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += ALPHABET[b % 36]
  return `${ID_PREFIX[kind]}_${s}`
}

/** Owner of an artifacts sub-directory name: "r_xxx" -> run, "s_xxx" -> session. */
export function ownerOfArtifactDir(dir: string): { runId: Id | null; sessionId: Id | null } {
  if (dir.startsWith(`${ID_PREFIX.run}_`)) return { runId: dir, sessionId: null }
  if (dir.startsWith(`${ID_PREFIX.session}_`)) return { runId: null, sessionId: dir }
  return { runId: null, sessionId: null }
}
