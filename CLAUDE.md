# Hotsauce: notes for coding agents

Read `docs/ARCHITECTURE.md` for the area you're touching, and `CONTRIBUTING.md` for the rules.

- TypeScript everywhere, pnpm workspaces, Node 22. `apps/server` is one Hono process (API, WebSockets, the built web app) with the real `git` CLI and SQLite as a rebuildable index. `apps/web` is React + Vite + React Router + Tailwind with our own tokens; the editor is CodeMirror 6. `packages/format` owns the file format; every app goes through it.
- Git is the truth. Never reformat Markdown Hotsauce didn't write.
- One instance serves one organization (ARCHITECTURE §11). The environment always wins over settings saved in the setup wizard.
- No secrets in the repository. Env vars that hold placeholder values are placeholders: never print or commit them.
- Run every gate before you finish: `pnpm lint`, `pnpm typecheck`, `pnpm exec tsc -p e2e`, `pnpm test`, `pnpm build && pnpm test:e2e`.
