# Learnings: comments and @mentions

- **A hidden folder can be indexed, but then search has to leave it out.** Comments live in `.hearth/comments/` and still need the index (reads, reindex). `isIndexable` got one exception, and the search query excludes the `comment` kind unless asked. Check every reader of the index that assumes "indexed means visible" (`linksInto` was one).
- **Deleting an item has three doors.** The file API (and MCP) `moveToTrash`, `deleteMeeting` and `Tasks.#trash` each build their own commit. Anything that must die with an item has to be added to all three; `commentRemovals(index, space, paths)` is the shared helper.
- **React inside CodeMirror: hand the editor one long-lived element.** A block widget whose `toDOM` returns the same host element each time (`eq` compares the host) lets a React portal own the content across redraws and editor remounts. It needs `ignoreEvent: () => true`, a `ResizeObserver` → `view.requestMeasure()`, padding instead of margin on the content (block-widget margins break CodeMirror's height map), and `white-space`, `overflow-wrap` and `word-break` reset on the host, because `.cm-content` sets them for code and a button label will wrap mid-word on a phone.
- **The slot is only in the page near the viewport.** A link to a comment has to scroll the editor's end into view first (`EditorBridge.revealEnd`), then wait a few frames for the element to be connected before `scrollIntoView`.
- **A same-path navigation with only a new `#hash` does not remount the page.** State such as "reading view on" survives it, so anything that reacts to the hash must work in both views.
- **Keep the mention picker and the server's resolver apart.** The picker only writes text; `findMentions` on the server decides who is named, and the web marks only the mentions the server stored. That is why a typed `@Name` and a picked one behave the same.
- **Close the picker after a finished name.** "@Sam Okafor " still parses as an open mention; without the check, Enter picks Sam again instead of starting a new line.
- **`POST /api/tasks` answers 201.** Test helpers that assume 200 fail with an unhelpful message.
- **Run e2e locally with `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium`** when the pinned Playwright's browser isn't installed; `playwright.config.ts` reads it.
- **Only `*mobile.spec.ts` runs on the phone project.** A new spec named otherwise is desktop-only; check the phone by hand or name the file to match.
- **`pnpm exec vitest run` inside `site/` runs the whole workspace.** Use `pnpm test` from the root, or pass the site's test file path.
- **`GitStore.commit` throws on a failed `unchanged` guard; it only returns `status: 'conflict'` when given a `base`.** A retry loop that checks the return value never runs. Catch `HotsauceError` with code `conflict` (as Tasks does). The independent review caught this; a race test on a doc with no `id` now covers it.
- **Check the verb before deleting things in a shared helper.** `Tasks.#trash` serves both delete and move-to-another-space; the first version deleted a task's conversation on a move.
- **State that says "already scrolled there" must live above anything that remounts.** The conversation mounts once in the editor and once in the reading view, so "which comment did I land on" and "which focus request did I handle" live in the `useComments` hook, not in the view.
- **Act on `pointerdown` for a button that floats beside a selection.** A touch tap collapses the selection, and so removes the button, before `click` arrives.

## Merging on a busy day

- The landing page keeps every app's feature list on one long line (`const APPS = …` in
  `site/public/index.html`), so any two branches that touch it conflict. Don't hand-merge it: take
  main's line and re-apply your own additions with a small script that asserts each anchor is found
  once.
- A browser journey that only fails when the whole suite runs is usually a wait that matched the
  wrong request under load. Run the whole suite locally (`PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium
  pnpm exec playwright test --project=desktop-chromium`) before blaming your own change, and ask the
  coordinator whether the owning thread is already fixing it.

## For you (slice 2)

- **Derive the list, store only the member's marks.** For you reads mentions straight from the
  index (`json_each` over the comment frontmatter's `mentions`) and keeps one small JSON file of
  seen/done/later marks in the member's personal space. Nothing to backfill, and a reindex rebuilds
  it for free.
- **A cache keyed on "the index head" is wrong right after your own commit.** The index catches up
  a moment later, so the head you read is the old one and the cache serves stale marks. Key the
  cached marks on the oid your commit returned, and only keep them when the index already sits at
  that oid.
- **"Later" has to remember when it was chosen.** Without `laterAt`, a mention that arrived after
  Later was chosen could not tell the Later apart from an old one, and the item came round twice.
- **An edit that adds a name is a new mention for that person.** Sorting by the comment's `created`
  put it at the bottom; the comment now records `named[email]` when an edit first names someone.
- **A "put it on the rail once" offer must be used up when it is shown, not when they save.** Using
  it up on PUT /pins took the new app away from anyone who saved an arrangement without having seen
  it. `pinsWithOffers` records the offer in the same transaction that returns it.
- **New default pins ripple through tests.** The rail tests count and order entries; narrow test-id
  selectors (`[data-testid^="app-"]` caught the new count badge) before adding a badge inside an
  entry.
- **Sample tasks seed lazily per user in the mocks.** A mock that lists things across items has to
  seed them first (`seedTasksOnce`), or the demo shows half the list.
