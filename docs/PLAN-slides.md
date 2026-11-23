# Present a Doc as slides

## Status

Built (2026-11-23); every requirement has a test (format, server integration, web unit, e2e/slides.spec.ts; Mac bridge in DictateCoreTests). Still to check by hand: a real external display on the Mac. Decided with the owner: a deck is an ordinary Doc split into slides, not
a separate editor, so decks stay searchable, versioned and readable by Ask. PowerPoint download is
later, not now.

## Why

Teams present from the same documents they write. Copying a doc into a slide tool makes a second
copy that drifts. Presenting the Doc itself keeps one copy, in Git, with its history.

## How it works

`packages/format/src/slides.ts` splits a doc's body into slides: a line that is only `---` (outside
a code block) ends a slide. A doc with no such line starts a new slide at each `##` heading, with
whatever comes before the first one as the first slide. A line starting `Notes:` begins that
slide's speaker notes: everything under it, to the end of the slide, is for the presenter only.

The web app renders each slide with the reading view's Markdown (images, tables, code, task lists)
in a fixed 16:9 frame (1280×720 CSS pixels, scaled to fit), in the brand's fonts and colour.

Presenting has two layouts. **Slides** fill the screen. **Presenter view** shows the current slide,
the next one, the notes, a timer and the clock, and drives a second window that shows the slides:
the page opens it with `window.open` and renders into it with a React portal, so both share one
state and nothing has to sync. The browser picks presenter view by itself when
`window.screen.isExtended` says there is a second screen; P switches between the two either way.

The Mac app catches that window (`about:blank#hotsauce-slides`) in `createWebViewWith`, puts it
full screen on the external display, and keeps the presenter view in the main window. With one
display it makes the main window full screen instead, through the `hotsauceSlides` bridge.

Draft slides: `POST /api/slides/draft` sends the doc to the AI and gets a deck back; the page saves
it as a new doc "<title> slides" beside the original and opens it.

The PDF reuses the Word/PDF download (docs/PLAN-doc-download.md): one 16:9 page per slide, notes
left out.

## Requirements

1. R1. `---` on its own line splits slides; `---` inside a code block, and the frontmatter's
   fences, never do.
2. R2. A doc with no `---` splits at each `##` heading; a doc with neither is one slide.
3. R3. A `Notes:` line starts the slide's notes; the audience never sees them.
4. R4. A doc's top bar has Present, and ⌘K has Present and Presenter view; the show starts at
   slide 1.
5. R5. → / Space / PageDown / click go forward; ← / PageUp / Backspace go back; Home and End go to
   the first and last; a number then Enter jumps to that slide; Esc leaves.
6. R6. Presenter view shows the current and next slide, the notes, the slide count, a timer that
   can be paused and reset, and the clock; it drives the slides window.
7. R7. L turns the laser pointer on and off: a red dot follows the pointer over the slide, and in
   presenter view the slides window shows it in the same place.
8. R8. B blacks the screen out, and any key brings it back.
9. R9. Draft slides (⌘K and the Present menu) makes a new doc "<title> slides" beside the doc from
   an AI draft, and opens it. Without the AI key it says AI isn't set up.
10. R10. Download slides as PDF gives one 16:9 page per slide, without the notes.
11. R11. Mac app: Present with an external display puts the slides full screen on it and the
    presenter view on the laptop; with one display, the window goes full screen. Esc or closing
    either one ends the show. View → Present (⌘⌥P) presents the open doc.
12. R12. Help, the landing page and the live demo say so.

## Slices

1. Splitting (R1–R3) in `packages/format`.
2. Present mode (R4, R5, R8) and the top bar button.
3. Presenter view, second window and laser (R6, R7).
4. PDF (R10).
5. Draft slides (R9).
6. Mac app (R11).
7. Help, landing page, demo (R12).
