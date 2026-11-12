import type Database from 'better-sqlite3'

/**
 * Forward-only migrations; entry N takes the schema from version N to N+1. Never edit a shipped
 * entry, append a new one. The index is a rebuildable cache, so a migration may drop and
 * recreate tables and leave `hearth reindex` to refill them.
 */
export const MIGRATIONS: readonly string[] = [
  `
  -- rowid is an explicit INTEGER PRIMARY KEY so VACUUM can never renumber rows under files_fts.
  -- mtime is when this row was last indexed; git log has the real edit times.
  CREATE TABLE files (
    rowid    INTEGER PRIMARY KEY,
    space    TEXT NOT NULL,
    path     TEXT NOT NULL,
    id       TEXT,
    kind     TEXT NOT NULL,
    title    TEXT NOT NULL,
    body     TEXT NOT NULL,
    blob_oid TEXT NOT NULL,
    size     INTEGER NOT NULL,
    mtime    TEXT NOT NULL,
    UNIQUE (space, path)
  );

  -- External content over files, kept in sync by the triggers below.
  CREATE VIRTUAL TABLE files_fts USING fts5(
    title, body,
    content = 'files', content_rowid = 'rowid',
    tokenize = 'porter unicode61'
  );

  CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;
  CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts (files_fts, rowid, title, body)
      VALUES ('delete', old.rowid, old.title, old.body);
  END;
  CREATE TRIGGER files_au AFTER UPDATE ON files BEGIN
    INSERT INTO files_fts (files_fts, rowid, title, body)
      VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO files_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;

  CREATE TABLE sync_state (
    space     TEXT PRIMARY KEY,
    head_oid  TEXT NOT NULL,
    synced_at TEXT NOT NULL
  );

  CREATE TABLE conflicts (
    space      TEXT NOT NULL,
    ref        TEXT NOT NULL,
    path       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (space, ref)
  );

  CREATE TABLE recents (
    user      TEXT NOT NULL,
    space     TEXT NOT NULL,
    path      TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    PRIMARY KEY (user, space, path)
  );

  CREATE TABLE stars (
    user  TEXT NOT NULL,
    space TEXT NOT NULL,
    path  TEXT NOT NULL,
    PRIMARY KEY (user, space, path)
  );

  -- Who owns each personal space. Handles are a lossy function of the email, so access is
  -- decided by owner_email (lowercased), never by the space name alone.
  CREATE TABLE spaces (
    name        TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('team', 'personal')),
    owner_email TEXT,
    created_at  TEXT NOT NULL,
    CHECK ((kind = 'personal') = (owner_email IS NOT NULL))
  );
  `,
  `
  -- Meetings (ARCHITECTURE §7.1): each file's parsed frontmatter as JSON, so meeting lists need no
  -- git reads, and the meetings kind split into a note (meeting) and its transcript.
  ALTER TABLE files ADD COLUMN frontmatter TEXT;
  UPDATE files
    SET kind = CASE WHEN lower(path) LIKE '%.transcript.md' THEN 'transcript' ELSE 'meeting' END
    WHERE kind = 'meetings';
  -- Rows indexed before this migration have no frontmatter. Forgetting every sync point makes the
  -- next sync of each space (the poller's first pass, at startup) re-index it in full.
  DELETE FROM sync_state;
  `,
  `
  -- Hearth Tasks (ARCHITECTURE §12.1): one task per file under tasks/, its own kind. Forgetting the
  -- sync points re-indexes every space on its next sync, which fills in what this UPDATE can't.
  UPDATE files SET kind = 'task' WHERE path LIKE 'tasks/%';
  DELETE FROM sync_state;
  `,
  `
  -- Hearth Notes (ARCHITECTURE §14.1): one note per file under notes/, its own kind.
  UPDATE files SET kind = 'note' WHERE path LIKE 'notes/%';
  DELETE FROM sync_state;
  `,
  `
  -- Hearth Whiteboard (ARCHITECTURE §15.1): one board per file under boards/, its own kind.
  UPDATE files SET kind = 'board' WHERE path LIKE 'boards/%';
  DELETE FROM sync_state;
  `,
  `
  -- Today (ARCHITECTURE §16): where each body starts in its file, so line numbers read from the
  -- index (meeting to-dos) match the file's. Re-indexing fills it in.
  ALTER TABLE files ADD COLUMN body_line INTEGER NOT NULL DEFAULT 1;
  DELETE FROM sync_state;
  `,
  `
  -- Hearth Files (ARCHITECTURE §18.1): one pointer per stored file under files/, its own kind.
  UPDATE files SET kind = 'file' WHERE path LIKE 'files/%';
  DELETE FROM sync_state;
  `,
]

/** Applies pending migrations in one IMMEDIATE transaction, so a second process waits instead of racing. */
export function migrate(db: Database.Database, migrations: readonly string[] = MIGRATIONS): void {
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
    const row = db.prepare<[], { version: number }>('SELECT version FROM schema_version').get()
    if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
    const current = row?.version ?? 0
    if (current > migrations.length) {
      throw new Error(
        `Index schema v${current} is newer than this build (v${migrations.length}). ` +
          'Delete the index file and run `hearth reindex`.',
      )
    }
    for (const sql of migrations.slice(current)) db.exec(sql)
    db.prepare('UPDATE schema_version SET version = ?').run(migrations.length)
  }).immediate()
}
