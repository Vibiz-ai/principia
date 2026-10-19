import { registerGatewayHandlers } from './gateway'
import type { Hive } from '../hive'
import { registerMissingAsNotImplemented } from '../ipc'
import { log } from '../log'
import { registerAppHandlers } from './app'
import { registerArtifactHandlers } from './artifacts'
import { registerProfileHandlers } from './profiles'
import { registerRepoHandlers } from './repos'
import { registerRunHandlers } from './runs'
import { registerScheduleHandlers } from './schedules'
import { registerSecretHandlers } from './secrets'
import { registerSessionHandlers } from './sessions'
import { registerWorkflowHandlers } from './workflows'
import { registerMemoryHandlers } from './memory'
import { registerAgentHandlers } from './agents'
import { registerAuthorHandlers } from './author'
import { registerSlackHandlers } from './slack'
import { registerMarketplaceHandlers } from './marketplace'

export function registerAllHandlers(h: Hive): void {
  registerGatewayHandlers(h)
  registerAppHandlers(h)
  registerRepoHandlers(h)
  registerProfileHandlers(h)
  registerSessionHandlers(h)
  registerWorkflowHandlers(h)
  registerRunHandlers(h)
  registerScheduleHandlers(h)
  registerSecretHandlers(h)
  registerArtifactHandlers(h)
  registerMemoryHandlers(h)
  registerAgentHandlers(h)
  registerAuthorHandlers(h)
  registerSlackHandlers(h)
  registerMarketplaceHandlers(h)
  const missing = registerMissingAsNotImplemented()
  if (missing.length) log.warn('IPC channels without a handler', { missing })
}
