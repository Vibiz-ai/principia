# Principia website

Product and installation page, built with React 19, TypeScript, Vite, Tailwind CSS v4 and Lucide icons. The app screenshot is a real desktop workflow run captured during QA; no mock output or customer claims are presented.

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

Installation uses source commands because no downloadable release is published yet. Replace that primary path with a verified release only when one exists. The Roman headquarters reference is an editorial explanation of the name. No analytics, sign-up form, fake testimonials, or tracking cookies are included.

## Production hosting

The public website is deployed on Vercel under **vibiz-deployments / principia**:
https://principia-vibiz-deployments.vercel.app

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
