import { showThingsMoved } from '../../lib/firstRun'
import { useStore } from '../../state/store'

/** Five doors step 5: the one-time "Things moved" card is due (lib/firstRun.showThingsMoved). */
export function useThingsMoved(): boolean {
  return useStore((s) =>
    showThingsMoved({
      notices: s.settings?.notices,
      companies: s.companies,
      taskCount: s.tasks.length,
      onboardingOpen: !!s.onboarding?.open,
      firstWeekPending: Object.keys(s.settings?.firstWeek ?? {}).length > 0
    })
  )
}
