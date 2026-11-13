// Ties a generic build of the extension to one server: its pages get the page bridge without a
// permission prompt, and server.json tells the extension where to go. The Hotsauce server does
// the same to the zip it offers (a copy of this file; a test keeps the two the same).

export function stampForServer(
  manifest: Record<string, unknown>,
  server: { url: string; name: string },
): { manifest: Record<string, unknown>; serverJson: string } {
  const origin = new URL(server.url).origin
  const host = new URL(origin)
  const origins =
    host.hostname === 'localhost'
      ? [origin, 'http://localhost:3000', 'http://localhost:5173']
      : [origin]
  // Chrome match patterns carry no port: http://localhost/* covers every dev port.
  const matches = [
    ...new Set(origins.map((o) => `${new URL(o).protocol}//${new URL(o).hostname}/*`)),
  ]
  const name = server.name.trim() || 'Hotsauce'
  return {
    manifest: {
      ...manifest,
      name,
      description: `Take notes on Google Meet calls with ${name}, and save pages to read later.`,
      action: { ...(manifest.action as object), default_title: name },
      content_scripts: [{ matches, js: ['bridge.js'], run_at: 'document_start' }],
    },
    serverJson: `${JSON.stringify({ url: origin, name })}\n`,
  }
}
