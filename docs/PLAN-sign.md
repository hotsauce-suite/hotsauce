# Plan: Sign (send a PDF for signature)

Status (2026-11-17): slices 1 to 3 shipped and live (0.35.0; darker ink 0.39.1). Email via
Resend is on at Haven; Morgan's test email worked on 2026-11-17. Slice 3b (correct a
signer, copy an envelope; R19–R26) built and tested, merging in #186. Morgan called the plan done for
now: slices 4 and 5 (deadlines, reminders, cancelling, templates) are the next Sign work, not yet
started. Plan page for people: https://claude.ai/artifact/FvwFRznCcUskbBffkE4G24

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
R2. `makeSealer(identity, { name, productName })` gives a sealer that saves a PDF with one PAdES
    (ETSI.CAdES.detached) signature over the whole file, naming the product (white-label);
    changing or adding any byte after it makes the signature check fail.
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
    hash, signers, fields and the hash-chained audit trail; body: a readable copy of the trail).
    The seal key is `DATA_DIR/sign/seal.json`, made on the first seal (and kept by backups and the
    state mirror). Signing-link tokens are
    stored only as hashes. Reindexing rebuilds the Sign list from these files.
R8. (Build) the server depends on `@hotsauce/sign`, and the Dockerfile builds it before the server.
R9. Files has "Send for signature" on a PDF; the Sign app lists envelopes; a member places fields
    and signs in the app; the sealed PDF and certificate land in Files beside the original.

### Slice 3: people outside the team sign from a link

Recommended answers posted to Morgan on 2026-11-17 (signers in order or all at once; finished
copies attached; links last 30 days and can be resent; "Name via Org" from the mail address with
replies to the sender; Copy signing link until email is set up; decline with a reason; people who
only get a copy). Built on those; changed if he answers otherwise.

R10. A draft has a list of people: each signs, or only gets a copy, with a name and email; the
     sender is on it by default and can be removed. Signing is all at once (default) or in order.
R11. Sending gives each signer a link `/signing/<envelope id>.<signer id>.<secret>`; only the secret's
     SHA-256 is stored, it works for 30 days, and the sender can make a fresh one (the old stops).
R12. A `Mailer` interface sends email; Resend implements it (`RESEND_API_KEY`, `MAIL_FROM`), from
     "<sender> via <org>", replies to the sender. Without a key, Send still works and the sender
     copies each link. Tests use a fake mailer.
R13. In order, only the first person still to sign gets a link; the next is emailed when they sign.
R14. The signing page needs no account: it shows the PDF and only that signer's fields, asks for
     consent, and signs or declines (with a reason). A wrong, old or used link says so plainly.
     The link's 256-bit secret is the gate, so there is no robot check (Turnstile); the page sends
     no referrer, so the secret never leaves in a link click.
R15. The audit trail records sent, viewed, consented, signed and declined, with time, address and
     browser, and how the signer was checked ("Email link").
R16. Declining stops the envelope; the sender is emailed. When the last signer signs, the envelope
     completes as in slice 2 and everyone on it (signers and copies) gets the sealed PDF and
     certificate attached.
R17. The sender sees each person's state on the envelope page (waiting, sent, viewed, signed,
     declined) and can copy or resend a link.
R18. Help page, landing card, demo, STATUS, self-host (RESEND_API_KEY, MAIL_FROM) match.

### Slice 4 and 5 (later, requirements written when each starts)

Verify page, deadlines, reminders, void, access codes; templates, For you, Today tile, Ask/MCP
tools, support materials (site, demo, help, STATUS, ARCHITECTURE).

## Plumbing

- Morgan: Resend account, the mail subdomain's DNS records and the Resend key as a Fly secret
  (steps page above), plus `MAIL_FROM` as a Fly secret. Until then Send gives links to copy.
- None for slices 1 and 2.
