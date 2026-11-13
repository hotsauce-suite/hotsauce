# Learnings: keyboard shortcuts and Command-K

- **One list, one listener.** Every shortcut lives in `apps/web/src/keyboard/catalog.ts`, and `shortcuts.ts` is the only window `keydown` listener. A new key is a catalog entry plus `useShortcut(id, run)`. `catalog.test.ts` fails on clashes and on browser-owned keys, so run it first.
- **Mac disks ignore case.** `Keys.tsx` next to `keys.ts` built fine on Linux CI and broke the website build on the Mac. `pnpm lint` now runs `scripts/check-filename-case.mjs`. Never name two files apart only by case, even with different extensions.
- **A handler that returns `false` lets the key through.** Row keys (Notes `p`/`a`, Links `a`/`o`) return false when no row has focus, so the letter stays harmless.
- **Lists are DOM-driven.** `keyboard/listKeys.ts` moves focus between `[data-list-item]` elements in page order. Mark the row's main link or button and Enter opens it natively. When a key takes the row out of the list, call `holdListPlace()` before acting. When a key moves the row (pinning), call `followRow()`.
- **Command-K's highlighted row must be the first one shown.** cmdk keeps whatever value you pass, so compute `top` in display order. Otherwise the list opens scrolled to the middle. Also, a confirm step must start on Cancel and be the only group on screen; otherwise a second Enter runs the step.
- **"Ask the assistant" matches any query** (`anyQuery`). Keep the Ask group last, or it takes Enter away from real matches.
- **Ctrl+K inside cmdk is cmdk's own vim binding.** On Linux, Ctrl+K doesn't close Command-K once it's open; ⌘K on a Mac does.
- **Programmatic `input.click()` for a file picker needs user activation.** A keydown counts, so `u` in Files can open the picker.
- **The test app doesn't mount every route.** `test/renderApp.tsx` lists its own routes. Add the app's routes there before writing a `renderApp('/files')` test.
- **The mock search only covers `docs/`.** Command-K tests for other kinds of files stub `/api/search` with `server.use`.
- **The Mac Go menu has its own copy of the rail** (`Brand.railShortcuts`). `apps/web/src/apps/macRail.test.ts` fails when it drifts from `APPS`.
