/**
 * Five doors step 5 (design §6.8, pm-review E12): the real Claude check, in plain words, on the last steps of setup
 * (never "Agents found: Claude · Codex"). Signed in on a plan: nothing extra to pay. Signed out or not installed:
 * "Sign in to Claude, or get a plan", what a plan costs, and Check again.
 */
import { claudeCheckLine } from './model'
import { Button } from '../../components/ui'
import { hive } from '../../lib/hive'
import { useClaudeAuth } from '../../state/claudeAuth'

export function ClaudeCheck(): React.JSX.Element {
  const { auth, recheck, checking } = useClaudeAuth({ fresh: true })
  const line = claudeCheckLine(auth)
  return (
    <div className={`ob-claude ${line.ok === false ? 'is-out' : ''}`} role="status">
      <span className="ob-claude__mark" aria-hidden>
        {line.ok ? '✓' : line.ok === false ? '○' : '·'}
      </span>
      <span className="ob-claude__text">{line.text}</span>
      {line.ok === false && (
        <span className="ob-claude__acts">
          <Button size="sm" onClick={() => void recheck()} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void hive.app.openExternal({ url: 'https://claude.com/pricing' }).catch(() => undefined)}>
            See plans ↗
          </Button>
        </span>
      )}
    </div>
  )
}
