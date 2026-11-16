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

## Releases

Releases number themselves. Don't change `HOTSAUCE_VERSION` in a pull request (CI fails if you do). After each merge to `main`, `.github/workflows/release.yml` picks the next number from the newest `v*` tag, writes it to `main` as a `Release X.Y.Z` commit (pushed with the release robot's deploy key), pushes the image `ghcr.io/hotsauce-suite/hotsauce:<version>` and `:latest`, and only then tags `v<version>` and publishes the release notes. One release runs at a time; merges that land close together can share one release.

- **Patch by default.** Add the `feature` label to a pull request for a minor release (0.15.x to 0.16.0). Label it before merging.
- **Some merges release nothing**: changes only to `docs/`, top-level `*.md` files, `site/`, `.github/`, `e2e/`, `scripts/tour-video/`, or the Mac app's sources (`apps/dictate-mac/`, except the built `release/`). The list is `NO_RELEASE` in `scripts/next-release.mjs`.
- **By hand**: run the Release workflow from the Actions tab, with "feature" or "force" (release even if only docs changed) when needed.
- **Check it ran**: after merging, the Release run should show a new tag within about ten minutes. If the image build fails, `main` already says the new number but nothing is tagged; the next run (or a hand-run) picks the same number and finishes.
