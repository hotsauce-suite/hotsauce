# Plan: Sign (send a PDF for signature)

Status (2026-11-16): slice 1 in progress (draft PR). Morgan accepted all seven recommendations
(Q1 to Q7) on 2026-11-16. Plan page for people: https://claude.ai/artifact/FvwFRznCcUskbBffkE4G24

Send a PDF for signature from Hotsauce. People inside or outside the organization sign it from a
link on any device, with no account. The sealed PDF and its audit certificate are kept in Files.

The signing engine (stamping fields onto the PDF, the PAdES seal, the audit certificate, fonts) is
copied from SignuDoc (https://github.com/NYLLON-SOFTWARE/signudoc, MIT, checked 2026-11-16) into
`packages/sign/src/vendor/`, with its notice kept. The screens, storage and email are Hotsauce's own.

## Decisions (Morgan, 2026-11-16)

- Q1: copy SignuDoc's engine, build our own screens (not a second site, not a rewrite).
- Q2: a new **Sign** app in the rail, plus "Send for signature" on a PDF in Files; sealed copies
  are saved back into Files next to the original.
- Q3: the first usable version includes people outside the organization signing from an emailed
  link with no account.
- Q4: email goes through Resend, from a mail subdomain (Haven: `mail.havenbiosec.com`).
- Q5: the seal uses a certificate the server makes itself; a bought, trusted one can come later.
- Q6: an envelope is private to its sender (personal space), with a choice to share it with the team.
- Q7: no FDA Part 11 mode, no EU qualified signatures, no Docs-to-PDF in the first version.

## Requirements

### Slice 1: the engine (`packages/sign`)

R1. `@hotsauce/sign` exports `createSealIdentity({ commonName, organization })`: a fresh RSA key
    and a self-signed certificate valid 20 years, as PEM.
R2. `sealPdf(document, identity, options)` returns PDF bytes carrying one PAdES (ETSI.CAdES.detached)
    signature over the whole file; changing any byte after it makes the signature check fail.
R3. `renderSignedPdf({ source, envelope, signers, fields, images }, seal)` stamps every filled field
    (signature typed or drawn, initials, date, text, number, checkbox, dropdown, radio) onto the
    source PDF at its page and position, flattens any form, and seals it. It refuses a source whose
    SHA-256 differs from the envelope's recorded hash.
R4. `renderCertificate({ envelope, signers, auditEvents, signedPdfSha256 }, seal)` returns a sealed
    audit certificate listing each signer, how they were checked, every event with its time, and
    the fingerprints of the source and signed PDFs. A recipient copy hides IP addresses and browsers.
R5. `auditRowHash(previousHash, event)` and `verifyAuditChain(events)` make and check a hash chain
    over the audit events; editing, removing or reordering any event fails the check.
R6. Latin, Greek and Cyrillic names and text are drawn correctly. Chinese, Japanese and Korean are
    left out for now (SignuDoc's CJK font is 14 MB); such text is replaced, never dropped silently.

### Slice 2: sign it yourself (later)

R7. An envelope is one file in Git (`sign/<id>.md`, frontmatter: title, status, source file id and
    hash, signers, fields; body: the audit trail, one event per line). Signing-link tokens are
    stored only as hashes. Reindexing rebuilds the Sign list from these files.
R8. Files has "Send for signature" on a PDF; the Sign app lists envelopes; a member places fields
    and signs in the app; the sealed PDF and certificate land in Files beside the original.

### Slice 3 to 5 (later, requirements written when each starts)

Email (Resend behind a `Mailer` interface), the public signing page (Turnstile, consent, decline),
signing order and copy recipients; Verify page, deadlines, reminders, access codes; templates,
For you, Today tile, Ask/MCP tools, support materials (site, demo, help, STATUS, ARCHITECTURE).

## Plumbing

- Morgan: Resend API key (Fly secret), DNS records for the mail subdomain, the Turnstile secret
  (already owed). Needed from slice 3.
- None for slices 1 and 2.
