# Contributing to Hotsauce

Thanks for helping. A few things keep the project easy to work on.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the shape.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the area you're changing.
- [docs/STATUS.md](docs/STATUS.md) says what each app does and needs today. Adding or changing an app means updating its entry there; a test fails when an app has none.

## Rules the code follows

1. **Git is the truth.** If data can't survive "delete the SQLite file and reindex", it's in the wrong place.
2. **Never reformat Markdown Hotsauce didn't write.** Patch frontmatter keys in place and keep the rest of the YAML text as it was.
3. **Any git host works.** Host-specific code stays behind the host adapter, and integration tests run against every adapter that's available.
4. **Plain labels in the UI** ("Docs", "Meetings"), written for the people using it.
5. **No secrets in the repository**, ever. Keys live in the host's secret store or in the instance's encrypted settings.
6. **Small, focused changes.** Keep refactors apart from behavior changes.
7. **Database changes only add.** The updater puts the previous release back when a new one fails, and that release then runs on the databases the new one already migrated. In the stores that hold real data (Clips, Dictate, the assistant, members' stars, pins and recents in `account.sqlite`) a migration adds tables, or columns that are nullable or have a default, which the older code can ignore; it never renames or drops what the previous release reads, and a store never lowers a saved schema version. The search index is different: an older release makes it again for itself and keeps only the spaces, conflicts, and the stars, pins and recents older releases kept there, by the columns it knows.

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
- **Some merges release nothing**: changes only to `docs/`, top-level `*.md` files, `site/`, `.github/`, `e2e/`, web and server test files, `scripts/tour-video/` and the scripts that aren't in the image (a change to the Mac app in `apps/dictate-mac/` always releases, so its update has a new number). The list is `NO_RELEASE` in `scripts/next-release.mjs`. After every Release run, the Mac app workflow builds a new Mac app when the version or the Mac app's sources changed, so the app always carries the release number.
- **By hand**: run the Release workflow from the Actions tab, with "feature" or "force" (release even if only docs changed) when needed. A hand-run that is still waiting can be replaced by a merge's run; run it again after.
- **Check it ran**: after merging, the Release run should show a new tag within about ten minutes. If the image build fails, `main` already says the new number but nothing is tagged; the next run (or a hand-run) picks the same number and finishes.

### Release notes

Every pull request's description has a `## What's new` section, and a check (`.github/workflows/whats-new.yml`) fails it without one. Write one line per change people will notice, in plain words for someone who uses Hotsauce rather than builds it, each starting `- `. Start a line `- Mac app:` when the change is in the Mac app. Write `None` for changes nobody sees (docs, tests, CI, refactors).

```
## What's new

- Settings → Apps shows which Mac app version you have, and whether a newer one is out.
- Mac app: an Update available item in the menu bar menu when there's a newer version.
```

The Release workflow collects these lines into `WHATS_NEW.json` in its `Release X.Y.Z` commit (`scripts/release-notes.mjs`), puts them at the top of the GitHub release, and Settings → What's new and hotsauce.work/changes show them. A merge that releases nothing (a docs-only change, say) has its lines in the next release. To fix a note after it's released, edit `WHATS_NEW.json` in a pull request: hotsauce.work/changes shows it at once, and Settings → What's new with the next release (the file alone starts no release).
