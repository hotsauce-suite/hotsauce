// The release notes (docs/PLAN-mac-version-and-whats-new.md, N1): WHATS_NEW.json at the root,
// written by each release from its pull requests' "What's new" lines (scripts/release-notes.mjs).
import data from '../../../../WHATS_NEW.json'

export interface ReleaseNote {
  text: string
  /** "Mac app" for a change in the Mac app; absent for the rest. */
  area?: string
}

export interface ReleaseNotes {
  version: string
  /** YYYY-MM-DD. */
  date: string
  notes: ReleaseNote[]
}

/** Every release's notes, newest first. */
export const RELEASES: ReleaseNotes[] = (data as { releases: ReleaseNotes[] }).releases
