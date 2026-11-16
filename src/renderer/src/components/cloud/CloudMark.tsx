/**
 * docs/CLOUD-CHATS.md: the mark of a chat whose Claude runs on the person's cloud machine (chat rows, the sidebar, the
 * chat's header). It keeps going with this Mac closed.
 */
import type { Session } from '@shared/types'
import { Icon } from '../Icon'

export const isCloudChat = (s: Pick<Session, 'location'> | null | undefined): boolean => s?.location === 'cloud'

export function CloudMark({ compact = false }: { compact?: boolean }): React.JSX.Element {
  return (
    <span className={`cloud-mark ${compact ? 'cloud-mark--compact' : ''}`} title="Runs in your cloud: it keeps going with this Mac closed">
      <Icon name="cloud" size={11} />
      {!compact && <span>Cloud</span>}
    </span>
  )
}
