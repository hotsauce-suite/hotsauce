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
