# Plan: links an AI tool saves wait for a person

Status (2026-11-16): built; every requirement has a test (R1 to R5 in `apps/server/test/integration/links.test.ts`, R6 in `apps/web/src/apps/links/links.test.tsx`, R7 in the MCP test there, R8 in the API tests there). Follow-up from the second audit ("Not fixed here" in
`docs/PLAN-audit-2.md`), approved by Morgan on 2026-11-16. He chose a button over fetching when the link is opened (Q1).

`save_link` through the connector made the server fetch any public address straight away. A tool
that was tricked (by a page or a document it read) could put private text in an address, for
example `https://attacker.test/?q=<the text>`, and Hotsauce's own request would send it out. The
server now visits an address an AI tool saved only after a member asks for it in the app.

## Requirements

R1. A link saved through the connector (`source: mcp`) is committed as before, but its page is not
    fetched. It reads as `status: 'waiting'`, with no error, and stays waiting across restarts (no
    "lost after 3 minutes" failure).
R2. The member gets the page with "Get the page" (`POST /api/links/:space/:id/refetch`, signed-in
    session only). It is fetched once, then reads like any other link.
R3. A member saving the same address themselves (web, extension, share sheet, Shortcut) counts as
    asking: the waiting link is read, from the browser's copy when the extension sent one, and
    from the address the member gave (the AI tool's address may differ in parts that matching
    ignores, such as `utm_*` or the `#hash`, and carry text there).
R4. The connector saving an address that is already saved never makes the server fetch, whatever
    state the existing link is in.
R5. Sharing a waiting link with the team (or back) leaves it waiting; nothing is fetched.
R6. The Links list and the reader show a waiting link with its full address, who saved it ("an AI
    tool"), and a "Get the page" button. Nothing on those screens fetches by itself.
R7. `save_link`'s description tells the AI tool the page waits for the member, so it doesn't loop
    or retry.
R8. A save over the HTTP API with an access token (what AI tools and scripts use, the connector
    included) is stored as `source: mcp` whatever source it claims, and "Get the page" refuses an
    access token: only a signed-in session can ask.

## Not covered

- An AI tool that writes a `links/<id>.md` file through `write_file` with another `source` gets a
  link that reads as failed after 3 minutes; "Try again" is still a member's click, and so is
  "Share with team", which reads a link that was never read.
- "Open the original" opens the address in the member's own browser. The reader shows the full
  address before that click.
