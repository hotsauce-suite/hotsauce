# Plan: pinned apps on the rail, and a launcher with every app

**Status:** shipped in 0.12.0 (Nov 13, 2026), PR #65 with imagery in #71. Every requirement below has a passing test.

With fifteen apps the desktop rail had become a scrolling list. Now it shows only the apps each
member pins, like the "Your favorites" row of Google's app launcher, and a grid button opens a
launcher with every app.

## Requirements (each maps to a test)

1. A new member's rail shows Today, Docs, Tasks, Meetings and Chat, in that order. Chat shows only
   where the organization added a chat link. *(AppRail.test: "shows the default pins")*
2. The rail shows a member's saved pins in their order; ids this instance doesn't have are skipped.
   *(AppRail.test: "shows the member's saved pins")*
3. When the open app isn't pinned, it shows below the pins (after a thin line) and is marked as the
   current page, so the rail always shows where you are. *(AppRail.test: "shows the open app
   below the pins"; e2e app-rail: Dictate)*
4. A grid button at the foot of the rail ("All apps") opens the launcher, a popover beside the rail
   listing every app and link. Clicking one opens it and closes the launcher; Escape or a click
   outside closes it and focus returns to the button. *(AppRail.test: "opens every app from the
   launcher")*
5. The launcher's top row is "Your pinned apps" with a pencil (Edit). In edit mode a click pins or
   unpins an app, pinned apps drag into a new order, and Alt plus an arrow key moves the focused
   one. *(AppRail.test: launcher test; e2e app-rail: "pins an app from the launcher")*
6. Six pins at most; past that, unpinned apps can't be added until one is unpinned. *(AppRail.test;
   server api.test "rail pins")*
7. Pins are saved per member on the server (`GET/PUT /api/pins`, the index's `pins` table, kept by
   reindex like stars) and survive a reload and a new device. The browser keeps a copy so the rail
   draws without waiting, and forgets it at sign-out. *(api.test "rail pins"; e2e reload)*
8. Command-K lists the pinned apps first, in rail order. *(AppRail.test: Cmd-K test)*
9. Desktop rail icons are 25px (a quarter bigger than the phone bar's 20px; they were 30px), the
   rail 60px wide, and every label fits. *(e2e app-rail: icon size)*
10. The phone bottom bar is unchanged: four fixed apps and the Apps sheet. *(AppRail.test phone
    tests; e2e mobile)*

## Decisions taken

- **g-shortcuts stay letters** (g then d for Docs) for every app, pinned or not: they're mnemonic,
  not positional.
- **The Mac app's Go menu and ⌘1–9 keep the fixed full app list.** Making them follow pins needs a
  bridge from the web page to the Mac app and a new Mac release; the Go menu already works like the
  launcher (every app). Revisit if members ask for ⌘1 to mean "my first pin".
- **The phone bar stays as it is.** Its four apps were chosen for a phone; the Apps sheet has the rest.
- **The open app shows below the pins** instead of disappearing, so you never lose your place.

## Shared files touched

`apps/web/src/components/AppRail.tsx`, `AppsSheet.tsx` (no change in behavior), `CommandK.tsx`,
`styles/tokens.css` (`--rail-width`), `apps/server/src/index/schema.ts` (one appended migration),
`apps/server/src/api/account.ts`, and e2e specs that clicked unpinned apps on the rail (they use
the `openApp` fixture now).
