# Screenshots (Mac app)

Learnings from building the screenshot tool (`docs/PLAN-screenshots.md`).

- **Don't offer pixelation as redaction.** Mosaic cells are averages of the hidden pixels; on a
  grid aligned to the box, text in a known font can be matched back. An independent review caught
  it after it was built and tested ("cells are averages" was the test, which is the leak). Redact
  is an opaque block over whole pixels, and the test decodes the exported PNG.
- **Redaction has more exits than the export.** The clipboard still held the original capture
  after a redacted save, and Copy Text read the raw source. Walk every way a picture leaves:
  copy, save, auto-save, drag-out, share, OCR, the pasteboard from before the edit.
- **ImageIO writes an `eXIf` chunk into a PNG even with no properties.** Strip ancillary chunks
  yourself (keep colour ones) and test the bytes.
- **Capture before showing the overlay** (`SCScreenshotManager`), so the overlay is never in its
  own picture, and keep the region math in native pixels and pure, so it tests without a screen.
- **The app has no upload credentials, and doesn't need them.** The signed-in page in the suite
  window does the upload: the app calls a page function with `callAsyncJavaScript` and gets an
  answer object that never throws. The page half shipped and was tested in a browser before any
  Swift existed.
- **Expiry belongs on the file, not the link.** A `delete_after` field on the Files pointer plus
  an hourly sweep removes pointer, bytes and link together; a link that merely expires leaves
  the bytes. Parse the date strictly: a hand-edited pointer with a loose date must not delete
  early.
- **A Mac build nobody can install is not shipped.** The server cached the Mac app's version file
  for six hours, so with many builds a day the app offered no update. The version file is now
  asked for every ten minutes. When a check page says "update first", confirm the update is
  really offered on the owner's server before sending it.
- **The cloud can't compile Swift.** The Mac session wrote and tested Swift; the cloud did the
  server, web, docs, reviews and merges. Splitting files by owner (Mac: `apps/dictate-mac` and
  the This Mac page; cloud: `site/`, `docs/`) avoided collisions while both worked.
- **Remote Control sessions pause on the plan's usage limit** and resume by themselves. Don't
  restart or re-hand the work.
