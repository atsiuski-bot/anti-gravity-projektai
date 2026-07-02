# WORKZ

WORKZ is a mobile-first PWA for work-time tracking — tasks, work/break/call timers,
shift planning, and team oversight for workers and managers.

- **Stack:** React 18 + Vite + Tailwind CSS, Firebase (Auth + Firestore + Storage), PWA.
- **Hosting:** Cloudflare Pages (primary — auto-deploys on push to `main`) + Netlify in parallel. **Backend:** Firebase.
- **UI language:** Lithuanian. **Repository artifacts** (docs, code, commit messages): English.

## Docs

- [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md) — operating protocol for AI agents (read before changing anything).
- [`docs/`](docs/README.md) — design system, design tokens, and Architecture Decision Records (ADRs).

## Develop

```bash
npm install
npm run dev      # Vite dev server (network host enabled for mobile testing)
npm run build    # production build -> dist/
npm run lint     # ESLint, zero warnings enforced
```
