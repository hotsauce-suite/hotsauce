export { type FlyApi, type FlyMachine, flyApi, HELPER_ROLE } from './fly.js'
export { fetchLatestRelease, RELEASES_URL, type Release } from './releases.js'
export { type UpdateMode, Updater, type UpdateStatus } from './service.js'
export { UpdateStore } from './store.js'
export { isNewer, parseVersion, readVersion } from './version.js'

/** Where every release's image is published (.github/workflows/release.yml). */
export const RELEASE_IMAGE = 'ghcr.io/hotsauce-suite/hotsauce'
