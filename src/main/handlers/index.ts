import { registerCompanyHandlers } from './company'
import { registerBoardHandlers } from './board'
import { registerOpenPassportHandlers } from './openPassport'
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
import { registerOnboardingHandlers } from './onboarding'
import { registerForumHandlers } from './forum'
import { registerCloudHandlers } from './cloud'
import { registerDashboardHandlers } from './dashboards'
import { registerTaskWorkHandlers } from './taskWork'
import { registerUsageHandlers } from './usage'
import { registerLinearHandlers } from './linear'
import { registerPlansHandlers } from './plans'

export function registerAllHandlers(h: Hive): void {
  registerCompanyHandlers(h)
  registerBoardHandlers(h)
  registerOpenPassportHandlers(h)
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
  registerOnboardingHandlers(h)
  registerForumHandlers(h)
  registerCloudHandlers(h)
  registerDashboardHandlers(h)
  registerTaskWorkHandlers(h)
  registerUsageHandlers(h)
  registerLinearHandlers(h)
  registerPlansHandlers(h)
  const missing = registerMissingAsNotImplemented()
  if (missing.length) log.warn('IPC channels without a handler', { missing })
}
