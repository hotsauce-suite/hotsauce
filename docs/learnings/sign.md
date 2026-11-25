# Sign (e-signatures)

Learnings from building Sign (`packages/sign`, `apps/server/src/sign/`, `apps/web/src/apps/sign/`).

- **Seal last, and undo what you stored if the commit fails.** The first cut sealed the PDF and
  saved both copies into Files, then committed the envelope with a blobOid check. A stale page or
  a double press of Finish got its 409 only after two "(signed)" PDFs were already in Files. Now
  the blobOid is checked first, the next envelope is validated with a stand-in result before
  sealing, signings of one envelope run one after another, and stored copies are removed when the
  commit fails.
- **pdf-lib's page size is the MediaBox, unrotated.** pdf.js draws the CropBox with `/Rotate`
  applied, so a turned or cropped page shows one way and stamps another. Sign refused such PDFs
  until slice 3c (2026-11-25) brought SignuDoc's `pdf-page-geometry.ts` across: `readPdfPages` now
  stores the size as shown, and stamping draws through a matrix from the shown page to the page.
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
- Great Vibes, the typed-signature font, is a hairline script: at field size it reads grey even in
  near-black. On the PDF it is drawn filled and outlined (text render mode 2, an outline of about
  2.5% of the font size) in blue-black; on screen `-webkit-text-stroke` matches it. Size a typed
  signature to its field by measuring (`offsetWidth` of an inline-block), not with `cqw` maths:
  script capitals are far wider than the average letter.
- Crop a drawn signature to its ink before saving it, or the whole pad, mostly empty, is shrunk
  into the field and the strokes come out thin.

## Bringing SignuDoc changes across (slice 3b, Nov 17)

- SignuDoc keeps envelopes in Postgres and solves races with row locks and transactions; here an
  envelope is one Git file and `#serial` runs one change per envelope at a time. Most of its
  follow-up race fixes ("check a decline's recipients under the lock") don't apply: every public
  action already re-reads the envelope by token inside `#serial`. Read the upstream commit
  messages for the behaviour, then rebuild; don't port the SQL.
- The vendored engine already knew `signer_corrected` and `copied` (types, certificate wording,
  recipient redaction of `previousEmail`). Check `packages/sign/src/vendor` before adding engine
  code: often only `AUDIT_EVENTS` in `packages/format/src/sign.ts` needs the new names.
- "A failed email changes nothing" with no transaction: send the email first, save after. The
  leftover risk is a save that fails after the email went out; say so plainly in the error.
- The vendored certificate labelled a correction's actor with the corrected person's name; patched
  in `pdf-finalize.ts` (marked "Hotsauce:"). Keep vendor patches marked so a re-sync finds them.
- A test that calls a personal-space envelope as another member hits the access check, not the
  sender check; test sender-only rules on a team-space envelope.
- `pnpm test` from the root takes over 10 minutes; while iterating run the integration file alone
  with `npx vitest run -c vitest.integration.config.ts <file>` in `apps/server` (build
  `@hotsauce/format` and `@hotsauce/sign` first or imports fail to resolve).

## Bringing SignuDoc fixes across again (slice 3c, Nov 25)

- Patch per upstream commit, not one big diff. `git diff <c>^1 <c> -- <file>` for each wanted
  commit, applied in date order with `patch -F3`, carried 8 of 9 commits onto the patched vendor
  file cleanly; one big `base..HEAD` diff mixes the fixes with features (approvers, parallel steps)
  that touch the same functions. Check fuzzed hunks: one landed a line inside the wrong function
  (a `finalizeEnvelope` hunk; Hotsauce has no `finalizeEnvelope`).
- "Since date X" needs the upstream merge history: the fix list started on a branch made before
  the base date (the rotated-page fix 07b9042 is dated Nov 16 but merged Nov 17), so a date filter
  on `git log` alone misses it. Diff the vendored file against candidate upstream commits to find
  which one it was copied from.
- Upstream tests use `node:test` and `pdfjs-dist`; here swap `node:test` for `vitest`, and read
  PDFs with unpdf's `getResolvedPDFJS()`. Its document has no `destroy()`: destroy the loading task.
- The server's `makeTestPdf` takes `{ rotate }`, so integration tests can make a turned page
  without adding pdf-lib to the server.
