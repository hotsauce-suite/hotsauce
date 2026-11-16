# MCP server and Claude connectors

- The name a person sees for a connector in Claude is chosen by the client config, not by the
  server's `serverInfo`. Claude Code takes it from `claude mcp add <name>`, Claude desktop from the
  `mcpServers` key, and claude.ai from the name typed when adding a custom connector. Renaming the
  server alone changes nothing people see; the Settings page's copy-paste snippets are what name
  new connections (`connectorName()` in `apps/web/src/api/tokens.ts`, the product slug, matching
  `apps/server/src/mcp/server.ts`).
- An existing connection keeps its old name until the person renames it on their side. Look on
  the device and account they use before editing configs: in one case the "Hearth" connector was
  in a work claude.ai account, not on the Mac or the personal account the agent could see.
- claude.ai custom connectors can't be renamed in place: remove and add again. They sign in with
  OAuth or nothing; the server's personal-token auth works for Claude Code and Claude desktop (via
  mcp-remote), not for a claude.ai connector.
- A connector's icon comes from the server, not the client: the MCP `serverInfo.icons` list
  (absolute URLs) and the site's `/favicon.ico`. Ours once answered `/favicon.ico` with the web
  app's HTML (the SPA fallback), so claude.ai showed a blank icon. Keep a real `favicon.ico` in
  `apps/web/public/`.
- The server is stateless (one `McpServer` per POST), so `server.server.getClientVersion()` is
  only set on the `initialize` request itself, never on a later `tools/call`. To record which
  tool made a write, `mcpRoutes` remembers the friendly name per token (or per member) after each
  `initialize`, in memory (`ClientNames` in `apps/server/src/mcp/clients.ts`). A restart forgets
  it: writes fall back to `mcp (token "…")` until the client connects again.
- `clientInfo.name` values seen or documented (Nov 14 2026): Claude Code `claude-code`, claude.ai
  and Claude desktop `claude-ai`, ChatGPT `openai-mcp`, Cursor `cursor-vscode`, Codex
  `codex-mcp-client`. mcp-remote forwards the app's name with a suffix:
  `claude-ai (via mcp-remote 0.15.2)`, which is how Claude desktop is told apart from claude.ai.
  The name is client-chosen: strip quotes and newlines before it goes into a trailer.
- ChatGPT's and Grok's consumer connectors accept only OAuth or no auth, never a pasted bearer
  token (checked Nov 14 2026). Settings listed them as "Needs sign-in, coming soon" until the
  OAuth work lands. Cursor takes `url` + `headers` in `~/.cursor/mcp.json`; Codex takes `url` +
  `bearer_token_env_var` in `~/.codex/config.toml` (`codex mcp add --url` has no token flag).
- Changing the `Hearth-Via` format breaks every test asserting the old substring
  (`mcp (token "Claude Code")`, about ten files incl. e2e). The history API parses both the old
  and new shapes (`viaLabel`), so old commits still read "via <token name>".

## Signing in from claude.ai, ChatGPT and Grok (OAuth, Nov 2026)

- The MCP SDK's own client (`StreamableHTTPClientTransport` with an `authProvider`) is the best
  interop test you can run offline: it does discovery, dynamic registration, PKCE and the token
  exchange exactly as Claude's clients do. Drive it against `app.request` with a fetch shim.
- A client's `client_name` is whatever the registrant typed, so anyone can register as "Claude".
  Only the return address proves who a client is: lead the Allow page with the host and name the
  tool only for hosts on a known list.
- `/oauth/*` sits outside `/api`, so it missed the body limit every `/api` route gets. Anything
  mounted beside `/api` needs its own limits; check what middleware a new mount actually runs.
- Node's `BlockList` matches an IPv4 address against IPv4-mapped IPv6 rules too: adding
  `::ffff:0:0/96` blocks every IPv4 address. Unwrap mapped addresses yourself instead.
- Fetching a URL a stranger chose: check the address in the socket's own `lookup`, not in a
  lookup before `fetch`, or DNS rebinding walks around the check. Global `fetch` can't take a
  lookup without the `undici` package; `node:https` `request({ lookup })` can.
- Eviction "oldest never-used first" can evict the item just added. Exclude it explicitly.
- Rotating refresh tokens with replay revocation needs a short grace window: clients retry and
  refresh in parallel, and without it a member is silently disconnected.

