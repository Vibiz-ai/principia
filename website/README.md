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
