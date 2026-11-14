# Threads: closing, owed items and what counts as shipped

- 2026-11-14: a thread was closed while its pull request (#44) was still an unmerged draft. The
  close went by the thread's status label ("completed"), and nothing checked GitHub. The work had
  finished and was waiting for Morgan's approval line, so "built" looked like "done". Separately,
  the project's PR list only shows PRs opened from cloud threads; one opened from a Mac session
  was missing from it.
- The rule now: never close a thread on its label. Check GitHub live for open or draft PRs and
  unmerged branches across every repo (`gh pr list`, `git rev-list origin/main..<branch>`), and
  check the feature is on the live site (`/api/health` gives the version), first.
- A thread that needs anything from Morgan stays open, and the item goes on his owed list in the
  same turn (Haven's list lives in Haven's private ops repo, never here).
- Never merge on red CI. Four older merges went in red before this rule was written down.
- A brand scrub can drop behavior along with the name: Dictate lost its Haven Chat detection when
  "haven chat" was removed from a hardcoded list. Look for an existing setting to derive the
  value from (here the org name plus CHAT_URL, the same pair the app rail uses for "<org> Chat")
  before deleting it.
