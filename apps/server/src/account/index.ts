import path from 'node:path'

export { MAX_PHOTO_BYTES, type PhotoFetch, photoType, SignInPhotos } from './signInPhotos.js'
export { AccountStore, type LegacyMemberLists, type SyncResult, type ThemeRow } from './store.js'

/** Where the server keeps each member's recents, stars, rail pins and phone tab bar. Backed up; never rebuilt. */
export function accountPath(dataDir: string): string {
  return path.join(dataDir, 'account.sqlite')
}
