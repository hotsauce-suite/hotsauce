# Plan: PDFs and papers in saved links

Status (2026-11-16): building. Step 4 of the Links roadmap Morgan accepted on 2026-11-15 (ideas
drawn from Omnivore, AGPL, so ideas only: no code from it). Built on the recommendations in the
thread (Q1 to Q8) while Morgan answers; change here if he picks otherwise.

Save a PDF or a paper and read it like any other link: the PDF itself is kept in Files, its text
becomes the readable copy (so highlights, notes, the reading place, search, Ask and Briefcast all
work), and arXiv, bioRxiv and medRxiv papers come with their authors, date and abstract.

Recommended in the thread: the PDF goes in the member's Files, folder "Links", and moves and is
deleted with its link (Q1); the reader opens the text copy, with Open PDF for the real pages (Q2);
arXiv's web version is the copy when it has one, else the PDF's text, and the abstract stands in
for the AI summary (Q3); bioRxiv and medRxiv come through their official API and full-text XML,
and only a browser can fetch their PDF (Q4); one paper is one link whatever its address (Q5); a PDF
from the computer can be added on the Links page (Q6); highlights are on the text copy only (Q7);
PDFs up to 50 MB, a scanned PDF is kept with "no text" and Open PDF, no text recognition (Q8).

Facts checked on 2026-11-16 from a cloud machine: `arxiv.org/abs|pdf|html/<id>` and
`export.arxiv.org/api/query` answer a server; `www.biorxiv.org` and `www.medrxiv.org` pages and
PDFs answer a server with Cloudflare's "error code: 1015" or a challenge page, while
`api.biorxiv.org/details/<server>/<doi>` (JSON) and the `jatsxml` address it gives (the full text
as JATS XML) answer normally.

## Requirements

R1. Link frontmatter gains `file` (the id of a Files pointer in the same space holding the PDF),
    `paper` (`arxiv:<id>`, `biorxiv:<doi>` or `medrxiv:<doi>`), `version` (the paper version
    read), `authors` (up to 50 names), `published` (YYYY-MM-DD), `doi` and `abstract` (up to
    5,000 characters). All optional; unknown keys still pass through. `url` may be empty when
    `file` is set (a PDF added from the computer).
R2. `paperOf(url)` recognizes arXiv (`arxiv.org` and `export.arxiv.org`, `abs|pdf|html/<id>`,
    new ids `2401.01234` and old ones `hep-th/9901001`, with or without `vN` or `.pdf`) and
    bioRxiv/medRxiv (`/content/10.1101/<…>` with or without `vN`, `.full`, `.full.pdf`,
    `.full-text`, `.abstract`). Saving any address of a paper already saved finds the saved link
    (Q5), whatever form either address took.
R3. Any address that answers with a PDF (by content type, or `application/octet-stream` with a
    `.pdf` path or `%PDF` start) is downloaded up to 50 MB through the same safe fetch as pages.
    The PDF goes into Files in the link's space, folder `Links`, named after the title; the
    readable copy is its text, joined into paragraphs (lines rejoined, hyphenated words mended,
    page numbers and repeated running heads dropped); the title is the PDF's own title, else the
    first line. Over 50 MB the link keeps "The PDF is too big to keep (over 50 MB)".
R4. arXiv: the title, authors, abstract, date and DOI come from the arXiv API; the copy from
    `arxiv.org/html/<id>` when arXiv has one, else the PDF's text; the PDF is always kept.
R5. bioRxiv and medRxiv: the details (newest version) from `api.biorxiv.org`, the copy from its
    JATS full text (sections as headings, paragraphs, lists, figure and table captions as text,
    references dropped). No PDF is kept unless one is added (R6).
R6. `POST /api/links/pdf?name=&space=` with the PDF's bytes (≤ 50 MB, must start `%PDF`) saves a
    link with no address and the PDF, read from the kept file. A signed-in member only (an access
    token gets 403). 201 with the link. The Links page has "Add a PDF" next to the paste box, and
    a PDF dropped on the page does the same. `POST /api/links/:space/:id/pdf` puts a PDF on an
    existing link that has none (a bioRxiv paper: "Add the PDF" in the reader); its text becomes
    the copy only when the link has none.
R7. Share with team and Make private move the PDF to the same space (still in `Links`); Delete
    moves its pointer to the trash with the link. A link whose PDF is missing still opens.
R8. "Get the page again" on a link with no address reads its kept PDF again; on a web PDF it
    downloads again and keeps one PDF (the old one goes to the trash when the new one differs).
R9. Papers: the AI is asked for tags only; the abstract is the summary shown in the list. An AI
    tool's save (`source: mcp`) still waits for a member before anything is fetched.
R10. Reader: "Open PDF" opens the kept PDF in Hotsauce's preview; a paper shows its authors
    (first three, then "and N more"), date, server and DOI, and its abstract above the copy. A PDF
    with no text says "This PDF has no text to read (it may be scanned)" with Open PDF. Highlights,
    notes and the reading place work on the copy as on any link.
R11. The list marks a link with a PDF ("PDF") and a paper ("arXiv", "bioRxiv", "medRxiv").
R12. MCP `get_link` and `list_links` carry the paper details and whether a PDF is kept; the PDF's
    text is the link's copy. Search finds a paper by its authors and abstract.
R13. Support materials: the demo has a paper link with a PDF, the help page and landing page
    describe PDFs and papers, STATUS and ARCHITECTURE §23 match.

## Slices

1. Format: R1, R2 (pure, unit tests first).
2. Server: PDFs from any address (R3, R7, R8) with the fake fetcher serving a real small PDF.
3. Server: arXiv and bioRxiv/medRxiv (R4, R5, R9) with stand-in API answers.
4. Server: upload (R6) and MCP (R12).
5. Web: reader, list, upload, drop (R6, R10, R11); e2e journey "add a PDF and highlight it".
6. Support materials (R13).

## Not in this round

Highlighting on the PDF pages themselves; text recognition for scanned PDFs; a Copy citation
button; PubMed and journal sites; the Chrome extension sending a bioRxiv PDF from the browser
(a new extension version and store review; "Add the PDF" covers it meanwhile).
