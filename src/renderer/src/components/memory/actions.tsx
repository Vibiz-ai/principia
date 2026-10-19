/** Memory page actions: one place for mutate/delete/confirm/ask so every view behaves the same. */
import { createContext, useContext, useState } from 'react'
import type { Id } from '@shared/types'
import type { MemoryFact, MemoryFactKind, MemoryMutation, MemoryMutationResult, MemoryTargetKind } from '@shared/memory'
import { MEMORY_FACT_KINDS } from '@shared/memory'
import { confirmNative, hive } from '../../lib/hive'
import { attempt, toast } from '../../state/store'
import { AutoTextarea, Field, Sheet } from '../ui'

export async function mutate(m: MemoryMutation, label = 'Memory'): Promise<MemoryMutationResult | undefined> {
  return attempt(() => hive.memory.mutate(m), label)
}

const NOUN: Record<MemoryTargetKind, [string, string]> = { entity: ['entity', 'entities'], fact: ['memory', 'memories'], relation: ['relation', 'relations'] }

/** Hard delete behind the native destructive confirm (DESIGN §9.4). */
export async function deleteRows(kind: MemoryTargetKind, ids: Id[], what?: string): Promise<boolean> {
  if (!ids.length) return false
  const [one, many] = NOUN[kind]
  const ok = await confirmNative({
    message: ids.length === 1 ? `Delete ${what ? `“${what.length > 60 ? `${what.slice(0, 60)}…` : what}”` : `this ${one}`}?` : `Delete ${ids.length} ${many}?`,
    detail:
      kind === 'entity'
        ? 'Its facts and relations are deleted too, and agents stop seeing them. This can’t be undone. To keep history, invalidate instead.'
        : 'Agents stop seeing it and its text is scrubbed from the history. This can’t be undone. To keep history, invalidate instead.',
    confirmLabel: kind === 'entity' ? 'Delete Entity' : 'Delete',
    destructive: true
  }).catch(() => false)
  if (!ok) return false
  const res = await attempt(() => hive.memory.delete({ kind, ids }), 'Delete')
  return res !== undefined
}

// ---------- ask: small sheets for a reason or a replacement text ----------
export interface AskOptions {
  title: string
  label: string
  placeholder?: string
  initial?: string
  /** Kind picker (Replace with…). */
  kind?: MemoryFactKind
  multiline?: boolean
  confirmLabel: string
  destructive?: boolean
  minLength?: number
  maxLength?: number
  note?: string
}
export interface AskResult {
  text: string
  kind?: MemoryFactKind
}
type Ask = (o: AskOptions) => Promise<AskResult | null>
const AskCtx = createContext<Ask>(async () => null)
export const useAsk = (): Ask => useContext(AskCtx)

export function AskProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [req, setReq] = useState<{ o: AskOptions; resolve: (r: AskResult | null) => void } | null>(null)
  const ask: Ask = (o) => new Promise((resolve) => setReq({ o, resolve }))
  return (
    <AskCtx.Provider value={ask}>
      {children}
      {req && (
        <AskSheet
          key={req.o.title}
          o={req.o}
          done={(r) => {
            req.resolve(r)
            setReq(null)
          }}
        />
      )}
    </AskCtx.Provider>
  )
}

function AskSheet({ o, done }: { o: AskOptions; done: (r: AskResult | null) => void }): React.JSX.Element {
  const [text, setText] = useState(o.initial ?? '')
  const [kind, setKind] = useState<MemoryFactKind | undefined>(o.kind)
  const min = o.minLength ?? 3
  const max = o.maxLength ?? 1000
  const t = text.trim()
  const valid = t.length >= min && t.length <= max
  return (
    <Sheet
      title={o.title}
      onCancel={() => done(null)}
      onPrimary={() => valid && done({ text: t, kind })}
      primaryLabel={o.confirmLabel}
      primaryDisabled={!valid}
      primaryTitle={!valid ? `${min}–${max} characters` : undefined}
      destructive={o.destructive}
      width={480}
    >
      {o.note && <p className="sheet__desc text-secondary">{o.note}</p>}
      {kind && (
        <Field label="Kind">
          <select className="input input--auto" value={kind} onChange={(e) => setKind(e.target.value as MemoryFactKind)}>
            {MEMORY_FACT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={o.label} align="start" hint={`${t.length}/${max}`}>
        {o.multiline ? (
          <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} placeholder={o.placeholder} minRows={3} maxRows={10} maxLength={max} data-autofocus />
        ) : (
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={o.placeholder} maxLength={max} data-autofocus />
        )}
      </Field>
    </Sheet>
  )
}

// ---------- fact-level actions shared by the inspector, table and review queue ----------
export async function invalidateFacts(ask: Ask, ids: Id[], target: 'fact' | 'relation' = 'fact'): Promise<boolean> {
  const r = await ask({
    title: ids.length > 1 ? `Invalidate ${ids.length} ${target === 'fact' ? 'memories' : 'relations'}` : `Invalidate ${target === 'fact' ? 'memory' : 'relation'}`,
    label: 'Reason',
    placeholder: 'Outdated since the auth rewrite',
    confirmLabel: 'Invalidate',
    note: 'Agents stop seeing it. It stays in History, and you can restore it.',
    maxLength: 200
  })
  if (!r) return false
  return !!(await mutate({ op: 'invalidate', target, ids, reason: r.text }, 'Invalidate'))
}

export async function replaceFact(ask: Ask, f: MemoryFact): Promise<boolean> {
  const r = await ask({
    title: 'Replace memory',
    label: 'New text',
    initial: f.text,
    kind: f.kind,
    multiline: true,
    confirmLabel: 'Replace',
    note: 'Writes a new memory that supersedes this one. The old text stays in History.'
  })
  if (!r) return false
  const res = await mutate({ op: 'create', target: 'fact', input: { entityId: f.entityId, text: r.text, kind: r.kind ?? f.kind, scope: f.scope, repoId: f.repoId, pinned: f.pinned, supersedes: [f.id] } }, 'Replace')
  return !!res
}

export async function toGlobal(ids: Id[]): Promise<boolean> {
  const ok = await confirmNative({
    message: ids.length === 1 ? 'Move this memory to global?' : `Move ${ids.length} memories to global?`,
    detail: 'Global memory is shown to agents in every repository and in Chat.',
    confirmLabel: 'Move to Global'
  }).catch(() => false)
  if (!ok) return false
  const res = await mutate({ op: 'toGlobal', ids }, 'Move to global')
  if (res) toast(ids.length === 1 ? 'Moved to global' : `Moved ${res.affected} to global`)
  return !!res
}
