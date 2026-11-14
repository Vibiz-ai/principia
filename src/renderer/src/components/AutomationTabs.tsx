/**
 * The Workflows door: Workflows, Schedules and Slack triggers as tabs. Each tab is its own route, so old deep links keep
 * working (the retired Routines and Autopilot tabs resolve to Schedules in lib/nav).
 */
import { Segmented } from './ui'
import { navigate } from '../state/store'

export type AutomationTab = 'routines' | 'autopilots' | 'schedules' | 'workflows' | 'slack'

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
        { value: 'workflows', label: 'Workflows' },
        { value: 'schedules', label: 'Schedules' },
        { value: 'slack', label: 'Slack triggers' }
      ]}
      value={value}
      onChange={go}
    />
  )
}
