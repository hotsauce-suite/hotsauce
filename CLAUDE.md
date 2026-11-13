# Hotsauce: notes for coding agents

Read `docs/ARCHITECTURE.md` for the area you're touching, and `CONTRIBUTING.md` for the rules.

- TypeScript everywhere, pnpm workspaces, Node 22. `apps/server` is one Hono process (API, WebSockets, the built web app) with the real `git` CLI and SQLite as a rebuildable index. `apps/web` is React + Vite + React Router + Tailwind with our own tokens; the editor is CodeMirror 6. `packages/format` owns the file format; every app goes through it.
- Git is the truth. Never reformat Markdown Hotsauce didn't write.
- One instance serves one organization (ARCHITECTURE §11). The environment always wins over settings saved in the setup wizard.
- No secrets in the repository. Env vars that hold placeholder values are placeholders: never print or commit them.
- Run every gate before you finish: `pnpm lint`, `pnpm typecheck`, `pnpm exec tsc -p e2e`, `pnpm test`, `pnpm build && pnpm test:e2e`.

## Keep every support material current (Morgan's standing rule, 2026-11-13)

Any change to what the product does or how it looks is not done until everything that describes or shows it matches, in the same PR or a follow-up PR you open right away. Check each of these and update what's affected:

- **The landing page** (hotsauce.work, `site/public/index.html` in the Hotsauce repo): the app cards, each app's window (walkthrough, feature list, what it needs), the FAQ and the costs.
- **The demos**: the live demo's sample data (`apps/web/src/mocks/`, served at demo.hotsauce.work), the looping app videos (`site/public/video/apps/`) and the tour video (`scripts/tour-video/`). Re-record a loop when its screen changes.
- **The help docs**: `README.md`, `docs/self-host.md`, `docs/mcp.md`, `CONTRIBUTING.md`, and in-app help text, empty states and settings descriptions.
- **The Mac app** (`apps/dictate-mac`) and **the Chrome extension** (`apps/extension`): their screens, copy and any behavior that depends on the change.
- **Screenshots** in `docs/screenshots/` and on the site.

If you can't update something yourself (it needs Morgan's Mac or a store listing), add it to the open-items list for Morgan and say so in your final reply. Never leave a support material describing something the product no longer does.
