/**
 * Cloud runs (docs/CLOUD.md §9, §13.1): "While this Mac slept", the last 8 with status tesserae. A run opens the run
 * sheet: steps, the redacted log tail (refreshed while it runs), the Forum posts it made, and Cancel.
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { CloudRunDetail } from '@shared/cloud'
import { Button, Sheet } from '../ui'
import { ADAPTER_LABEL, TRIGGER_LABEL, recentRuns, runTessera, runTimeLabel, stepTessera } from '../../lib/cloud'
import { confirmNative, errorMessage, hive } from '../../lib/hive'
import { toast, useStore } from '../../state/store'
import { useCloud } from '../../state/cloud'
import { Tess } from './bits'

export function RunsCard({ onOpen }: { onOpen: (id: string) => void }): ReactElement {
  const runs = useCloud((s) => s.runs)
  const companies = useStore((s) => s.companies)
  const shown = recentRuns(runs)
  return (
    <section className="cl-card">
      <div className="cl-ctitle">
        Cloud runs<span className="cl-hint">while this Mac slept</span>
      </div>
      {shown.length === 0 && <p className="cl-empty">No cloud runs yet. Run once now from a company to see one here.</p>}
      {shown.map((r) => (
        <button key={r.id} type="button" className="cl-run" onClick={() => onOpen(r.id)}>
          <Tess kind={runTessera(r.status)} />
          <b>{r.title}</b>
          <span>
            {companies.find((c) => c.id === r.companyId)?.name ?? 'Company'} · {TRIGGER_LABEL[r.trigger] ?? r.trigger}
            {r.adapters.length ? ` · ${r.adapters.map((a) => ADAPTER_LABEL[a] ?? a).join(', ')}` : ''}
          </span>
          <span className="cl-run__tm">{runTimeLabel(r)}</span>
        </button>
      ))}
    </section>
  )
}

const ACTIVE = new Set(['queued', 'running'])
/** shell steps read "Shell"; agent steps the harness that ran them (Claude, Codex, Gemini) */
const stepAgent = (adapter: string): string => (adapter === 'shell' ? 'Shell' : (ADAPTER_LABEL[adapter as keyof typeof ADAPTER_LABEL] ?? adapter))
/** while it runs the log may be empty; a finished run with no lines says so plainly */
export const emptyLogText = (status: string | undefined): string => (status && ACTIVE.has(status) ? 'No log yet.' : 'This run wrote no output.')

/**
 * "Run once now", inline (CLOUD.md §3 step 6): the run's status, its steps and the first lines of its output, followed
 * until it ends. The moment the cloud stops being a promise.
 */
export function RunResult({ id }: { id: string }): ReactElement {
  const [run, setRun] = useState<CloudRunDetail | null>(null)
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = async (): Promise<void> => {
      try {
        const [d, log] = await Promise.all([hive.cloud.run({ id }), hive.cloud.runLog({ id, tail: 200 })])
        if (!alive) return
        setRun(d)
        setLines(log.lines)
        if (ACTIVE.has(d.status)) timer = setTimeout(() => void load(), 1500)
      } catch {
        if (alive) timer = setTimeout(() => void load(), 3000)
      }
    }
    void load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [id])
  if (!run) return <div className="cl-result"><Tess kind="running" /> Starting in the cloud…</div>
  const head = lines.filter((l) => l.trim()).slice(0, 6)
  return (
    <div className="cl-result" role="status">
      <div className="cl-rhead">
        <Tess kind={runTessera(run.status)} />
        <b>{run.status === 'passed' ? 'Passed in the cloud' : run.status === 'needs_input' ? 'Needs you' : run.status === 'failed' ? 'Failed' : run.status === 'canceled' ? 'Canceled' : 'Running in the cloud…'}</b>
        <span>{run.title}</span>
      </div>
      {run.summary && <p className="cl-dim selectable">{run.summary}</p>}
      {run.steps.map((st) => (
        <div key={st.id} className="cl-step">
          <Tess kind={stepTessera(st.status)} />
          {st.title}
          <span>{stepAgent(st.adapter)}</span>
        </div>
      ))}
      <pre className="cl-pre cl-log selectable" aria-label="First lines of output">{head.length ? head.join('\n') : emptyLogText(run.status)}</pre>
    </div>
  )
}

export function RunSheet({ id, onClose }: { id: string; onClose: () => void }): ReactElement {
  const [run, setRun] = useState<CloudRunDetail | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const live = useCloud((s) => s.runs.find((r) => r.id === id)?.status)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = async (): Promise<void> => {
      try {
        const [d, log] = await Promise.all([hive.cloud.run({ id }), hive.cloud.runLog({ id, tail: 200 })])
        if (!alive) return
        setRun(d)
        setLines(log.lines)
        if (ACTIVE.has(d.status)) timer = setTimeout(() => void load(), 2000)
      } catch (e) {
        if (alive) setError(errorMessage(e))
      }
    }
    void load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [id, live])
  const cancel = async (): Promise<void> => {
    if (!(await confirmNative({ message: 'Cancel this cloud run?', confirmLabel: 'Cancel Run', destructive: true }))) return
    try {
      await hive.cloud.runCancel({ id })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <Sheet title={run?.title ?? 'Cloud run'} onCancel={onClose} width={620} footerLeft={run && ACTIVE.has(run.status) ? <Button variant="ghost" onClick={() => void cancel()}>Cancel run</Button> : undefined}>
      {error && <p className="cl-error selectable">{error}</p>}
      {run && (
        <div className="cl-runsheet">
          <div className="cl-rhead">
            <Tess kind={runTessera(run.status)} />
            <b>{run.status === 'needs_input' ? 'Needs you' : run.status}</b>
            <span>
              {TRIGGER_LABEL[run.trigger] ?? run.trigger} · {runTimeLabel(run)}
            </span>
          </div>
          {run.summary && <p className="cl-dim selectable">{run.summary}</p>}
          <div className="cl-steps">
            {run.steps.length === 0 && <div className="cl-step cl-dim">No steps yet.</div>}
            {run.steps.map((s) => (
              <div key={s.id} className={`cl-step ${s.status === 'running' ? 'is-on' : ''}`}>
                <Tess kind={stepTessera(s.status)} />
                {s.title}
                <span>
                  {stepAgent(s.adapter)} · {s.status}
                  {s.usage ? ` · ${s.usage.inputTokens + s.usage.outputTokens} tok${s.usage.usd !== null ? ` · $${s.usage.usd.toFixed(2)}` : ''}` : ''}
                </span>
              </div>
            ))}
          </div>
          <pre className="cl-pre cl-log selectable" aria-label="Log tail">
            {lines.length ? lines.join('\n') : emptyLogText(run.status)}
          </pre>
          {(run.forumPosts?.length ?? 0) > 0 && (
            <div className="cl-posts">
              <div className="cl-group__t">Forum posts</div>
              {run.forumPosts!.map((m) => (
                <div key={m.id} className="cl-post">
                  <b>{m.author.name}</b>
                  {m.author.role && <span className="cl-dim"> · {m.author.role}</span>}
                  <p className="selectable">{m.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}
