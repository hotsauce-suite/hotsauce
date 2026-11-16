# Audits

Learnings from the second audit (`docs/PLAN-audit-2.md`, Nov 2026).

- **Ask reviewers for "steps, then what is lost or exposed".** Two read-only reviewers with that
  one instruction returned nineteen findings with file lines and no style notes. Tell them which
  attackers to play (a visitor, a link holder, a member, a web page, an AI tool holding a token,
  someone at the laptop after sign-out) and to drop anything they can't trace end to end.
- **Have them run it.** The findings that held up best came with a throwaway script against
  `app.request` or a store class. Give reviewers a scratch folder outside the repository.
- **Frontmatter a member can type is input, not state.** `share:` was treated as the server's own
  record, yet any save could write it. Any key that grants something (a link, an owner, a role)
  needs a rule for who may write it, enforced where text enters (`saveFile`, conflict resolve),
  as restore already did.
- **An AI tool is a different attacker from its member.** It acts with the member's rights on
  instructions from whatever it last read: a public form answer, a saved page, a meeting invite.
  Review each tool for what one call could publish or send out, not only for what it can reach.
- **A rollback runs old code on new data.** The updater's rollback was tested with a fake Fly and
  never against a database the new release had already migrated. Stores must open a newer schema
  and never lower its version (CONTRIBUTING rule 7); test it by raising the version by hand.
- **A changed contract breaks scripted callers.** Requiring `base_blob_oid` to replace a file
  broke the assistant tests that scripted a blind `write_file`. The in-app assistant uses the
  same tools, so run its tests after any connector change.
- **Check main is green before you start.** A date bug turned the booking test red at midnight
  UTC on a Monday, mid-audit. A baseline run at the start tells you which red is yours.
