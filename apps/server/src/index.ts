// The web client imports types from here (`hc<AppType>()`); nothing here runs in the browser.
export type { AppDeps, SaveResult } from './api/index.js'
export { type AppType, createApp } from './app.js'
export type { SyncEvent } from './sync/index.js'
