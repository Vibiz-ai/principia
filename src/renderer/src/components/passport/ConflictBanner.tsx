/**
 * The open note changed underneath a dirty editor (PASSPORT.md §10): an agent run or another app (Obsidian) wrote
 * it. The user's text is kept; "Merge" opens the three-way merge, "Discard mine" takes the file as it is now.
 */
import { Button } from '../ui'

export function ConflictBanner({ by, onMerge, onDiscard, saving }: { by: string; onMerge: () => void; onDiscard: () => void; saving?: boolean }): React.JSX.Element {
  return (
    <div className="pconflict" role="status">
      <span className="pconflict__dot" aria-hidden />
      <span className="pconflict__text">
        Changed by {by} while you were editing. Your text is kept until you merge.
      </span>
      <Button size="sm" variant="primary" onClick={onMerge} disabled={saving}>
        Merge
      </Button>
      <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>
        Discard mine
      </Button>
    </div>
  )
}
