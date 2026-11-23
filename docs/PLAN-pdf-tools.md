# PDF tools in Files

## Status

Built, in review (2026-11-23). Not yet done: the searchable text is Helvetica, so it holds
English and other Latin-alphabet languages only (Greek, Cyrillic, CJK and the like come out as
"?"); a Unicode font for the text layer would lift that. The demo has no scanned sample. Real-Mac
checks of the Dock drop and Vision reading are on the owner's list. Decided with the owner: the tools live in Files, not a new app; every
tool saves a new PDF beside the original and never changes it; one PDF tools panel opens from a
PDF's ⋯ menu and from the open PDF; redaction flattens only the pages with a box; shrink has three
sizes; Make searchable reads English on the web and uses Apple's Vision in the Mac app;
PDFs dropped on the Mac app's icon land in Personal files and open in the panel (several open in
Combine). Ideas came from Puter Office's PDF app (AGPL, ideas only); every library used is MIT or
Apache.

## Why

People combine scans, pull out a few pages, turn a sideways page, shrink a file to email it, make
a scan searchable and black out a name before sending. Today each of those means leaving Hotsauce
for a website that keeps a copy of the file. Results land in Files beside the original, where
search, Sign and Links already use them.

## How it works

The browser does the work, like Download as Word or PDF (`docs/PLAN-doc-download.md`): it already
has the bytes through the API, so it works on every host (Fly, Cloudflare, your own machine) and
the server needs nothing new. The result is uploaded with the normal chunked upload into the same
space and folder as the original.

- `apps/web/src/lib/pdf/tools.ts`: pure functions over PDF bytes with the MIT `pdf-lib`: assemble
  pages from one or more PDFs (combine, reorder, rotate, remove), split into ranges, add an
  invisible text layer, rebuild pages as pictures, and recompress pictures. Tested in Node.
- `apps/web/src/lib/pdf/render.ts`: draws pages with `pdfjs-dist` (Apache) for thumbnails,
  redaction and reading text.
- `apps/web/src/lib/pdf/ocr.ts`: reads the words on a page picture. In the Mac app it asks the
  app (`hotsauceReadText`, Apple's Vision); elsewhere it runs `tesseract.js` (Apache) with the
  English model, both served from `/ocr/` by our own server, loaded only when someone uses it.
- Every new PDF is built fresh from the pages it keeps (`PDFDocument.create` + `copyPages`), so
  nothing from a removed or redacted page stays in the file.

## Requirements

1. R1. A PDF's ⋯ menu in the Files list and the open PDF both have **PDF tools**, which opens one
   panel with the pages as thumbnails and five tabs: Pages, Split, Shrink, Make searchable,
   Redact. It isn't offered for other files, nor offline.
2. R2. **Pages**: rotate any page left or right, move it earlier or later (buttons and dragging),
   remove it, and add pages from other PDFs (from Files or from the computer) at the end. Save
   makes "Name (edited).pdf", or "Name (combined).pdf" when pages came from more than one PDF.
3. R3. **Split**: every page on its own, or ranges typed like `1-3, 5, 8-`; each range becomes
   "Name (pages 1-3).pdf". A range outside the document says so before anything is saved.
4. R4. **Shrink**: For email, Balanced, Keep quality. Pictures are scaled down and saved again as
   JPEG (For email and Balanced only), and the file is rewritten compactly. It shows the size
   before and after; when the result isn't smaller it saves nothing and says so.
5. R5. **Make searchable**: reads each page that has no text of its own, adds the words as
   invisible text over the picture (so search, select and copy work and the page looks the same),
   and saves "Name (searchable).pdf". Pages that already have text are left as they are. Progress
   shows page by page. The new file's text is picked up by Files search like any upload.
6. R6. In the Mac app, Make searchable uses the Mac's own Vision text reading; elsewhere the
   English model in the browser.
7. R7. **Redact**: draw boxes on pages, or type words to box every place they appear; boxes can be
   removed before saving. Saving turns each page with a box into a picture with the boxes painted
   solid black, reads it again so the rest stays searchable, and saves "Name (redacted).pdf".
   Nothing under a box (text, picture, link) is left anywhere in the file; pages without a box are
   copied as they are.
8. R8. Results land beside the original (same space and folder); the original is never changed. A
   message names the new file with Open.
9. R9. A PDF locked with a password says it can't be changed here.
10. R10. In the Mac app, PDFs dropped on the app's icon (or opened with it) upload to Personal
    files and open in PDF tools; two or more open on Pages with all of them added in order. Other
    files dropped there upload to Personal files and show them.
11. R11. Help center, landing page Files window, demo (the panel works on the demo's sample PDFs)
    and STATUS say what the tools do.

## Slices

1. `tools.ts` with tests: assemble, split ranges, names (R2, R3, R8, R9).
2. Panel with Pages and Split, saving beside the original (R1, R2, R3, R8).
3. Shrink (R4).
4. Make searchable, web and Mac Vision bridge (R5, R6).
5. Redact (R7).
6. Mac app: drop on the icon (R10).
7. Help, landing page, demo, STATUS (R11).
