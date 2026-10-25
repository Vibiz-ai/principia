/**
 * Five doors §2.5: the sidebar header's company menu, as data. Pure (no store, no IPC) so it is tested on its own;
 * shell/CompanyHeader shows it with the native menu and acts on the chosen id.
 */
import type { CompanyPassport } from '@shared/company'
import type { NativeMenuItem } from '@shared/ipc'
import { companyLabel, isPersonal } from './companyModel'

/**
 * The company menu's items. Pause/Resume (the whole company, A4) and Autopilot show where there are agents (Personal has none);
 * Add Department lists the presets the company does not have yet. Pure, so the menu is tested without IPC.
 */
export function companyMenuItems(o: {
  company: Pick<CompanyPassport, 'id' | 'name' | 'system' | 'autopilot'> | null
  companies: Pick<CompanyPassport, 'id' | 'name' | 'system'>[]
  departments: boolean
  seats: number
  paused: boolean
  missingPresets: { key: string; name: string }[]
}): NativeMenuItem[] {
  const { company, companies, departments, seats, paused, missingPresets } = o
  const personal = !!company && isPersonal(company)
  const others = companies.filter((c) => c.id !== company?.id)
  return [
    ...(company
      ? ([
          { id: 'settings', label: 'Company Settings…' },
          // A4: Pause covers the whole company (agents, schedules, autopilot); while paused Autopilot is greyed out
          ...(departments && (seats > 0 || paused)
            ? ([
                { type: 'separator' },
                paused ? { id: 'resume', label: `Resume ${company.name}` } : { id: 'pause', label: `Pause ${company.name}` },
                paused
                  ? { id: 'autopilot', type: 'checkbox', label: 'Autopilot: off while paused', checked: false, enabled: false }
                  : { id: 'autopilot', type: 'checkbox', label: 'Autopilot (agents pick up tasks on their own)', checked: !!company.autopilot }
              ] as NativeMenuItem[])
            : []),
          ...(departments && !personal && missingPresets.length
            ? ([{ label: 'Add Department', submenu: missingPresets.map<NativeMenuItem>((p) => ({ id: `dep:${p.key}`, label: p.name })) }] as NativeMenuItem[])
            : []),
          { type: 'separator' }
        ] as NativeMenuItem[])
      : []),
    ...(others.length || company
      ? ([
          {
            label: 'Switch To',
            submenu: [
              ...companies.map<NativeMenuItem>((c, i) => ({ id: `co:${c.id}`, type: 'checkbox', label: companyLabel(c, true), checked: c.id === company?.id, accelerator: i < 9 ? `Ctrl+${i + 1}` : undefined })),
              { type: 'separator' },
              { id: 'all', type: 'checkbox', label: 'All Companies', checked: !company, accelerator: 'Ctrl+0' }
            ]
          }
        ] as NativeMenuItem[])
      : []),
    { id: 'new', label: 'New Company…' }
  ]
}

