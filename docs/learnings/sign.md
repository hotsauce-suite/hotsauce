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
