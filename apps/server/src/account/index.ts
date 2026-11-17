import path from 'node:path'

export { AccountStore, type LegacyMemberLists, type SyncResult } from './store.js'

/** Where the server keeps each member's recents, stars, rail pins and phone tab bar. Backed up; never rebuilt. */
export function accountPath(dataDir: string): string {
  return path.join(dataDir, 'account.sqlite')
}
