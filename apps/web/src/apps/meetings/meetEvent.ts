// A Google Meet call's code ("abc-defg-hij") from an event's Meet link: what the Chrome
// extension is asked to capture. The server matches a code to its event (/api/calendar/match).

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/

/** The call's code ("abc-defg-hij") from an event's Meet link, or null. */
export function meetCallCode(link: string | undefined): string | null {
  if (!link) return null
  try {
    const url = new URL(link)
    const code = url.pathname.replace(/^\/|\/$/g, '')
    return url.hostname === 'meet.google.com' && MEET_CODE.test(code) ? code : null
  } catch {
    return null
  }
}
