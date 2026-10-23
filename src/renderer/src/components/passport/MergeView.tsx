/**
 * Three-way merge for a note save that lost the compare-and-swap (PASSPORT.md §6.4, §10): base = what the editor
 * started from, mine = the editor, theirs = the file now. One-sided changes merge by themselves (shared `merge3`);
 * each real conflict picks mine, theirs or both, or the result is edited by hand. Nothing is saved until "Save merge".
 */
import { useMemo, useState } from 'react'
import { merge3 } from '@shared/vault/diff3'
import { Button, Segmented } from '../ui'
import { joinRegions, type MergePick as Pick } from '../../lib/passport'

export function MergeView({
  base,
  ours,
  theirs,
  theirsLabel,
  onSave,
  onCancel,
  saving
}: {
  base: string
  ours: string
  theirs: string
  /** who wrote theirs ("claude run#183", "Obsidian or another app") */
  theirsLabel: string
  onSave: (merged: string) => void
  onCancel: () => void
  saving?: boolean
}): React.JSX.Element {
  const result = useMemo(() => merge3(base, ours, theirs, { ours: 'yours', theirs: theirsLabel }), [base, ours, theirs, theirsLabel])
  const conflicts = result.regions.map((r, i) => (!r.stable && r.conflict ? i : -1)).filter((i) => i >= 0)
  const [picks, setPicks] = useState<Record<number, Pick>>({})
  const [manual, setManual] = useState<string | null>(null)
  const merged = useMemo(() => joinRegions(result.regions, picks), [result, picks])
  const unresolved = conflicts.filter((i) => !picks[i]).length

  return (
    <div className="pmerge">
      <div className="pmerge__head">
        <div className="pmerge__title">
          Merge your edit with {theirsLabel}
          <span className="text-tertiary">
            {' '}
            · {conflicts.length === 0 ? 'no conflicting lines' : `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}${unresolved ? `, ${unresolved} left` : ''}`}
          </span>
        </div>
        <span className="flex1" />
        <Button size="sm" variant="ghost" onClick={() => setManual(manual === null ? merged : null)}>
          {manual === null ? 'Edit result' : 'Back to choices'}
        </Button>
        <Button size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={saving || (manual === null && unresolved > 0)} onClick={() => onSave(manual ?? merged)} title={unresolved && manual === null ? 'Pick a side for every conflict first' : undefined}>
          Save merge
        </Button>
      </div>
      {manual !== null ? (
        <textarea className="pmerge__manual mono" value={manual} spellCheck={false} onChange={(e) => setManual(e.target.value)} />
      ) : (
        <div className="pmerge__body mono">
          {result.regions.map((r, i) =>
            r.stable ? (
              <Stable key={i} lines={r.lines} first={i === 0} last={i === result.regions.length - 1} />
            ) : !r.conflict ? (
              <div key={i} className="pmerge__auto" title="Changed on one side only: merged automatically">
                {r.merged.map((l, j) => (
                  <div key={j} className="pmerge__line">
                    {strip(l) || ' '}
                  </div>
                ))}
              </div>
            ) : (
              <div key={i} className={`pmerge__conflict ${picks[i] ? 'is-picked' : ''}`}>
                <div className="pmerge__choose">
                  <Segmented<Pick>
                    size="sm"
                    items={[
                      { value: 'ours', label: 'Keep mine' },
                      { value: 'theirs', label: 'Keep theirs' },
                      { value: 'both', label: 'Keep both' }
                    ]}
                    value={picks[i] ?? ('' as Pick)}
                    onChange={(v) => setPicks({ ...picks, [i]: v })}
                  />
                </div>
                <Side label="Mine" lines={r.ours} on={picks[i] === 'ours' || picks[i] === 'both'} />
                <Side label={theirsLabel} lines={r.theirs} on={picks[i] === 'theirs' || picks[i] === 'both'} />
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

const strip = (l: string): string => l.replace(/\r?\n$/, '')

function Stable({ lines, first, last }: { lines: string[]; first: boolean; last: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const keep = 2
  if (open || lines.length <= keep * 2 + 1) {
    return (
      <div className="pmerge__stable">
        {lines.map((l, j) => (
          <div key={j} className="pmerge__line">
            {strip(l) || ' '}
          </div>
        ))}
      </div>
    )
  }
  const head = first ? [] : lines.slice(0, keep)
  const tail = last ? [] : lines.slice(lines.length - keep)
  return (
    <div className="pmerge__stable">
      {head.map((l, j) => (
        <div key={`h${j}`} className="pmerge__line">
          {strip(l) || ' '}
        </div>
      ))}
      <button type="button" className="pmerge__fold" onClick={() => setOpen(true)}>
        {lines.length - head.length - tail.length} unchanged lines
      </button>
      {tail.map((l, j) => (
        <div key={`t${j}`} className="pmerge__line">
          {strip(l) || ' '}
        </div>
      ))}
    </div>
  )
}

function Side({ label, lines, on }: { label: string; lines: string[]; on: boolean }): React.JSX.Element {
  return (
    <div className={`pmerge__side ${on ? 'is-on' : ''}`}>
      <div className="pmerge__side-label">{label}</div>
      {lines.length === 0 ? (
        <div className="pmerge__line text-tertiary">(removed)</div>
      ) : (
        lines.map((l, j) => (
          <div key={j} className="pmerge__line">
            {strip(l) || ' '}
          </div>
        ))
      )}
    </div>
  )
}
