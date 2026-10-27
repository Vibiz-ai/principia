# Principia website

Product and installation page, built with React 19, TypeScript, Vite, Tailwind CSS v4 and Lucide icons. Product captures show the current renderer with a clearly labelled example workspace; sample activity is illustrative.

```sh
cd website
npm ci
npm run dev
npm run build
```

Static output: `dist/`. Deploy to any static host. No backend or runtime secrets required. The cloud runner is a separate deployment.

## Components and styles

Reusable UI components live in `src/components/ui`, imported as `@/components/ui`. This is the conventional shadcn directory, configured in `components.json`, so future CLI components and imports have one predictable destination. `src/lib/utils.ts` provides `cn`. No shadcn migration of the Electron app is required: this is a separate website package.

Global styles and Tailwind v4 theme are in `src/styles.css`; Tailwind is installed with `@tailwindcss/vite` in `vite.config.ts`. TypeScript is configured in `tsconfig.json`. To add a shadcn component from this directory, run `npx shadcn@latest add <component>`; the required structure is already configured.

The halftone wordmark footer lives in `src/components/ui/halftone-wordmark-footer.tsx`. It needs React and browser canvas APIs only; no provider, state library or image dependency. The page passes Principia copy, GitHub/documentation links, matching colours and responsive height. Pointer and click animation pauses offscreen and respects reduced motion.

The Roman headquarters reference is an editorial explanation of the name. No analytics, sign-up form, fake testimonials, or tracking cookies are included.

## Download

`RELEASE` at the top of `src/main.tsx` picks what **Download for Mac** serves:

| `RELEASE` | Button | Link |
| --- | --- | --- |
| `'preview'` (now) | Download for Mac · Preview, with the macOS **Open Anyway** steps under it | the preview pre-release's exact asset, `releases/download/<PREVIEW.tag>/<PREVIEW.file>` (`releases/latest` never serves a pre-release) |
| `'signed'` | Download for Mac | `releases/latest/download/Principia-arm64.dmg`, always the newest signed, notarized release |
| `'none'` | Get started (source install only) | none |

After the first signed release (principia `docs/RELEASING.md` §7), change that one line to `RELEASE = 'signed'` and deploy. For a newer preview, update `PREVIEW` (tag and file name). Building from source stays the secondary path either way. Cloud (runner, hosted workspace, browser workspace, Telegram) and the iPhone app are shown as coming soon.

## Production hosting

The public website is https://useprincipia.com (`www.useprincipia.com` redirects to it), deployed on Vercel under the
**vibiz-deployments / principia** project. The privacy policy is `public/privacy/index.html`, served at
https://useprincipia.com/privacy/.

The Vercel project receives this directory as its deployment root. `vercel.json` specifies the Vite build, `npm ci`, and `dist` output. It does not deploy the Electron app or cloud runner. To publish an update with the Vercel CLI from this directory:

```sh
vercel link --yes --scope vibiz-deployments --project principia
vercel project inspect --scope vibiz-deployments --non-interactive
npm run build
vercel deploy --prod --scope vibiz-deployments
```

This is a CLI deployment; automatic Git deployments are not configured. Keep `.vercel`, local environment files and `.openai` hosting state out of uploads and commits.

## Product positioning

Lead with “Run your entire company. From one workspace.” The one-company-or-a-thousand ambition describes the roadmap, not current scale or autonomy guarantees. The toolbox section covers planned databases, image generation, scraping, connections, phone, and email. Passport is the planned portable company memory and context-sharing layer; current project memory must not be described as shipped Passport import/export or universal authentication.

Product screenshots use the actual renderer components with an explicitly labelled example workspace. `principia-agents.png` shows the agent hierarchy; `principia-connections.png` shows the searchable catalog. Sample activity and costs are illustrative, not customer results.
