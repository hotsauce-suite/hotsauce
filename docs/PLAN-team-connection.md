# Plan: team-only connections for shared AI tools

## Status

- 2026-11-17: plan written; waiting on the owner's answers (questions 1–5 below, recommendations
  assumed). Nothing built yet.

## Why

A team chat's AI assistant (Ember's @ember, and anything like it) connects to Hotsauce's MCP server
once, with one member's sign-in, and then answers everyone in a room. Today every connection has
the full access of the member who signed in, personal space included, so people in the room would
read through that member's personal space, calendar and agent brief.

Ember already separates the two cases: a room uses the administrator's shared sign-in, and a person
who signs in to the app themselves gets their own connection, used only in their direct
conversation with the assistant. Hotsauce needs a connection kind that is safe to share.

## Decisions

1. A shared connection sees the team space only and is read only. (Owner: pending, recommended.)
2. A person's own connection keeps today's full access. (Pending, recommended.)
3. What a team-only connection can use: `list_spaces` (team only), `search`, `list_files`,
   `read_file`, `file_history`, `list_meetings`, `get_meeting`, `ask_meetings`, `list_tasks`,
   `list_tables`, `read_table`, `list_boards`, `read_board`, `find_person`, `get_person`,
   `list_drive_files`, `get_drive_file`, `list_clips`, `get_clip`, `list_checkins`,
   `get_checkin`, `list_pages`, `get_page`, `get_brand`, and the chat tools `search_chat` and
   `read_chat` once they land (PR #171; chat content is team-wide). Never: calendar, agent brief, links and
   highlights, notes (personal by nature), and every tool that writes. (Pending, recommended.)
4. The choice is made on the Allow page by the person signing in, not by the tool: Hotsauce can't
   tell a shared sign-in from a personal one.

## Requirements

- **R1.** The Allow page offers two choices: "Everything you can see" and "Team space only, read
  only (for a tool many people share, like a team chat)". Nothing is preselected; Allow stays
  disabled until one is picked.
- **R2.** The choice is stored on the connection (`access: 'full' | 'team-read'`; connections
  stored before this read as `full`) and survives refresh-token rotation.
- **R3.** A team-only connection's principal carries `via.access = 'team-read'`.
- **R4.** For that principal, `visibleSpaces` is the team space only and `canAccess` refuses every
  other space (`forbidden`), so searches, lists and Ask cover the team space only.
- **R5.** The MCP server built for that principal lists only the tools in decision 3; a call of any
  other tool is unknown to it. Its instructions say it is a shared, team-only, read-only view.
- **R6.** Team-only access holds for any route a connection token reaches (today `/mcp` only), so a
  later route can't widen it by accident: tested at the auth boundary.
- **R7.** Settings → Connections lists team-only connections with a "Team only" label.
- **R8.** Personal access tokens are unchanged (full access).
- **R9.** Docs: `docs/mcp.md` (new section "Connecting a shared tool, like a team chat"),
  `docs/ARCHITECTURE.md` §8.4, the help center page on AI tools, `docs/STATUS.md`.

## Slices

1. Store and principal: R2, R3, R4, R8, with unit tests on `OAuthStore` and `SpaceService`.
2. MCP tool list: R5, R6, with an integration test that a team-only connection lists only the
   allowed tools and gets `forbidden` for a personal space.
3. Allow page and Settings label: R1, R7, component tests and one end-to-end run of the Allow
   page choosing "Team space only".
4. Docs and help: R9.

## Not in scope

- Telling Hotsauce which chat person asked (Ember doesn't send it).
- Chat messages inside Hotsauce (the other direction; its own plan).
- Hiding team content from guests in a chat room: Hotsauce can't see room membership.
