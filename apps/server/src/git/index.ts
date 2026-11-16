export { GitStore, type GitStoreOptions, type MarkdownGuard } from './git-store.js'
export { formatCommitMessage, parseCommitMessage, viaLabel, withLabel, withVia } from './message.js'
export { GitError, redactCredentials, runGit, runGitBuffer } from './run-git.js'
export type { Author, Change, Commit, CommitResult, ConflictInfo, Entry } from './types.js'
