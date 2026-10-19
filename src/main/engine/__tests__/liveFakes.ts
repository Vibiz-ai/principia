/** Test double for main's LiveBridge (src/main/live/bridge.ts): real files under a temp dir, polling tail, atomic answers. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LiveBridge, LiveChannel } from '../../../shared/engine'

/** Main's LiveBridge, in miniature: real files, polling tail, atomic answer writes. */
export function fakeBridge(root: string): LiveBridge & { channels: LiveChannel[] } {
  const channels: LiveChannel[] = []
  return {
    channels,
    open(owner) {
      const id = 'stepId' in owner ? owner.stepId : owner.sessionId
      const dir = join(root, 'live', id)
      mkdirSync(join(dir, 'answers'), { recursive: true, mode: 0o700 })
      const events = join(dir, 'events.jsonl')
      writeFileSync(events, '')
      const cbs: ((l: unknown) => void)[] = []
      let off = 0
      let partial = ''
      const iv = setInterval(() => {
        if (!existsSync(events)) return
        const size = statSync(events).size
        if (size <= off) return
        const chunk = readFileSync(events, 'utf8').slice(off)
        off = size
        const parts = (partial + chunk).split('\n')
        partial = parts.pop() ?? ''
        for (const p of parts) if (p.trim()) for (const cb of cbs) cb(JSON.parse(p))
      }, 10)
      const ch: LiveChannel = {
        dir,
        hookCommand: `'/bin/echo' --events '${events}'`,
        mcpEnv: { HIVE_LIVE_DIR: dir },
        onLine: (cb) => void cbs.push(cb),
        writeAnswer(gateId, payload) {
          const f = join(dir, 'answers', `${gateId}.json`)
          writeFileSync(`${f}.tmp`, JSON.stringify(payload))
          renameSync(`${f}.tmp`, f)
        },
        close() {
          clearInterval(iv)
          rmSync(dir, { recursive: true, force: true })
        }
      }
      channels.push(ch)
      return ch
    }
  }
}

