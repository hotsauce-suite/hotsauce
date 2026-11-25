# @hotsauce/sign

The engine behind Sign: it stamps the filled fields onto a PDF, seals the PDF (PAdES,
ETSI.CAdES.detached) so any later change shows, writes the audit certificate, and keeps the audit
trail as a hash chain. It takes bytes and records and returns bytes; the server keeps envelopes in
Git and PDFs in Files. Plan: `docs/PLAN-sign.md`.

## Where the code comes from

`src/vendor/` is copied from [SignuDoc](https://github.com/NYLLON-SOFTWARE/signudoc) (commit of
2026-11-16, with its engine fixes up to 7fe0c01 of 2026-11-25), MIT licensed, copyright Nyllon Software; its licence is `src/vendor/LICENSE-SignuDoc`.
Each file keeps SignuDoc's own formatting (Biome skips the folder) so later fixes there can be
merged by hand. Hotsauce's changes are marked with `// Hotsauce:` comments:

- `pdf-fonts.ts`: fonts are found from the package, and the 14 MB CJK font is left out, so Chinese,
  Japanese and Korean text draws as "�" (plan R6).
- `pdf-finalize.ts`: no database, storage or settings; the caller hands in the bytes and the sealer.
  Certificates carry no product name.
- `audit.ts`: only the pure parts (wording, hash chain), reading a list instead of a table.
- The tests run on Vitest and read PDFs through `unpdf`. `pdf-page-geometry.test.ts` leaves out the
  import and signer-revision cases (Hotsauce has neither); `test/engine.test.ts` checks
  `readPdfPages` on the same kinds of page.
- `tsconfig.json` uses the ES2024 library, for `String.prototype.toWellFormed` in
  `whole-characters.ts`.

To bring later SignuDoc fixes across, diff each upstream commit's vendored files against its parent
and apply that patch here (`patch -F3`), then rerun the tests: see `docs/learnings/sign.md`.

Not copied: Postgres, Better Auth, Resend email, Vercel Blob, the screens, long-term validation
(timestamps, revocation data), FDA Part 11 and remote signing providers.

## Fonts

`fonts/` holds Noto Sans Regular and Bold and Great Vibes, under the SIL Open Font License 1.1
(licence texts beside them). They come from SignuDoc's `src/assets/fonts`.
