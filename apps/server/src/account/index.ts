import path from 'node:path'

export { AccountStore, type LegacyMemberLists } from './store.js'

/** Where the server keeps each member's recents, stars and rail pins. Backed up; never rebuilt. */
export function accountPath(dataDir: string): string {
  return path.join(dataDir, 'account.sqlite')
}
