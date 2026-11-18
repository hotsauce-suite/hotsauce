# Themes from a prompt

## Status

Building (2026-11-18). Decisions settled with Morgan in the thread "Create themes from an AI prompt"
(he accepted every recommendation of round 1).

## What it is

Settings → Appearance gets a box: describe a look ("1970s terminal", "soft pastel notebook"). The
whole app restyles at once as a preview. Follow-ups refine it ("darker", "less orange"). **Keep**
saves it as a theme beside System, Light and Dark; **Discard** puts the old look back.

## Decisions

- A theme changes colours and fonts only (Google Fonts), never spacing, radii or layout.
- One fixed look per theme (a light or a dark one), not a light/dark pair.
- Personal: only its maker sees it. Saved to the account (server), so it shows up on every device;
  which look is in use stays a per-browser choice, as Light and Dark are today.
- Preview first, Keep or Discard.
- Hotsauce fixes unreadable colours itself, quietly.
- Rename and delete; at most 12 themes a member.
- No AI on the instance: the box is hidden and a line says why; saved themes still work. The live
  demo answers with canned themes.

## Requirements

- **R1** Appearance lists System, Light, Dark, then each saved theme with a swatch of its colours.
  Picking one applies it at once.
- **R2** `POST /api/themes/generate { prompt, base? }` returns `{ theme }` (a name and the palette)
  and saves nothing. `base` is the previewed theme a follow-up refines.
- **R3** The prompt is untrusted: the answer must parse as a theme (`parseTheme`); anything else is
  `bad_request` ("Couldn't make a theme from that…") and nothing changes.
- **R4** Every colour the app reads comes out readable: `fixContrast` moves foregrounds' lightness
  until each pair in `CONTRAST_PAIRS` meets its ratio (body text 4.5, faint text and the accent
  3). Property test: any palette at all passes after the fix.
- **R5** Keep: `POST /api/themes { name, prompt, theme }` saves it to the account store; `GET
  /api/themes` lists the member's own, newest first; `PATCH /api/themes/:id { name }` renames;
  `DELETE /api/themes/:id` deletes. Another member's id is 404.
- **R6** At most 12 themes a member: the 13th is 409 `conflict`; the page says to delete one.
- **R7** Fonts are Google Fonts family names (letters, digits, spaces); the app loads them and
  falls back to the usual serif/sans stacks.
- **R8** No flash: the theme in use is cached in this browser and applied by `index.html` before
  the first paint.
- **R9** Deleting the theme in use returns this browser to System.
- **R10** `GET /api/themes` says `canGenerate: false` when the instance has no AI; the page hides
  the box and says an admin can add an Anthropic key.
- **R11** The live demo generates canned themes picked by words in the prompt.
- **R12** A theme beats the organization's brand colours while it's in use.

## Slices

1. `@hotsauce/format` theme: schema, parse, contrast fix, CSS tokens (unit + property tests).
2. Server: account store table, generate (prompt, fake LLM answer), CRUD routes (integration tests).
3. Web: apply/cache, Appearance picker, prompt box with preview, rename/delete (component tests,
   one e2e journey).
4. Demo mocks, help page, STATUS, learnings.
