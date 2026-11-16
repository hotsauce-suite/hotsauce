# Agent threads: what counts as shipped

- A thread was once closed while its pull request was still an unmerged draft waiting on an
  approval. The close went by the thread's status label ("completed"), and nothing checked
  GitHub, so "built" read as "done". Also, a PR opened from a local session can be missing from
  a project's PR list, so check GitHub itself rather than a summary of it.
- Before closing anything, check GitHub live for open or draft PRs and unmerged branches in every
  repo (`gh pr list`, `git rev-list origin/main..<branch>`), and check the change is in a release
  and on the live site (`/api/health` reports the version).
- Work waiting on the owner stays open, and the item goes on the owner's to-do list the same turn.
- Never merge on red CI.
- A rename can drop behavior along with the name: Dictate stopped styling a team's own chat as
  chat when a hardcoded name was scrubbed. Before deleting such a value, look for a setting to
  derive it from (here the org name plus CHAT_URL, the same pair the app rail uses for
  "<org> Chat").

## Keeping the status page honest

- A status page written by hand goes stale within days: the old one still described October.
  `docs/STATUS.md` now has a test (`apps/web/src/apps/statusDoc.test.ts`) that fails when an app
  on the rail, a folder under `apps/web/src/apps/` or a folder under `apps/` has no entry. Extend
  that test, not the prose, when a new kind of app appears.
- Read "what does it need" from `apps/server/src/services.ts`, not from the docs: it is the one
  place that decides fake, real or off for each provider. Docs claimed push reminders needed keys;
  the server has generated its own pair in production since setup mode shipped.
- Instance-specific status (what is live, which keys are missing) belongs in the instance's
  private ops repo, never in the public repo's status page.
