# Plan: sign in to Hotsauce's MCP server from claude.ai and ChatGPT (OAuth)

claude.ai, ChatGPT and Grok add a remote MCP server as a "custom connector" and sign in through
the browser with OAuth 2.1; they can't send a pasted bearer token. Hotsauce's MCP server only took
personal access tokens, so a connector added there could never connect. This adds a small,
standard OAuth authorization server inside Hotsauce: the member presses Connect in their AI tool,
signs in to Hotsauce as usual, presses Allow, and the tool gets a token that works on `/mcp` only.

Decided with Morgan (Nov 14–15 2026): built in this thread; anyone who can sign in to Hotsauce
can connect, with exactly the access their tokens have (team space plus their own); a connection
lasts until the member disconnects it in Settings (or leaves the organization); pasted tokens stay
for Claude Code, Claude desktop and scripts. It must be plain standard OAuth so ChatGPT and Grok
work too, not Claude-specific.

## Status

- In progress on `claude/mcp-oauth`.

## Standards followed

MCP authorization (2025-06-18 and 2025-11-25): RFC 9728 protected resource metadata, RFC 8414
authorization server metadata, OAuth 2.1 authorization code with PKCE (S256 only), public clients
(`token_endpoint_auth_method: none`), RFC 7591 dynamic client registration, client ID metadata
documents (an `https` URL as `client_id`, as ChatGPT and newer Claude clients use), RFC 8707
resource indicators (tokens are bound to `<PUBLIC_URL>/mcp`).

## Requirements

**R1. The MCP server says where to sign in.** `GET /.well-known/oauth-protected-resource` (and
the same path with `/mcp` appended) returns `{ resource: "<PUBLIC_URL>/mcp",
authorization_servers: ["<PUBLIC_URL>"], bearer_methods_supported: ["header"], scopes_supported:
["mcp"], resource_name }`. A 401 from `/mcp` carries `WWW-Authenticate: Bearer
resource_metadata="<that URL>"`. Both answer cross-origin requests (`Access-Control-Allow-Origin: *`).
*Test:* integration, both paths and the 401 header.

**R2. Authorization server metadata.** `GET /.well-known/oauth-authorization-server` returns
issuer `<PUBLIC_URL>`, `authorization_endpoint` `/oauth/authorize`, `token_endpoint`
`/oauth/token`, `registration_endpoint` `/oauth/register`, `revocation_endpoint`
`/oauth/revoke`, `response_types_supported: ["code"]`, `grant_types_supported:
["authorization_code", "refresh_token"]`, `code_challenge_methods_supported: ["S256"]`,
`token_endpoint_auth_methods_supported: ["none"]`, `scopes_supported: ["mcp"]`,
`client_id_metadata_document_supported: true`.
*Test:* integration.

**R3. Dynamic client registration.** `POST /oauth/register` with JSON `{ redirect_uris,
client_name?, … }` registers a public client. Every redirect URI is `https`, or `http` on
`localhost`/`127.0.0.1`/`[::1]`, with no fragment; 1 to 10 of them. `client_name` is cut to 80
characters on one line. Answer 201 with `client_id`, `client_id_issued_at`, `redirect_uris`,
`client_name`, `grant_types`, `response_types`, `token_endpoint_auth_method: "none"`. Bad input is
400 `{ error: "invalid_redirect_uri" | "invalid_client_metadata" }`. Clients are kept on the
volume; at most 500, the oldest never used to connect dropped first.
*Test:* unit (store) and integration.

**R4. Client ID metadata documents.** A `client_id` that is an `https` URL is fetched (no
redirects, 5 s, at most 16 KB, a host name rather than an IP, not resolving to a private or
loopback address) and must be JSON whose `client_id` equals the URL, with `redirect_uris` (same
rules as R3) and an optional `client_name`. Cached for an hour.
*Test:* unit with a fake fetch: good document, mismatched id, private address, too large.

