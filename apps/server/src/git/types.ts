export interface Author {
  name: string
  email: string
}

/** `content: null` deletes the file. Bytes are for binary files such as uploaded images. */
export interface Change {
  path: string
  content: string | Uint8Array | null
}

export interface Entry {
  path: string
  type: 'file' | 'dir'
  size?: number
  oid?: string
}

export interface Commit {
  oid: string
  author: Author
  date: string
  message: string
  label?: string
}

/** One commit as the usage report sees it (`GitStore.activity`): who, when, and what it touched. */
export interface ActivityCommit {
  /** The author's address; the committer is always Hotsauce. */
  email: string
  /** Author date, ISO 8601. */
  date: string
  /** The message's first line. */
  subject: string
  /** `added` for a new file, `changed` for an edit or a rename (the new path); deletions left out. */
  files: Array<{ path: string; change: 'added' | 'changed' }>
}

export type CommitResult =
  | { status: 'committed'; oid: string; blobOid: string }
  /** A three-way merge with a concurrent change succeeded; the client must adopt `content`. */
  | { status: 'merged'; oid: string; blobOid: string; content: string }
  | {
      status: 'conflict'
      conflictRef: string
      theirs: { blobOid: string; content: string }
      ours: { content: string }
    }

export interface ConflictInfo {
  ref: string
  path: string
  createdAt: string
}
