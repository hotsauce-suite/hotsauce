# Backups

Learnings from running nightly backups on a real instance (`docs/PLAN-backups-storage.md`).

- **Copying a git repository file by file loses its empty folders, and git needs them.** A folder
  is a repository only if `HEAD`, `objects/` and `refs/` all exist. After `git gc` (which git runs
  on its own as commits pile up) every branch moves into `packed-refs` and `refs/heads` and
  `refs/tags` are empty, so a file-only copy says "not a git repository". Tests with a fresh repo
  never hit it; `git pack-refs --all` in a test reproduces it in one line.
- **The fsck after staging is what saved us.** It turned a silently unrestorable backup into a
  loud failure. Keep checking what you copy, not just that the copy finished.
- **A failure only the server log sees is a silent failure.** Backups failed for hours before
  anyone looked. A public 200/503 check that a third-party uptime monitor polls needs no keys on
  the server and also catches the server being down; never put the error text in it.
- **A restore drill on a young instance proves less than it looks.** The drill passed the same
  day the bug started, because the repository hadn't been gc'd yet. Re-run drills on old data.
- **"Rebuildable cache" files collect state that isn't.** Stars, rail pins and recents were added
  to `index.sqlite` one at a time because it was the database already open, while backups, the
  state mirror and the "delete it and reindex" advice all treated that file as disposable. Before
  adding a table to the index, ask whether Git could give it back; if not, it needs its own file
  under `DATA_DIR` (anything there except `index.sqlite` is backed up and mirrored with no extra
  code). `docs/PLAN-member-lists.md`.
- **Moving data between SQLite files: copy once, mark it, leave the old rows.** A copy that runs on
  every start resurrects what a member deleted since; dropping the old table blocks a rollback.
  The marker lives in the new file, in the same transaction as the copy.
