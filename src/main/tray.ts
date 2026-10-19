import path from 'node:path'
import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { trayMenuModel, trayTitle, type TrayAction, type TrayInput, type TrayItem } from './trayModel'

export function resourcePath(file: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'resources', file) : path.join(app.getAppPath(), 'resources', file)
}

/** Menu-bar item (SPEC A12). Rebuilt on status changes, throttled to 1 s. */
export class HiveTray {
  private tray: Tray | null = null
  private timer: NodeJS.Timeout | null = null
  private lastBuild = 0

  constructor(
    private input: () => TrayInput,
    private onAction: (a: TrayAction) => void
  ) {}

  create(): void {
    const img = nativeImage.createFromPath(resourcePath('trayTemplate.png'))
    img.setTemplateImage(true)
    this.tray = new Tray(img)
    this.tray.setToolTip('Principia')
    this.build()
  }

  update(): void {
    if (!this.tray) return
    const since = Date.now() - this.lastBuild
    if (since >= 1000) this.build()
    else if (!this.timer) this.timer = setTimeout(() => this.build(), 1000 - since)
  }

  private build(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.lastBuild = Date.now()
    if (!this.tray || this.tray.isDestroyed()) return
    const input = this.input()
    this.tray.setTitle(trayTitle(input.status), { fontType: 'monospacedDigit' })
    this.tray.setContextMenu(Menu.buildFromTemplate(trayMenuModel(input).map((i) => this.toTemplate(i))))
  }

  private toTemplate(i: TrayItem): MenuItemConstructorOptions {
    if (i.type === 'separator') return { type: 'separator' }
    return {
      label: i.label,
      type: i.type === 'checkbox' ? 'checkbox' : 'normal',
      checked: i.checked,
      enabled: i.enabled ?? true,
      accelerator: i.accelerator,
      registerAccelerator: false,
      click: i.action ? () => this.onAction(i.action!) : undefined,
      submenu: i.submenu?.map((s) => this.toTemplate(s))
    }
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer)
    this.tray?.destroy()
    this.tray = null
  }
}
