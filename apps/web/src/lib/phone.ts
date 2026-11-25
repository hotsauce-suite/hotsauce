// Connecting the Android app's widgets (docs/PLAN-android.md R5). The app opens
// /phone/connect?state=<nonce> in its Chrome shell; once the member allows it, the page makes a
// phone device and hands its token straight back to the app with an Android intent (never in a
// web address the browser keeps). The app takes it only with the nonce it sent.

/** The Android app's package (apps/android, PLAN-android R2). */
export const ANDROID_PACKAGE = 'work.hotsauce.app'

/** The app's nonce: random, URL-safe, and long enough not to guess. */
export function isPhoneState(state: string | null): state is string {
  return state !== null && /^[A-Za-z0-9_-]{32,128}$/.test(state)
}

const SAFE = /^[A-Za-z0-9_-]+$/

/** The intent that opens the app's connect screen with the nonce and the new token. */
export function phoneCallback(state: string, token: string): string {
  if (!SAFE.test(state) || !SAFE.test(token)) throw new Error('Unexpected characters')
  return `intent://connect#Intent;scheme=hotsauce;package=${ANDROID_PACKAGE};S.state=${state};S.token=${token};end`
}

/** Where "Not now" goes back to: the app itself, with no token. */
export function phoneDeclined(state: string): string {
  if (!SAFE.test(state)) throw new Error('Unexpected characters')
  return `intent://connect#Intent;scheme=hotsauce;package=${ANDROID_PACKAGE};S.state=${state};S.declined=1;end`
}
