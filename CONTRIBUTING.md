# Contributing to Hotsauce

Thanks for helping. A few things keep the project easy to work on.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the shape.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the area you're changing.

## Rules the code follows

1. **Git is the truth.** If data can't survive "delete the SQLite file and reindex", it's in the wrong place.
2. **Never reformat Markdown Hotsauce didn't write.** Patch frontmatter keys in place and keep the rest of the YAML text as it was.
3. **Any git host works.** Host-specific code stays behind the host adapter, and integration tests run against every adapter that's available.
4. **Plain labels in the UI** ("Docs", "Meetings"), written for the people using it.
5. **No secrets in the repository**, ever. Keys live in the host's secret store or in the instance's encrypted settings.
6. **Small, focused changes.** Keep refactors apart from behavior changes.

## Checks

Run these before opening a pull request. CI runs the same:

```sh
pnpm lint
pnpm typecheck && pnpm exec tsc -p e2e
pnpm test
pnpm build && pnpm test:e2e
```

Add or update tests with every behavior change. Specs drive the real built app; prefer that over mocks for user-facing flows.

## License

By contributing, you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).
