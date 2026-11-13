# Learnings: the assistant (Ask)

- **Reuse the MCP server in-process instead of writing tools.** `InMemoryTransport.createLinkedPair()` plus an MCP `Client` turns `createMcpServer(deps, principal)` into the assistant's whole toolbox, with the member's exact access and the tools' own descriptions. The `readOnlyHint` annotation is enough to tell reads from writes.
- **Flush SSE writes in order before the stream closes.** `streamSSE` closes when the handler returns; events written from callbacks without awaiting them were lost (the error event most often). Chain every `writeSSE` onto one promise and await it at the end.
- **Run write tools one at a time if each gets its own Undo.** Two parallel writes made overlapping "changed since" records, and the second Undo then refused with 409. Reads can stay parallel.
- **Undo should only look at the member's own commits.** Taking every path changed since the snapshot picks up a teammate's edit made in the same second; filter `git log` by the member's email.
- **Markdown links to paths with spaces break.** `[t](hearth:team/My doc.md)` isn't a link; `[t](<hearth:team/My doc.md>)` is. react-markdown also drops unknown schemes unless `urlTransform` keeps `hearth:`.
- **The fake model's search must not AND every word.** Real search requires all terms, so "where is the X rollout?" found nothing. The stand-in searches the two longest non-filler words.
- **Copy request arrays in test doubles.** The agent appends to the same `messages` array after each turn, so a scripted model that stored the reference saw the final state for every turn.
- **`BetaMessageStreamParams` is imported from `@anthropic-ai/sdk/resources/beta/messages/messages`**, not from the `Anthropic.Beta.Messages` namespace.
- **Register keys in `keyboard/catalog.ts`.** Since the shortcut list landed, a page binds with `useShortcut(id, run)`; a separate `keydown` listener would fight the one listener and miss the `?` sheet. Use `formatSpec('mod+j')` for labels so Windows shows Ctrl+J.
- **The help center's search text (`data-k` in `site/public/help/index.html`) is hand-kept.** It's the page's main text, lowercased, tags stripped, capped at about 1,500 characters. Regenerate it when a page changes.
- **`meetings.test.ts` "picks up an unsaved session after a restart" can fail under a full local `pnpm test`** (segments come back out of order). It doesn't touch the assistant, passes alone and in CI. Re-run it alone before chasing it.
