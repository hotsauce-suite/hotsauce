# Slides (Present a doc)

See docs/PLAN-slides.md for what was built.

- **Scale slides with container units, not transforms.** Give the slide `container-type: size` and
  size its type in `cqw`. The same slide then fits the full screen, the presenter's thumbnail and
  the next-slide preview without any measuring code or `ResizeObserver`.
- **A second window needs no sync.** `window.open('about:blank#…')`, copy the page's `<style>` and
  `<link>` tags and the `<html>` attributes into it, then render into its body with a React portal.
  Both windows share one React tree and one state, so the laser dot and slide changes mirror for
  free. Listen for keys on both windows, and poll `win.closed` to notice the audience closing it.
- **Read state through a ref when a handler has side effects.** Doing "close the show" or "go full
  screen" inside a `setState` updater runs twice under StrictMode. Keep the state in a ref, compute
  the next state and its effect synchronously, then set state.
- **Slides are always light.** The app's dark theme would otherwise leak into the deck; the slide
  sets its own light tokens, and the stage around it its own dark ones.
- **The Mac app catches `window.open` in `createWebViewWith`.** Match the window's URL there and
  give back a web view in a new window placed on the other `NSScreen`; returning that configured
  view keeps the opener relationship, so the page's portal still works.
- **e2e:** ⌘K commands are reached with `getByTestId('cmdk-input').fill(…)` then
  `getByTestId('cmdk-command-<id>')`; typing into the palette with the keyboard is flaky. The editor
  hides `##` markers, so check a saved doc through the API rather than its visible text. Locally,
  Playwright needs `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium` in the cloud container.
- **pdfmake slides:** a 16:9 page is 792×445.5 pt; draw the paper with `background`, and turn each
  slide break into `{ text: '', pageBreak: 'after' }` rather than a rule.
