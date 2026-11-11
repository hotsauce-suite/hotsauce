/** Hands a `hearth-dictate://` link to macOS. Its own module so tests can watch it. */
export function openAppLink(link: string): void {
  window.location.href = link
}
