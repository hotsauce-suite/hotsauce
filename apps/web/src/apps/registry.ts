// The apps of the Hearth suite. Each app is a manifest in `src/apps/<id>/manifest.ts` plus
// routes under its `route`; the shell, the app rail, Cmd-K and the document view read these.
// The rail draws whatever is listed here: a new app appears there by its manifest alone.

import { chat, org, product } from '../brand/product'
import type { IconName } from '../components/Icon'
import { clipsApp } from './clips/manifest'
import { dictateApp } from './dictate/manifest'
import { docsApp } from './docs/manifest'
import { meetingsApp } from './meetings/manifest'

export type AppId = 'docs' | 'meetings' | 'dictate' | 'clips'

export interface AppManifest {
  id: AppId
  /** The name users see. */
  name: string
  /** The rail's short label, under the icon. */
  label: string
  /** The rail's icon. */
  icon: IconName
  /** Internal codename (platform PRD); never shown in the UI. */
  codename: string
  /** URL prefix of every route the app owns. */
  route: string
  /** The top-level folder its files live under, in every space; '' for an app without files. */
  folder: string
  /** The app URL that opens a file of this app. */
  urlFor: (space: string, path: string) => string
  /** Loads the app's first page, so its chunk is warm before the click lands. */
  preload: () => Promise<unknown>
}

/** A rail entry that leaves Hearth: opens `href` in a new tab. Never routed, never in `APPS`. */
export interface RailLink {
  id: string
  name: string
  label: string
  icon: IconName
  href: string
}

/** Links the organization added (Settings → Organization): today, its team chat. */
export function railLinks(): readonly RailLink[] {
  const href = chat()
  return href
    ? [{ id: 'chat', name: `${org() || product()} Chat`, label: 'Chat', icon: 'chat', href }]
    : []
}

export const APPS: readonly AppManifest[] = [docsApp, meetingsApp, dictateApp, clipsApp]

/** The app whose routes contain `pathname`, if any (`/settings` belongs to none). */
export function ownerOfPath(pathname: string): AppManifest | undefined {
  return APPS.find((app) => pathname === app.route || pathname.startsWith(`${app.route}/`))
}

/** The app whose routes contain `pathname`; Docs for anything else. */
export function appForPath(pathname: string): AppManifest {
  return ownerOfPath(pathname) ?? docsApp
}
