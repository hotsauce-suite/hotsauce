// A published page's HTML (ARCHITECTURE §20.2), walled off from Hearth: a sandboxed frame without
// `allow-same-origin` runs its scripts in an opaque origin, so it can't read Hearth's cookies,
// storage or API, and it can't navigate the app.
export const PAGE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms'

export function PageFrame({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      data-testid="page-frame"
      title={title}
      srcDoc={html}
      sandbox={PAGE_SANDBOX}
      referrerPolicy="no-referrer"
      className="h-full min-h-[70vh] w-full flex-1 border-0 bg-white"
    />
  )
}
