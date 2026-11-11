# Hotsauce

**The open sauce office suite.** [hotsauce.work](https://hotsauce.work)

Docs, meeting notes, dictation and screen recordings for a small team, on a server you run, with every file kept as plain Markdown in git.

| App | What it does |
| --- | --- |
| **Docs** | Markdown documents with a source-first editor, live collaboration through git, history, search, and links that survive renames. |
| **Meetings** | AI meeting notes: record in the browser or with the Chrome extension for Google Meet, live transcript, notes written from your own jottings, Ask across past meetings, Google Calendar reminders. |
| **Dictate** | Hold a key on a Mac, talk, and clean punctuated text lands wherever your cursor is. Team word lists keep names spelled right. |
| **Clips** | Loom-style screen recordings with a camera bubble, transcripts, speed control and a shared library. |

Plus an MCP server, so Claude and other agents can search, read and write your docs and meetings as you.

## Why Hotsauce

- **Your files stay yours.** Every doc and meeting note is a Markdown file in a git repository on your server or in your GitHub organization. The database is a cache you can delete and rebuild.
- **Your keys, your bill.** Bring your own Anthropic and Deepgram keys. A small team spends a few dollars a month on them.
- **Your brand.** Name the workspace after your company and set your logo, colors and fonts. The whole app follows, and agents can read the brand kit too.
- **One small server.** One Node process with one disk, about $6 a month on Fly.io, or any Docker host.

## Run it for your organization

```sh
git clone https://github.com/hotsauce-suite/hotsauce && cd hotsauce
pnpm install
scripts/deploy-fly.sh acme-office          # or: cd deploy && docker compose up -d --build
```

Open the setup link the server prints. A wizard walks you through your organization, brand, Google sign-in (through a free Clerk account), AI keys and storage, then launches. The full guide is [docs/self-host.md](docs/self-host.md).

## Develop

You need Node 22 (see `.node-version`), git, and pnpm 10 via `corepack enable`. Docker is optional.

```sh
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` runs the server on http://localhost:3000 in development sign-in mode with local git repositories, and Vite on http://localhost:5173. Open http://localhost:5173 and sign in as any `@example.test` address. Nothing leaves your machine: transcription and AI use deterministic fakes unless you set `ASR_PROVIDER=deepgram DEEPGRAM_API_KEY=… LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=…`.

```sh
pnpm lint && pnpm typecheck
pnpm test                  # unit + integration (Vitest)
pnpm build && pnpm test:e2e  # Playwright, against the built app
```

The design lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Section 11 covers organizations, the setup wizard and the brand kit.

Hotsauce started as an internal tool called Hearth, so package names, some identifiers and the git trailer `Hearth-Via` still say "hearth". They're stable on purpose: files written by older versions keep working.

## Website

`site/` is [hotsauce.work](https://hotsauce.work): static pages on Cloudflare Workers. `cd site && npx wrangler deploy` publishes it.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately: see [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE). © 2026 Morgan Holland. You can run, change and share Hotsauce freely. If you offer a changed version to others over a network, share your changes under the same license.
