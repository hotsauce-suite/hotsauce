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
- **Page order isn't reading order on a masonry board.** The Notes board renders column by column, so DOM order skips around. Mark the container `data-list-group` and each item `data-list-order`; `listItems()` sorts within the group.
- **Focus is often beside the item, not in it.** A note's pin button and a link's Done button are siblings of the marked item. Mark the whole row `data-list-row` so j/k and row keys still know where they are.
- **A quick-action prefix steals Enter from searches.** "task list" is as likely a search as a new task. Only the colon form ("task:") is highlighted outright; the bare word is highlighted only once the search found no title.
- **Search results must route through strict file patterns.** "The app that owns the folder" sends `tasks/archive/x.md` to a task page that doesn't exist. Use the strict `is…File` checks and fall back to Docs.
- **iPhone Safari videos have no `requestFullscreen`**, only `webkitEnterFullscreen`. Return false when neither exists so the key isn't swallowed.
- **Keys that need a microphone or a camera get Playwright tests**, which run with Chromium's fake devices (`e2e/keyboard-recording.spec.ts`). jsdom can't record.
