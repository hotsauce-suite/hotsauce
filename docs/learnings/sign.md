# Sign (e-signatures)

Learnings from building Sign (`packages/sign`, `apps/server/src/sign/`, `apps/web/src/apps/sign/`).

- **Seal last, and undo what you stored if the commit fails.** The first cut sealed the PDF and
  saved both copies into Files, then committed the envelope with a blobOid check. A stale page or
  a double press of Finish got its 409 only after two "(signed)" PDFs were already in Files. Now
  the blobOid is checked first, the next envelope is validated with a stand-in result before
  sealing, signings of one envelope run one after another, and stored copies are removed when the
  commit fails.
- **pdf-lib's page size is the MediaBox, unrotated.** pdf.js draws the CropBox with `/Rotate`
  applied, so a turned or cropped page shows one way and stamps another. Until the stamping
  handles those boxes, `readPdfPages` marks such pages and Sign refuses the PDF with a plain
  message, rather than seal a signature in the wrong place.
- **The hash chain only covers the events.** Editing a signed field's value in Git left the chain
  intact. The `signed` event now carries a digest of what that signer filled in, and the envelope
  page checks both.
- **Don't trust what the signer's request says for evidence.** Forwarded-for headers are only kept
  when they parse as an IP (`net.isIP`); the date field takes the signer's local day only within a
  day of the server's, so nobody can backdate; a drawn PNG's header size is checked before pdf-lib
  decodes it.
- **`preventDefault` on pointerdown stops focus.** Dragging a field selected it but left focus
  elsewhere, so the arrow keys did nothing. Focus the field's button by hand after placing or
  selecting it, and let Enter on a field type place one without a pointer (`e.detail === 0`).
- **The demo seed shows up in other tests.** Seeding a finished envelope added its two PDFs to
  the Files demo's "Pilot launch" folder; `fileHandlers.test.ts` pins that folder's listing.
- **e2e here needs `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`** in
  a cloud session, since the repo's Playwright expects another Chromium build.
- **`/s/` was taken.** Read-only share links already live at `/s/:token`, so signing links are
  `/signing/:token`. Grep `router.tsx` for a path before putting it in an email: once a link is
  sent, its path can't change.
- **A link's secret in the URL needs no-referrer on that page.** The server sends
  `Referrer-Policy: no-referrer` for `/signing/*` and the page adds the meta tag, so a click on any
  link in the PDF or footer doesn't leak the secret.
- **`new Date()` ignores a stubbed `Date.now`.** The expiry test passed with a stub until it
  didn't; `vi.useFakeTimers({ toFake: ['Date'] })` with `vi.setSystemTime` moves both.
- **The demo's state lives in one tab.** A signing link made in the demo opens in a new tab as
  "doesn't work", because that tab has fresh mock data. The seeded envelope has a fixed token
  (`demoSigningToken()` in the mocks) so the outside signer's page can be tried from any tab.
- **The format package is read from its build.** After changing `packages/format`, run its build
  before the server's integration tests, or they see the old schema (a signer's `role` was
  silently dropped and every test failed on "Add a signature field").
- **Secrets in paths reach the logs.** The error handler logged `c.req.path` on every 500, which
  for a signing link is the secret itself. It now redacts link paths; check any new public route
  whose path carries a token.
- **Send email after the lock, not inside it.** Completion emails went out one by one inside the
  per-envelope lock, so a slow mail service could time out the last signer's page after they had
  signed. They now go out after the save (`settled()` lets tests wait for them).
- **Anyone who can open an envelope isn't its sender.** Team-space members could mint a new link
  for an outside signer and sign as them. Send and new links are the creator's only, and a new
  link is chained into the audit trail.
