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

## Planning a multi-thread effort as a map (2026-11-15, comments and For you)

- The first map (issue #109, ending in `docs/PLAN-comments.md`) took two question rounds and under
  an hour. What made it quick: reading the code first so every question was a product choice with a
  recommendation, and asking a whole round at once so one "yes" could settle it.
- Sort each open point before asking: a standing rule already decides it (record it, don't ask),
  it is a product choice (ask), or it waits on other work in flight (leave it in "Not yet
  specified" and name what it waits on). Only the middle kind goes to the owner.
- One issue was enough. Child tickets per question would have been noise for a round answered in
  minutes; the map's body listed the open questions and was rewritten after each round.
- The owner reads an HTML page, never the issue. Update both in the same turn or they drift.
- End the map in a plan doc with a Status block that build threads claim, and merge it before the
  first build thread starts, so the build reads `main` rather than a planning branch.
- The public map and plan name no people and no organization; "the owner" and "a teammate" are enough.

- **`git checkout -B <branch> origin/main` makes the branch track main.** A later bare
  `git push -q` then pushes nothing to your branch and prints nothing, so CI keeps testing an old
  head. After restarting a branch, push with `git push origin <branch>` (or set the upstream to the
  branch) and check `git ls-remote` shows your commit before waiting on CI.
