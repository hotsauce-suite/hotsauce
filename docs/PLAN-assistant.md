# Plan: the built-in assistant ("Ask <workspace>")

## Status

- 2026-11-13: decisions settled with Morgan (all nine recommendations accepted).
- 2026-11-13: slices 1–7 built in PR #45 (server loop, panel, chip, Undo, Confirm, history,
  Settings, demo stand-in, help and landing page). Every requirement has a test.
- Open: the Command-K "Ask the assistant" item waits for the keyboard thread's command registry;
  ⌘J is already in the shortcut list (`global.assistant`). There is no top bar, so the panel's
  button sits in the bottom-right corner.

## What it is

A chat panel on every page that answers questions about everything in the instance and can
work with the member's files. It runs the instance's own MCP tools (ARCHITECTURE §8.2)
in-process, as the member who asks, so it can do in the app exactly what Claude can do when a
member connects it from outside, and nothing more. The instance's Anthropic key pays for it;
there is no new provider or key.

## Decisions (Morgan, 2026-11-13)

1. A panel on every page, opened with ⌘J (Ctrl+J) or a button (bottom-right, as there is no top bar). Command-K gets an "Ask
   the assistant" command that hands what was typed to the panel (lands on the keyboard
   thread's command registry; until then the panel binds ⌘J itself).
2. Named "Ask" + the workspace name ("Ask Haven"), else "Ask" + the product name.
3. Reads run freely. Creates and edits run at once and show Undo. Deleting and moving files
   wait for the member's Confirm.
4. It sees the item open on the page (a removable chip in the panel).
5. Conversations are kept, visible only to their owner, out of search, and deletable.
6. Model `ASSISTANT_MODEL`, default `claude-sonnet-5-5`; admins can choose Opus in Settings.
7. Settings shows admins this month's usage per member; an optional monthly limit per member.
8. v1 is in-app and acts only when asked (no texting, no proactive nudges).
9. No web access in v1.

## Design

- `apps/server/src/assistant/`
  - `toolbox.ts`: builds the member's MCP server (`createMcpServer`), connects an MCP `Client`
    over `InMemoryTransport`, and exposes the tool list as Anthropic tool definitions plus
    `call(name, input)`. One toolbox per request. No tool is duplicated.
  - `model.ts`: `AssistantModel` (one streamed model turn). `AnthropicAssistantModel` uses the
    beta Messages stream with refusal fallbacks; `FakeAssistantModel` (dev, tests, demo) runs
    a scripted search-then-answer turn so the loop is exercised without a key.
  - `agent.ts`: the loop: model turn, run its tool calls (in parallel), feed results back,
    up to 20 turns. Emits events (text, tool start/end, confirm, done, error).
  - `store.ts`: `DATA_DIR/assistant.sqlite` (backed up nightly with the other stores):
    conversations (owner, title, raw API messages, display transcript) and monthly usage.
    Private chat history is per-member state like Dictate's history, not workspace content,
    so it is not committed to Git and never indexed.
- API `/api/assistant/*`: `POST /conversations/:id/messages` streams Server-Sent Events;
  list/get/delete conversations; `POST /confirm` runs a confirmed delete/move; `POST /undo`
  restores files changed by one tool call; `GET /usage` (admin) and settings.
- Web: `components/assistant/` panel mounted once in the app shell; `openAssistant(prompt?)`.

## Requirements (each maps to a test)

R1. The assistant answers with the member's own access: a tool call for a space the member
can't see fails, and search covers only their visible spaces. (integration)
R2. Tool calls stream to the client as events, and the final answer streams as text. (integration)
R3. The loop stops after 20 model turns and says so. (unit)
R4. With no Anthropic key (`LLM_PROVIDER=none`) the panel says the assistant needs a key and
the API answers 503 `not_configured`; nothing crashes. (integration)
R5. ⌘J opens and closes the panel on every page; the panel is named "Ask <workspace>". (e2e)
R6. Asking a question shows tool activity and an answer with links to the files used. (e2e)
R7. The open doc/meeting is sent as context and shown as a removable chip. (unit + e2e)
R8. A write tool's result offers Undo; Undo restores each touched file to its previous
version as a new commit by the member. (integration)
R9. delete_file, move_file, share_link and publish_page never run without Confirm (save_link is left out); Confirm runs exactly that call. (integration)
R10. Conversations are listed, reopened and deleted by their owner only. (integration)
R11. Usage is recorded per member per month; an admin sees it; a member over the limit gets
429 `rate_limited` with a plain message. (integration)
R12. Model and limit are admin settings; non-admins can't change them. (integration)

## Slices

1. Server loop over the MCP tools, fake model, SSE endpoint (R1–R4).
2. Panel, ⌘J, corner button, streaming render, file links (R5, R6).
3. Page context chip (R7).
4. Undo for writes, Confirm for delete/move (R8, R9).
5. Saved conversations list (R10).
6. Usage, limit and model in Settings (R11, R12).
7. Support materials: landing page, demo data, README, self-host and MCP docs.
