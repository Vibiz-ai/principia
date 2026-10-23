/**
 * The one Vite API the shell uses without pulling in all of `vite/client`: eager `import.meta.glob`, so App can route
 * to views that land in other packages (PortfolioView, PassportVaultView) and fall back while they are absent.
 */
interface ImportMeta {
  glob<T = Record<string, unknown>>(pattern: string | string[], options: { eager: true }): Record<string, T>
}
