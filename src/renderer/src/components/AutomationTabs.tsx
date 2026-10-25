/**
 * Five doors, More → Automations: one door for Schedules, Workflows and Slack triggers (step 1 mounts the existing
 * pages as tabs; step 5 adds Autopilots, first). Each tab is its own route, so old deep links keep working.
 */
import { Segmented } from './ui'
import { navigate } from '../state/store'

export type AutomationTab = 'autopilots' | 'schedules' | 'workflows' | 'slack'

export function AutomationTabs({ value, onChange }: { value: AutomationTab; onChange?: (v: AutomationTab) => void }): React.JSX.Element {
  const go = (v: AutomationTab): void => {
    if (onChange && v !== 'workflows' && value !== 'workflows') return onChange(v)
    void navigate(v === 'workflows' ? { name: 'workflows' } : { name: 'schedules', tab: v, nonce: Date.now() })
  }
  return (
    <Segmented<AutomationTab>
      size="sm"
      className="no-drag"
      items={[
        { value: 'autopilots', label: 'Autopilots' },
        { value: 'schedules', label: 'Schedules' },
        { value: 'workflows', label: 'Workflows' },
        { value: 'slack', label: 'Slack triggers' }
      ]}
      value={value}
      onChange={go}
    />
  )
}
