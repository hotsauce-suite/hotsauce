# Learnings: Today

- **A stand-in layout must never be editable.** Today first showed the default layout while the saved one loaded, and Edit Today copied whatever was showing. A quick click (or a slow server) saved the default over the member's own layout. Hold editing until the real layout arrives, and make a failed load read-only.
- **`<Component />` is always truthy.** `const body = <TileBody />` followed by `body ? … : null` never hides anything, even when `TileBody` returns null. That left an empty wrapper (a 20 px gap) at the top of a column. Decide "hidden today" with a plain function before you make the element.
- **Capture `fetch` lazily in services that tests stub.** `deps.fetch ?? fetch` binds the real fetch when the app is built, so a later `vi.spyOn(globalThis, 'fetch')` doesn't take effect and the test quietly hits the network (here MET Norway really answered, which hid the bug). Use `(i, o) => globalThis.fetch(i, o)`.
- **MET Norway's Locationforecast is reachable from the cloud sandbox and needs no key.** It wants an identifying User-Agent and at most 4 decimals. It throttles per User-Agent, so a self-hosted instance's whole user base shares one budget: rate limit per member and cache failures.
- **`pointer-events-none` isn't "can't use".** Tab still reaches the links and inputs inside. Use `inert` (React 19 takes it as a boolean) for anything shown but not usable, such as tiles in edit mode.
- **Biome on main flags pre-existing problems** in `site/public/index.html`, `ramble.test.ts` and `briefHandlers.ts`. Lint the files you touched to see your own state, and don't "fix" theirs in a feature PR.

## Weather location (2026-11-14)

- **WebKit in a Mac app never asks for location.** `navigator.geolocation` in a WKWebView on macOS
  is turned down silently unless the app answers a private delegate call, and without a location
  usage description macOS has nothing to show. The Mac app answers the page itself
  (`hearthLocation` bridge, CoreLocation) instead of relying on that private API; check for the
  bridge before calling the browser's geolocation.
- **A refused permission must change the button, not repeat the request.** Retrying
  `getCurrentPosition` after a browser block fails instantly and looks like a dead click. Offer a
  way that doesn't need the permission (a typed city), and say where the switch is.
- **Don't open System Settings right after the person said no** in macOS's prompt. Open it only when
  the refusal is old and they asked again.
- **Old clients outlive the fix.** Detect a Mac app without the new bridge (it still has its
  sign-in bridge) and tell the member to update, rather than looping on a request it can't make.
