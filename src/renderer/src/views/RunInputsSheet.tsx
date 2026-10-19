import { useEffect, useState } from 'react'
import type { Workflow } from '@shared/types'
import { AutoTextarea, Field, Loading, Sheet } from '../components/ui'
import { errorMessage, hive } from '../lib/hive'
import { initialInputValue, runInputProblems } from '../lib/workflow'
import { attempt, lastInputs, navigate, rememberInputs, setState, useStore } from '../state/store'

/** "Run…" sheet: fills workflow inputs (repo inputs = repo picker, last-used values pre-filled). */
export function RunInputsSheet(): React.JSX.Element | null {
  const req = useStore((s) => s.runInputs)
  if (!req) return null
  return <Inner key={req.workflowId} workflowId={req.workflowId} />
}

function Inner({ workflowId }: { workflowId: string }): React.JSX.Element {
  const repos = useStore((s) => s.repos)
  const lastRepoId = useStore((s) => s.settings?.lastRepoId ?? null)
  const [wf, setWf] = useState<Workflow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const close = (): void => setState({ runInputs: null })

  useEffect(() => {
    hive.workflows.get({ id: workflowId }).then(
      (w) => {
        setWf(w)
        const prev = lastInputs(workflowId)
        const v: Record<string, string> = {}
        for (const i of w.inputs) v[i.name] = initialInputValue(i, prev[i.name], lastRepoId ?? repos[0]?.id ?? '')
        setValues(v)
        if (w.inputs.length === 0) void start(w, v)
      },
      (e) => setError(errorMessage(e))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId])

  const start = async (w: Workflow, inputs: Record<string, string>): Promise<void> => {
    setBusy(true)
    const run = await attempt(() => hive.runs.start({ target: { kind: 'workflow', workflowId: w.id, inputs } }), 'Run')
    setBusy(false)
    if (!run) return
    rememberInputs(w.id, inputs)
    close()
    void navigate({ name: 'canvas', focusRunId: run.id })
  }

  const missing = wf?.inputs.filter((i) => i.type !== 'boolean' && !values[i.name]?.trim()) ?? []
  // typed checkboxes run only with exactly true/false: an unknown value (a bad default) is refused, never guessed
  const invalid = wf ? runInputProblems(wf.inputs, values) : []
  return (
    <Sheet
      title={wf ? `Run ${wf.name}` : 'Run workflow'}
      onCancel={close}
      onPrimary={wf ? () => void start(wf, values) : undefined}
      primaryLabel={busy ? 'Starting…' : 'Run'}
      primaryDisabled={!wf || busy || missing.length > 0 || invalid.length > 0}
      primaryTitle={invalid.length ? invalid.join('; ') : missing.length ? `Fill in ${missing.map((m) => m.label || m.name).join(', ')}` : undefined}
    >
      {error ? (
        <div className="text-failed selectable">{error}</div>
      ) : !wf ? (
        <Loading />
      ) : (
        <>
          {wf.description && <p className="text-secondary sheet__desc">{wf.description}</p>}
          {wf.inputs.map((i) => (
            <Field key={i.name} label={i.label || i.name} align={i.type === 'multiline' ? 'start' : 'center'}>
              {i.type === 'boolean' ? (
                <label className="run-check">
                  <input
                    type="checkbox"
                    aria-label={i.label || i.name}
                    data-input={i.name}
                    checked={values[i.name] === 'true'}
                    onChange={(e) => setValues({ ...values, [i.name]: e.target.checked ? 'true' : 'false' })}
                  />
                  <span className="text-secondary mono">{values[i.name] === 'true' || values[i.name] === 'false' ? values[i.name] : `“${values[i.name]}” is not true/false`}</span>
                </label>
              ) : i.type === 'repo' ? (
                <select className="input" value={values[i.name] ?? ''} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}>
                  <option value="" disabled>
                    Choose a repository…
                  </option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id} disabled={!r.exists}>
                      {r.name}
                    </option>
                  ))}
                </select>
              ) : i.type === 'multiline' ? (
                <AutoTextarea className="mono" minRows={4} value={values[i.name] ?? ''} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })} />
              ) : (
                <input className="input" value={values[i.name] ?? ''} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })} />
              )}
            </Field>
          ))}
          {invalid.length > 0 && (
            <div className="text-failed selectable" role="alert">
              {invalid.join(' · ')}
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}
