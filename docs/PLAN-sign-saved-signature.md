# Plan: upload and save your signature in Sign

Status (2026-11-25): built in one slice (R1–R10); merging in the PR for branch
`claude/project-thread-frkm3q`. Morgan accepted all six recommendations on 2026-11-25.

Like DocuSign's "adopt a signature": a member can upload a photo or scan of their own signature,
and save their signature and initials (typed, drawn or uploaded) to reuse with one click.

## Decisions (Morgan, 2026-11-25)

- Q1: "Upload" is a third tab beside Type and Draw in the signature box: pick a file (PNG, JPG,
  WebP, GIF; HEIC where the browser can read it, which includes Safari and the Mac app), drag
  one in, or paste one. A preview shows before it is used.
- Q2: cleanup is automatic: the paper becomes see-through, the ink blue-black, cropped to the
  ink. One "Ink" slider for faint pens or shadows. No rotate or manual crop in this version.
- Q3: signature and initials are each saved, however they were made. "Save for next time" is
  ticked by default; next time the box opens on the saved one, one click to use it.
- Q4: kept in the member's personal space (`.hearth/sign/saved.json`); a "Your signature" card on
  the Sign home page shows both, with Replace (Add) and Delete.
- Q5: people signing from an emailed link can upload, but not save (no account).
- Q6: the audit certificate says how each signature was made ("uploaded image") and whether it
  was the member's saved one.

## Requirements

- R1. The signature box has an Upload tab taking a file pick, a drop, or a paste. A picture the
  browser can't read, or over 25 MB, gets a plain message. (`SignaturePad.tsx`, `uploadSignature.ts`)
- R2. `cleanSignature` makes paper see-through and ink blue-black by comparing each pixel with
  its local paper brightness, so a shadow stays paper; crops to the ink ignoring specks; says
  when no ink is found or the picture is too dark; the Ink slider keeps fainter strokes as it
  rises. The PNG is at most 1200×400 and under the signature size limit. (`cleanSignature.test.ts`)
- R3. The server records an uploaded image as `input: uploaded` on the field and stamps it as
  it stamps a drawn one; an image sent with no `input` is `drawn`, as before.
  (`sign-saved.test.ts`)
- R4. The `signed` audit event carries `adoption`: for each signature and initials, how it was
  made and whether it equals the member's saved one, checked on the server. The certificate
  lists it, e.g. "signature: uploaded image, their saved signature". Drawn versus uploaded is what
  the signer's app says (a PNG can't prove how it was made); "saved" is checked by the server.
  (`sign-saved.test.ts`)
- R5. `GET /api/sign-saved`, `PUT` and `DELETE /api/sign-saved/:kind` (`signature`,
  `initials`) read and change the member's saved marks in their personal space; another member
  never sees them; a non-PNG, an over-size PNG or empty text is refused; a hand-broken file
  reads as nothing saved and saving mends it. (`sign-saved.test.ts`)
- R6. When a member signs, the box opens on Saved if they have one; Type, Draw and Upload show
  "Save as my signature for next time", ticked. Saving tells them it worked or didn't. Link
  signers see no Saved tab and no save box. (e2e `sign-saved-signature.spec.ts`)
- R7. The Sign home page shows "Your signature" with both marks and Replace/Add and Delete.
  (e2e)
- R8. The Mac app gets all of this from the web app: its window already answers file pickers
  (`SuiteWindow.swift` `runOpenPanelWith`) and WebKit reads HEIC.
- R9. The demo (`apps/web/src/mocks/signHandlers.ts`) saves and deletes marks in memory.
  (`signHandlers.test.ts`)
- R10. Help text and the landing page's Sign window say you can upload and save a signature.

## Not in this version

Rotating or hand-cropping a photo; saving for link signers; a saved signature per organization.
