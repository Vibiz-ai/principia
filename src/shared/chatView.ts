/**
 * CHAT-UI.md §4.2: how the chat items are drawn. Subagent work nests under its Task card, consecutive read-only tools
 * fold into one summary row (errors never hide in a group), the plan (TodoWrite) shows once in full, and the tool
 * behind a question or plan card is not drawn twice. Pure.
 */
import type { ChatItem, ChatToolItem } from './chat'
import { isReadOnlyTool, isSubagentTool, SPECIAL_TOOLS } from './toolVerbs'

export type ChatBlock =
  | { t: 'item'; item: Exclude<ChatItem, ChatToolItem> }
  | { t: 'tool'; item: ChatToolItem; children: ChatBlock[] }
  | { t: 'group'; id: string; tools: ChatToolItem[] }
  | { t: 'todo'; item: ChatToolItem; latest: boolean }

export function buildBlocks(items: readonly ChatItem[]): ChatBlock[] {
  const toolIds = new Set(items.filter((i): i is ChatToolItem => i.kind === 'tool').map((i) => i.toolUseId))
  const hidden = new Set(items.flatMap((i) => ((i.kind === 'question' || i.kind === 'plan') && i.toolUseId ? [i.toolUseId] : [])))
  const lastTodo = [...items].reverse().find((i) => i.kind === 'tool' && i.name === 'TodoWrite')?.id ?? null
  const byParent = new Map<string, ChatItem[]>()
  const top: ChatItem[] = []
  for (const it of items) {
    if (it.parent && toolIds.has(it.parent)) {
      const l = byParent.get(it.parent) ?? []
      l.push(it)
      byParent.set(it.parent, l)
    } else top.push(it)
  }
  const fold = (list: ChatItem[]): ChatBlock[] => {
    const out: ChatBlock[] = []
    let group: ChatToolItem[] = []
    const flush = (): void => {
      if (group.length) out.push({ t: 'group', id: `g:${group[0]!.id}`, tools: group })
      group = []
    }
    for (const it of list) {
      if (it.kind === 'tool') {
        if (hidden.has(it.toolUseId)) continue
        if (it.name === 'TodoWrite') {
          flush()
          out.push({ t: 'todo', item: it, latest: it.id === lastTodo })
          continue
        }
        if (SPECIAL_TOOLS.has(it.name) && (it.status === 'pending' || it.status === 'running')) continue
        if (isReadOnlyTool(it.name) && it.status !== 'error' && !isSubagentTool(it.name)) {
          group.push(it)
          continue
        }
        flush()
        out.push({ t: 'tool', item: it, children: isSubagentTool(it.name) ? fold(byParent.get(it.toolUseId) ?? []) : [] })
        continue
      }
      // thinking between two reads does not break the summary row
      if (it.kind === 'thinking' && group.length) continue
      flush()
      out.push({ t: 'item', item: it })
    }
    flush()
    return out
  }
  return fold(top)
}

/** "1m 12s", "6s", "0.4s" */
export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}
