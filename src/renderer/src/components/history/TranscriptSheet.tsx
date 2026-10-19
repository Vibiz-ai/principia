/** Read-only preview of a Claude Code transcript (AUTHORING.md §8.3), with "Resume in Hive". Never writes the file. */
import { useEffect, useState } from 'react'
import type { ClaudeHistorySession, ClaudeTranscript } from '@shared/authoring'
import { Button, ErrorState, Loading, Sheet } from '../ui'
import { errorMessage, hive } from '../../lib/hive'
import { historyMeta, historyPlace } from '../../lib/authoring'
import { absolute } from '../../lib/time'
import { resumeHistory } from '../../state/history'
import { attempt, toast, useStore } from '../../state/store'

const ROLE: Record<ClaudeTranscript['entries'][number]['role'], string> = { user: 'You', assistant: 'Claude', tool: 'Tool', system: '' }

export function TranscriptSheet({ session, onClose }: { session: ClaudeHistorySession; onClose: () => void }): React.JSX.Element {
  const repos = useStore((s) => s.repos)
  const [t, setT] = useState<ClaudeTranscript | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = (): void => {
    setError(null)
    hive.history.get({ id: session.id }).then(setT, (e) => setError(errorMessage(e)))
  }
  useEffect(load, [session.id])
  const resume = async (): Promise<void> => {
    setBusy(true)
    const s = await resumeHistory(session.id)
    setBusy(false)
    if (s) onClose()
  }
  const meta = [historyPlace(session, repos), session.gitBranch, session.endedAt ? absolute(session.endedAt) : null, historyMeta(session), session.model].filter(Boolean).join(' · ')
  return (
    <Sheet
      title={session.title || 'Claude session'}
      onCancel={onClose}
      onPrimary={() => void resume()}
      primaryLabel={busy ? 'Opening…' : 'Resume in Hive'}
      primaryDisabled={busy || !session.cwd}
      primaryTitle={session.cwd ? `claude --resume ${session.id} in ${session.cwd}` : 'The folder of this conversation is unknown'}
      width={720}
      footerLeft={
        <Button
          size="sm"
          variant="ghost"
          icon="copy"
          onClick={() => void attempt(() => hive.clipboard.writeText({ text: `claude --resume ${session.id}` })).then(() => toast('Command copied'))}
        >
          Copy resume command
        </Button>
      }
    >
      <div className="transcript">
        <div className="transcript__meta text-tertiary selectable">{meta}</div>
        {error ? (
          <ErrorState error={error} onRetry={load} />
        ) : !t ? (
          <Loading />
        ) : (
          <>
            {t.truncated && <div className="transcript__note text-tertiary">Showing the latest {t.entries.length} entries.</div>}
            <div className="transcript__list">
              {t.entries.length === 0 && <div className="text-tertiary">No messages.</div>}
              {t.entries.map((e, i) => (
                <div key={i} className={`tline tline--${e.role}`}>
                  {ROLE[e.role] && <span className="tline__role">{ROLE[e.role]}</span>}
                  <span className="tline__text selectable">{e.text}</span>
                </div>
              ))}
            </div>
            {t.subagents.length > 0 && (
              <div className="transcript__subs">
                <div className="run__label">Subagents</div>
                {t.subagents.map((s) => (
                  <div key={s.file} className="transcript__sub">
                    <span>{s.agentType ?? 'agent'}</span>
                    {s.description && <span className="text-secondary"> · {s.description}</span>}
                    <span className="text-tertiary"> · {s.messages} messages</span>
                  </div>
                ))}
              </div>
            )}
            <div className="transcript__foot text-tertiary">Read-only. Hive never changes files in ~/.claude.</div>
          </>
        )}
      </div>
    </Sheet>
  )
}