**R5. The Allow page.** `GET /oauth/authorize?...` is a web page outside the app shell. It asks
the server to check the request first; an unknown client or a redirect URI the client didn't
register shows an error on the page and never redirects. `response_type` must be `code`,
`code_challenge` with `code_challenge_method=S256` is required, and `resource`, when given, must
be `<PUBLIC_URL>/mcp` (or `<PUBLIC_URL>`). Signed out, it goes to sign-in and back. Signed in, it
shows "Let <client name> use your Hotsauce?" with the redirect's host, the member's email, what it
can do, and Allow / Cancel. Allow (a signed-in session only, never a token) returns the redirect
URL with `code`, `state` and `iss`; Cancel sends `error=access_denied` with `state`.
*Test:* integration on `GET /api/oauth/authorize` (check) and `POST /api/oauth/authorize`
(allow), component test of the page states, e2e journey (R10).

**R6. The token endpoint.** `POST /oauth/token` (form-encoded, also JSON) issues and refreshes
tokens. `authorization_code`: the code is single-use and lives 5 minutes; `client_id`,
`redirect_uri` and the PKCE verifier must match; a reused code revokes what it issued. The answer
is `{ access_token: "hto_…", token_type: "Bearer", expires_in: 3600, refresh_token: "htr_…",
scope: "mcp" }` with `Cache-Control: no-store`. `refresh_token`: the client must match; the
refresh token rotates, and presenting an old one again revokes the whole connection (replay).
Errors follow RFC 6749 (`invalid_grant`, `invalid_request`, `unsupported_grant_type`,
`invalid_client`). Only hashes of tokens are stored.
*Test:* unit and integration, including PKCE mismatch, reuse, expiry and rotation.

**R7. Using a connection.** `Authorization: Bearer hto_…` works on `/mcp` only (anywhere else it
is unauthenticated). The member is re-checked on every use, as tokens are, so someone removed from
the organization loses their connections. An expired or revoked token is 401 with
`WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"`, so the client refreshes.
The principal carries `via: { kind: 'token', tokenId: <connection id>, tokenName: <client name> }`,
so writes are marked with the tool and everything a token can't do (mint tokens, push
subscriptions, sockets), a connection can't either.
*Test:* integration with a real MCP SDK client using the access token; `/api` refuses it.

**R8. Connected apps in Settings.** `GET /api/oauth/connections` lists the member's connections
`[{ id, clientName, redirectHost, createdAt, lastUsedAt }]`; `DELETE /api/oauth/connections/:id`
disconnects one at once (its access and refresh tokens stop working). Both need a signed-in
session. Settings shows a "Connected apps" section with that list and a Disconnect button, and an
empty state that says how to connect. At most 20 connections per member: connecting a 21st drops
the one used longest ago. `POST /oauth/revoke` (RFC 7009) lets a client drop its own token.
*Test:* integration and a component test.

**R9. Storage.** Clients and connections live in `DATA_DIR/oauth/oauth.json` (atomic write, like
`tokens.json`), never in Git or the index. Codes live in memory (a restart mid-sign-in means
pressing Connect again). An unreadable file refuses every connection token rather than being
replaced.
*Test:* unit.

**R10. A real sign-in end to end.** Against the built server: register a client, open the Allow
page in a browser signed in as a member, press Allow, catch the redirect, exchange the code, then
an MCP SDK client lists spaces with the access token, refreshes, and the connection disappears
from Settings when disconnected.
*Test:* `e2e/mcp-oauth.spec.ts`.

**R11. Support materials.** ARCHITECTURE §8 gains the OAuth section; `docs/mcp.md`, the help page
`site/public/help/agents.html` and the Settings tool picker give claude.ai, ChatGPT and Grok their
steps (add a custom connector with the server URL, press Connect); README and the landing page's
agents lines say tokens or sign-in; the Haven connect page artifact is updated.
*Test:* read-through.
