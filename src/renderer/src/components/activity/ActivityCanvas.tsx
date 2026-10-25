/**
 * USAGE.md §4: the portfolio Activity canvas (Canvas › Activity in All companies). Every Claude session on this Mac:
 * Principia's own live agents and background subagents, plus Claude Code sessions outside Principia (read-only, from
 * their transcripts), one frame per company, unmatched sessions in Elsewhere. Click a card to open it.
 * The outside half is leased from main while this is mounted (activity:open, renewed every 45 s; activity:close on
 * unmount), so nothing watches ~/.claude when the layer is closed.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import type { ClaudeHistorySession } from '@shared/authoring'
import type { ActivitySnapshot } from '@shared/usage'
import type { AgentIndex } from '../../lib/live'
import { CARD_H, CARD_W, ELSEWHERE, cardPos, cardTimer, frameMeta, layoutActivity, outsideItems, principiaItems, tokenLabel, type ActivityItem, type ActivityOpen } from '../../lib/usage'
import { errorMessage, hive, useHiveEvent } from '../../lib/hive'
import { companyLabel } from '../../lib/company'
import { useAgentCompany } from '../CompanyChip'
import { CompanyAvatar } from '../../shell/CompanyRail'
import { EmptyState, ErrorState, Loading, useTick } from '../ui'
import { Icon } from '../Icon'
import { TranscriptSheet } from '../history/TranscriptSheet'
import { focusSession, navigate, useStore } from '../../state/store'
import '../../styles/usage.css'
import claudeMark from '../../assets/providers/claude.svg'
import openaiMark from '../../assets/providers/openai.svg'
import geminiMark from '../../assets/providers/gemini.svg'

type FrameData = { label: string; companyId: string | null; count: number; working: number; width: number; height: number }
type CardData = { item: ActivityItem }
type AFrame = Node<FrameData, 'aframe'>
type ACard = Node<CardData, 'acard'>

const RENEW_MS = 45_000

const FrameView = memo(function FrameView({ data }: NodeProps<AFrame>) {
  const companies = useStore((s) => s.companies)
  const c = data.companyId ? companies.find((x) => x.id === data.companyId) : undefined
  return (
    <div className="aframe" style={{ width: data.width, height: data.height }}>
      <div className="aframe__head">
        {data.companyId ? (
          <CompanyAvatar company={{ id: c?.id, name: data.label, color: c?.color ?? 'var(--series-other)' }} size={20} className="aframe__coin" />
        ) : (
          <span className="aframe__coin aframe__coin--elsewhere" aria-hidden>
            <Icon name="folder" size={12} />
          </span>
        )}
        <span className="aframe__label">{data.label}</span>
        <span className="aframe__meta">
          {frameMeta(data.count, data.working)}
        </span>
      </div>
    </div>
  )
})

const MARK: Partial<Record<string, string>> = { claude: claudeMark, codex: openaiMark, gemini: geminiMark }
function modelLabel(model: string | null): string | null {
  if (!model) return null
  if (model.startsWith('claude-')) return model.slice(7).replace(/\[.*\]$/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1').replace(/^(sonnet|opus|haiku|fable)/, (w) => w[0]!.toUpperCase() + w.slice(1))
  return model
}

const CardView = memo(function CardView({ data, selected }: NodeProps<ACard>) {
  const it = data.item
  useTick(it.state === 'idle' ? 30_000 : 1000)
  const mark = MARK[it.provider]
  const sub = [modelLabel(it.model), it.source === 'outside' ? 'Terminal' : it.background ? 'Background · Principia' : 'Principia'].filter(Boolean).join(' · ')
  const timer = cardTimer(it)
  const status = it.state === 'needs' ? 'Needs you' : it.state === 'working' ? 'Working' : 'Idle'
  return (
    <div className={`acard acard--${it.state} ${selected ? 'is-selected' : ''}`} style={{ width: CARD_W, height: CARD_H }} title={`${it.title}${it.doing ? `\n${it.doing}` : ''}\nClick to open`}>
      <div className="acard__top">
        <span className="acard__mark">{mark ? <img src={mark} alt="" width={16} height={16} /> : <Icon name="agents" size={16} />}</span>
        <div className="acard__id">
          <div className="acard__title">{it.title}</div>
          <div className="acard__sub">{sub}</div>
        </div>
        <span className={`acard__state acard__state--${it.state}`}>
          <span className="acard__glyph" aria-hidden />
          {status}
        </span>
      </div>
      <p className={`acard__doing ${it.doing ? '' : 'acard__doing--empty'}`}>{it.doing ?? (it.state === 'working' ? 'Thinking…' : 'Waiting for the next prompt')}</p>
      <div className="acard__foot">
        {timer && <span title={it.state === 'working' ? 'Time on the current turn' : 'Since the last activity'}>{timer}</span>}
        {it.tokens != null && (
          <span title={it.tokensPartial ? 'Tokens from the latest part of a very long transcript' : 'Tokens (input incl. cache, output)'}>
            {timer ? '· ' : ''}
            {it.tokensPartial ? '≥' : ''}
            {tokenLabel(it.tokens)} tok
          </span>
        )}
      </div>
    </div>
  )
})

const nodeTypes = { aframe: FrameView, acard: CardView }

function Graph({ nodes, onOpen, fitKey }: { nodes: (AFrame | ACard)[]; onOpen: (o: ActivityOpen) => void; fitKey: string }): React.JSX.Element {
  const rf = useReactFlow()
  const moved = useRef(false)
  useEffect(() => {
    if (moved.current) return
    const t = setTimeout(() => void rf.fitView({ padding: 0.12, maxZoom: 1, minZoom: 0.4, duration: 150 }), 40)
    return () => clearTimeout(t)
  }, [fitKey, rf])
  useEffect(() => {
    const onZoom = (e: Event): void => {
      const d = (e as CustomEvent<'in' | 'out' | 'reset'>).detail
      if (d === 'in') void rf.zoomIn({ duration: 120 })
      if (d === 'out') void rf.zoomOut({ duration: 120 })
      if (d === 'reset') {
        moved.current = false
        void rf.fitView({ padding: 0.12, maxZoom: 1, duration: 200 })
      }
    }
    window.addEventListener('hive:zoom', onZoom)
    return () => window.removeEventListener('hive:zoom', onZoom)
  }, [rf])
  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      panOnScroll
      panOnDrag
      zoomOnPinch
      zoomOnScroll={false}
      zoomActivationKeyCode="Meta"
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      onMoveStart={(e) => {
        if (e) moved.current = true
      }}
      onNodeClick={(_, n) => {
        if (n.type !== 'acard') return
        const o = (n.data as CardData).item.open
        if (o) onOpen(o)
      }}
    />
  )
}

export function ActivityCanvas({ idx }: { idx: AgentIndex }): React.JSX.Element {
  const [snap, setSnap] = useState<ActivitySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ClaudeHistorySession | null>(null)
  const companies = useStore((s) => s.companies)
  const companyOf = useAgentCompany()
  const tick = useTick(30_000)

  // lease the outside watcher while mounted
  useEffect(() => {
    let alive = true
    const open = (): void => {
      hive.activity.open().then(
        (s) => {
          if (!alive) return
          setSnap(s)
          setError(null)
        },
        (e) => alive && setError(errorMessage(e))
      )
    }
    open()
    const t = setInterval(open, RENEW_MS)
    return () => {
      alive = false
      clearInterval(t)
      void hive.activity.close().catch(() => undefined)
    }
  }, [])
  useHiveEvent('activity:changed', (s) => setSnap(s))

  const items = useMemo(() => {
    const now = Date.now()
    const agents = [...idx.byId.values()]
    const mine = principiaItems(agents, (a) => companyOf(a), now)
    // a Principia-run Claude session also writes a transcript: show it once, as the Principia agent
    const external = new Set(agents.map((a) => a.externalId).filter(Boolean))
    const outside = outsideItems((snap?.sessions ?? []).filter((s) => !external.has(s.id)))
    return [...mine, ...outside]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, snap, companyOf, tick])

  const frames = useMemo(() => layoutActivity(items, companies.map((c) => c.id)), [items, companies])
  const nodes = useMemo(() => {
    const out: (AFrame | ACard)[] = []
    for (const f of frames) {
      const c = f.companyId ? companies.find((x) => x.id === f.companyId) : undefined
      const label = f.key === ELSEWHERE ? 'Elsewhere' : c ? companyLabel(c, true) : 'Archived company'
      out.push({
        id: `f:${f.key}`,
        type: 'aframe',
        position: { x: f.x, y: f.y },
        data: { label, companyId: f.companyId, count: f.items.length, working: f.items.filter((i) => i.state !== 'idle').length, width: f.width, height: f.height },
        width: f.width,
        height: f.height,
        measured: { width: f.width, height: f.height },
        selectable: false,
        zIndex: 0
      })
      f.items.forEach((it, i) => {
        const p = cardPos(i)
        out.push({ id: it.key, type: 'acard', position: { x: f.x + p.x, y: f.y + p.y }, data: { item: it }, width: CARD_W, height: CARD_H, measured: { width: CARD_W, height: CARD_H }, zIndex: 1 })
      })
    }
    return out
  }, [frames, companies])
  const fitKey = frames.map((f) => `${f.key}:${f.items.length}`).join('|')

  const onOpen = (o: ActivityOpen): void => {
    if (o.kind === 'run') void navigate({ name: 'run', runId: o.runId, stepId: o.stepId ?? undefined })
    else if (o.kind === 'session') focusSession(o.sessionId)
    else {
      const s = snap?.sessions.find((x) => x.id === o.sessionId)
      if (!s) return
      setPreview({ id: s.id, path: s.path, cwd: s.cwd, repoId: null, gitBranch: s.gitBranch, title: s.title, titleSource: 'prompt', startedAt: s.startedAt, endedAt: s.lastAt, turns: null, subagents: 0, model: s.model, inHive: false })
    }
  }

  return (
    <div className="activity">
      {error && !snap ? (
        <ErrorState error={error} />
      ) : !snap ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState icon="canvas" text={snap.disabled ? 'No Claude sessions from Principia right now. Claude history is off in Settings, so sessions outside Principia are not shown.' : 'No Claude sessions running on this Mac right now.'} />
      ) : (
        <div className="graph">
          <ReactFlowProvider>
            <Graph nodes={nodes} onOpen={onOpen} fitKey={fitKey} />
          </ReactFlowProvider>
        </div>
      )}
      {snap && items.length > 0 && <div className="activity__note text-tertiary">Read-only. Sessions active in the last {snap.windowMin} minutes. Principia never changes files in ~/.claude.</div>}
      {preview && <TranscriptSheet session={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}
