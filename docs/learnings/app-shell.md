# Learnings: the app shell's frame

- **The page must never scroll; only panes do.** `html`, `body` and `#root` are the window's height, and each page puts its content in its own `overflow-y-auto` pane. If anything reaches past the window, the whole document scrolls and drags the rail and sidebar up with it, leaving empty space below (Settings → Organization, 0.11.1).
- **`sr-only` is `position: absolute`, and that escapes a scroll pane.** An absolute box is clipped by an `overflow` ancestor only if that ancestor sits between it and its containing block. `<main>` is a containing block (its entrance animation animates `transform`), the pane is inside it, so hidden file inputs deep in a scrolled page hung off `<main>` 1,600 px down. The shell's outer box (`.app-shell`) now has `overflow: clip`; `clip` rather than `hidden` so it can't be scrolled by focus or `scrollIntoView`.
- **Animations count as overflow.** The 6 px slide-in of `<main>` made every page 6 px too tall for 360 ms.
- **Don't stop the page bouncing with `overscroll-behavior: none` on `html`/`body`.** It was tried here and broke a key: Chrome on a Mac sends End (and Page Down) in a text box as "scroll to the end" and, when nothing scrolls, moves the caret instead; with overscroll off on the root the scroll counts as handled and the caret stays put (`e2e/notes.spec.ts` caught it, on a Mac only). Safari's brief bounce of a page that can't scroll snaps back and moves nothing for good, so it's left alone.
- **Don't clip `#root`.** Public pages outside the shell (`/f/`, `/book/`, `/s/`, `/setup`, `/sign-in`) grow with `min-h-full` and scroll the document; clipping `#root` cut them off at one screen. The first attempt did exactly that; a reviewer caught it.
- **Test as an admin.** A member sees a short Organization page, so the bug hid from a test user that wasn't one. `e2e/shell-fit.spec.ts` signs in as the e2e admin and checks every app at laptop and iPad sizes (`shell-fit-mobile.spec.ts` on a phone).
- **Find what overflows by listing positioned boxes past the fold** with their `offsetParent`: an in-flow element past the fold inside a pane is fine; an absolute one whose `offsetParent` sits outside the pane is the culprit.
- **An open single-page app never picks up a new build by itself.** `skipWaiting` + `clientsClaim` swap the service worker, but the page already running keeps its old code, and since it never navigates the browser doesn't even look for the new worker. Ask the server for its release (`/api/health`), and before reloading call `registration.update()` and wait for `controllerchange`, or the reload is served the old cached shell (`lib/appUpdate.ts`).
- **"Would leaving lose something?" already has one answer: `beforeunload`.** Every editor and recorder calls `preventDefault()` on it while dirty or recording, so dispatching a synthetic cancelable `beforeunload` and reading `defaultPrevented` asks all of them at once, including ones added later (`lib/safeToReload.ts`). Ask the live meeting first: its handler also flushes notes. Anything that a reload would cut must add a guard (`hooks/useLeaveGuard.ts`); the dictate button and Ramble had none.
- **Bake the release into the build with `define`, not from `/api/health` at boot.** At boot the page may be running a cached old build against a new server, so "the version I saw at boot" would already be the new one and nothing would ever reload.

## Effects on tool switches (switch ripple, Nov 19)

- React Router commits a navigation in a transition, so an effect that reacts to the new route runs
  outside the click. WebKit (Safari, the Mac app's web view) only starts an `AudioContext` inside a
  user gesture: create or resume it from a capture `pointerdown`/`keydown` listener, then play later.
  Chromium tests pass either way, so they won't catch this.
- `/settings` and `/feedback` live in the shell but no app owns them (`ownerOfPath` is null). Anything
  keyed on "the app changed" should skip null rather than treat it as a tool, or Docs → Settings →
  Docs counts as a switch.
- In this cloud container Playwright's pinned headless shell isn't installed; run e2e with
  `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium` (playwright.config.ts reads it).
