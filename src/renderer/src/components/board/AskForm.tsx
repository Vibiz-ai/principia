import { mixedListLabel } from '@shared/spend'
import { useMemo, useState } from 'react'
import type { CompanyTask } from '@shared/company'
import { Button } from '../ui'
import { errorMessage, hive } from '../../lib/hive'
import { toast, useStore } from '../../state/store'
import { reposOf } from '../../lib/companyModel'
import '../../styles/board.css'

/**
 * DEPARTMENTS.md §5 board ask: the answer form of a blocked(needs_input) task, in the inspector and inline in Needs
 * you. A question takes text, a confirm Yes / No, a choice one of its options (or a written answer). tasks:answer puts
 * the task back in todo and the same agent resumes with the answer.
 */
/**
 * `mixedCompany`: the form sits in a list that mixes companies (All companies › Needs you). A money answer then names
 * the client ("Refund $24 · Northwind"), so one click never pays out for the wrong company (pm-review B6).
 */
export function AskForm({ task, compact = false, onAnswered, mixedCompany }: { task: CompanyTask; compact?: boolean; onAnswered?: (t: CompanyTask) => void; mixedCompany?: string | null }): React.JSX.Element | null {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const companies = useStore((s) => s.companies)
  const others = useMemo(() => companies.filter((c) => !c.archivedAt).map((c) => c.name), [companies])
  // pm-review C7: a company with no code never sees task codes, in a toast either
  const code = useStore((s) => reposOf(s.repos, task.companyId).length > 0)
  const ask = task.ask
  if (!ask || ask.answer) return null
  const send = async (answer: string): Promise<void> => {
    if (!answer.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const t = await hive.tasks.answer({ id: task.id, answer: answer.trim() })
      setText('')
      toast(code ? `Answered ${task.identifier}` : `Answered: ${task.title}`)
      onAnswered?.(t)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  const options = ask.kind === 'confirm' ? ['Yes', 'No'] : ask.kind === 'choice' ? (ask.options ?? []) : []
  return <form className={`ask-form ${compact ? 'ask-form--compact' : ''}`} onSubmit={(e) => { e.preventDefault(); void send(text) }} onClick={(e) => e.stopPropagation()} aria-label={`Answer ${task.identifier}`}>
    {!compact && <div className="ask-form__label">The agent asks</div>}
    <p className="ask-form__prompt selectable">{ask.prompt}</p>
    {options.length > 0 && <div className="ask-form__options" role="group" aria-label="Answers">{options.map((o) => <Button key={o} size="sm" disabled={busy} onClick={() => void send(o)}>{mixedCompany !== undefined ? mixedListLabel(o, mixedCompany, { prompt: ask.prompt, others }) : o}</Button>)}</div>}
    {ask.kind !== 'confirm' && <div className="ask-form__row">
      <textarea aria-label={`Your answer to ${task.identifier}`} rows={compact ? 1 : 2} maxLength={8000} placeholder={ask.kind === 'choice' ? 'Or write another answer…' : 'Your answer…'} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(text) } }} />
      <Button type="submit" size="sm" variant="primary" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Answer'}</Button>
    </div>}
    {error && <div className="ask-form__error" role="alert">{error}</div>}
  </form>
}
