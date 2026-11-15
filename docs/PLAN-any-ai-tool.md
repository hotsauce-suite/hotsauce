# Plan: connect any AI tool to Hotsauce

Hotsauce's MCP connector used to read as Claude-only. Any MCP client that speaks Streamable HTTP
and can send a bearer token (Claude Code, Claude desktop, Cursor, Codex, scripts) works today;
ChatGPT and Grok connect only through a browser sign-in (OAuth), which another thread is adding.
This plan makes the setup, the history and the wording tool-neutral.

## Status

- Built on `feat/any-ai-tool`, PR #92 (Nov 14 2026). R1–R6 done; each maps to the tests named
  below. The client name is remembered in memory, so it resets on a server restart (see
  `docs/learnings/mcp.md`).
- Not updated: `docs/screenshots/*-docs-*.webp` and the Docs loop video still show the small
  "from Claude" label beside Pages in the sidebar (now "from AI tools"). No script records them;
  refresh them with the next Docs re-record.
- Out of scope: OAuth "managed sign-in" (its own thread). ChatGPT and Grok show "Needs sign-in,
  coming soon" until it lands.

## Requirements

**R1. Neutral Settings section.** The token section's heading reads "Connect an AI tool to
{product}". The intro names no single vendor ("an AI tool such as ChatGPT, Claude, Grok or Cursor,
or a script"), and says everything it writes is saved under your name, marked with the tool that
made it. The agent brief line says "your AI tool reads your agent brief first". The token name
field starts empty with a placeholder.
*Test:* component test on the Settings token section (heading, intro, empty name).

**R2. Per-tool steps.** After a token is made, a row of buttons (Claude Code, Claude desktop,
ChatGPT, Grok, Cursor, Codex, Other) picks one tool; only that tool's steps show, with copy blocks
filled in with this server's address and the new token. Claude Code and Claude desktop keep
today's exact commands. Cursor: `~/.cursor/mcp.json` with `url` and an `Authorization: Bearer`
header. Codex: `~/.codex/config.toml` `[mcp_servers.hotsauce]` with `url` and
`bearer_token_env_var` (checked against the Codex docs, Nov 14 2026), plus the `export` line.
Other: the server URL and the header, noting the tool must support remote MCP over Streamable
HTTP. ChatGPT and Grok: "Needs sign-in, coming soon", no token steps. The connector name stays
`connectorName()` everywhere.
*Test:* exact-string unit tests for every builder in `apps/web/src/api/tokens.ts` (JSON parses);
component test for the picker; the Settings e2e journey.

**R3. The tool's name on every MCP write.** The server reads the client's `clientInfo.name` from
the `initialize` handshake. The server is stateless (one per request), so it remembers the name
per token (or per member without a token) from the last `initialize`, in memory. Writes carry
`Hearth-Via: mcp (client "Cursor", token "My laptop")`. Known raw names map to friendly ones
(claude-code → Claude Code, claude-ai → Claude, openai-mcp / ChatGPT → ChatGPT, cursor → Cursor,
codex-mcp-client → Codex, `claude-ai (via mcp-remote …)` → Claude desktop, since mcp-remote
forwards the app's own name with that suffix);
an unknown name is kept, without quotes or newlines, at most 60 characters; no name falls back to
today's `mcp (token "…")`.
*Test:* unit tests for the mapping and the trailer; integration test at the MCP boundary with a
fake client name.

**R4. History shows the tool.** The history API adds a `via` display field parsed from the
`Hearth-Via` trailer: the friendly tool name, the token name for older trailers, nothing when
there is no trailer. The doc history list shows "Morgan via Cursor".
*Test:* parser unit tests on old and new trailers; integration test on `/history`; HistoryPanel
component test.

**R5. Neutral wording for outside AI tools.** Sidebar Pages, the Pages intro, the agent brief
page, Tables and Saved links say "AI tools" rather than "Claude" where they mean an outside tool.
Hotsauce's own built-in AI wording stays. The MCP server instructions don't assume Claude.
*Test:* existing component and e2e tests updated where they assert the old copy.

**R6. Support materials.** `docs/mcp.md` becomes "Connecting an AI tool to Hotsauce (MCP)" with a
section per tool; README, `docs/self-host.md`, the landing page, `site/public/install.md` and
`llms.txt`, the in-app help pages and the live demo's sample data match.
*Test:* the site and demo checks that exist; a read-through.
