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
