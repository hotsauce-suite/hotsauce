// Which tabs are Google Meet calls, and which of them the person asked Hearth to listen to.
// Pure, so the service worker's choices are tested without Chrome.

const MEET_CALL = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?=$|[/?#])/

/** The meeting code of a Meet call URL ("abc-defg-hij"), or null for anything else. */
export function meetCode(url: string | undefined): string | null {
  return url ? (MEET_CALL.exec(url)?.[1] ?? null) : null
}

/**
 * A Meet tab the person clicked the Hearth icon on. Chrome lets an extension capture a tab only
 * after the person invoked it there, so these are the only tabs Hearth may capture.
 */
export interface Invoked {
  tabId: number
  code: string
  /** Epoch milliseconds. */
  at: number
}

const KEEP = 10

/** Without a call to match, an invoke counts only this soon after the click. */
export const UNMATCHED_MS = 10 * 60_000

/** Adds or refreshes a tab, newest first, keeping the last few. */
export function remember(list: readonly Invoked[], entry: Invoked): Invoked[] {
  return [entry, ...list.filter((e) => e.tabId !== entry.tabId)].slice(0, KEEP)
}

/**
 * The tab to capture. Given the call's code (the Hearth page knows it from Take notes or the
 * calendar event): the newest invoked tab still on that call. Without one: the newest invoked
 * tab still on its call, and only if it was invoked in the last ten minutes, so a call from
 * earlier that's still open is never recorded by mistake. `urlOf` answers undefined for a
 * closed tab.
 */
export async function pickTarget(
  list: readonly Invoked[],
  want: { code: string | null; now: number },
  urlOf: (tabId: number) => Promise<string | undefined>,
): Promise<Invoked | null> {
  for (const entry of [...list].sort((a, b) => b.at - a.at)) {
    if (want.code !== null ? entry.code !== want.code : want.now - entry.at > UNMATCHED_MS) {
      continue
    }
    if (meetCode(await urlOf(entry.tabId)) === entry.code) return entry
  }
  return null
}
