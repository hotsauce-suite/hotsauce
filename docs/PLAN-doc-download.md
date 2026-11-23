# Download a Doc as Word or PDF

## Status

Shipped (2026-11-23, PR #227). Known gap: in Word, a quote that holds a list or code loses its side bar. Decided with the owner: the items sit in the Share menu under the copy
items, meeting notes get them too, files carry the brand's fonts, colour and logo, the Mac app has
File → Export… (⌘⇧E) with a Format choice in its save window, task lists come out as their tasks
at download time and whiteboards as a picture.

## Why

People send Docs to people outside the team, who expect a Word file or a PDF. Copy as rich text
loses the look and the images; a file keeps both.

## How it works

The browser builds the file, because it already has everything a Doc shows: the text, its images
(through the API), live task lists and whiteboard pictures. `apps/web/src/lib/download/` turns the
Markdown (remark, GFM, callouts as quotes) into a Word file with the MIT `docx` library or a PDF
with the MIT `pdfmake` library. Both are loaded only when someone downloads.

Fonts: Word can't embed WOFF2 (what browsers get from Google Fonts), so the server serves the
brand's fonts as TTF at `GET /api/org/fonts?family=&weight=400|700&style=normal|italic`, fetched
from Google Fonts once and kept in memory, and only for the families the brand wizard offers.
Without the network the file falls back to Helvetica/Times in the PDF and to the font names alone
in Word.

The Mac app shows its own save window: the page hands the bytes to the `hotsauceSaveFile` handler.

## Requirements

1. R1. The Share menu of a doc and of a meeting note has Download as Word and Download as PDF.
2. R2. The Word file carries headings, paragraphs with bold, italic, strikethrough and code, links
   (clickable; links to other docs point at the doc in Hotsauce), bullet, numbered and task lists
   (nested), quotes and callouts, code blocks, tables, rules and images.
3. R3. The PDF carries the same.
4. R4. Frontmatter never appears in either file.
5. R5. Headings use the brand's display font, text its UI font, links and table headers its
   primary colour; the logo (or mark) sits at the top of page one; pages are numbered.
6. R6. Word files embed the brand fonts when the server could fetch them.
7. R7. `GET /api/org/fonts` serves only brand-wizard families, fetches each once, and answers 404
   (trying again next time) when Google Fonts can't be reached.
8. R8. A `tasks` block comes out as its tasks at download time with checkboxes; a whiteboard
   embed comes out as a picture of the board.
9. R9. The file is named after the doc's title.
10. R10. In the Mac app, the Download items and File → Export… (⌘⇧E) open the Mac save window;
    Export… has a Format choice (Word or PDF) that remembers the last pick. With no doc open,
    Export… says to open one.
11. R11. Offline, a download says it needs a connection (the Share menu is off offline anyway).
    Online but without Google Fonts, the files fall back to standard fonts.

## Slices

1. Server font route (R7).
2. Markdown → Word (R2, R4, R5, R6, R9) and the Share menu items (R1).
3. Markdown → PDF (R3, R5).
4. Task lists and boards (R8).
5. Mac save window and Export… menu (R10).
6. Help, landing page, demo.
