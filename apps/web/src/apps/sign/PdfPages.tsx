import { type ReactNode, useEffect, useRef, useState } from 'react'

// Draws a PDF's pages with pdf.js, loaded only when Sign needs it. Each page is a canvas with a
// layer on top, sized to the page, where Sign draws the fields.

type PdfDoc = import('pdfjs-dist').PDFDocumentProxy

async function openPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = (
      await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    ).default
  }
  return pdfjs.getDocument({ data: new Uint8Array(data) }).promise
}

export function PdfPages({
  data,
  pages,
  overlay,
  onPageClick,
}: {
  data: ArrayBuffer
  /** Each page's size in points, from the envelope. */
  pages: Array<{ width: number; height: number }>
  /** What sits on page `n` (1-based): its fields. */
  overlay: (page: number) => ReactNode
  /** A click on an empty part of page `n`, as fractions of the page from its top-left. */
  onPageClick?: (page: number, at: { x: number; y: number }) => void
}) {
  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    let opened: PdfDoc | null = null
    openPdf(data)
      .then((d) => {
        opened = d
        if (live) setDoc(d)
        else void d.destroy()
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
      void opened?.destroy()
    }
  }, [data])

  if (failed) {
    return (
      <p role="alert" className="rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
        This PDF couldn’t be shown here.
      </p>
    )
  }
  return (
    <div className="flex flex-col items-center gap-4" data-testid="sign-pages">
      {pages.map((size, i) => (
        <PdfPage
          // biome-ignore lint/suspicious/noArrayIndexKey: pages are fixed and in order
          key={i}
          doc={doc}
          number={i + 1}
          size={size}
          overlay={overlay(i + 1)}
          onClick={onPageClick ? (at) => onPageClick(i + 1, at) : undefined}
        />
      ))}
    </div>
  )
}

function PdfPage({
  doc,
  number,
  size,
  overlay,
  onClick,
}: {
  doc: PdfDoc | null
  number: number
  size: { width: number; height: number }
  overlay: ReactNode
  onClick: ((at: { x: number; y: number }) => void) | undefined
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!doc || !canvas.current || width === 0) return
    let live = true
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    void doc.getPage(number).then((page) => {
      if (!live || !canvas.current) return
      const ratio = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: (width / size.width) * ratio })
      const el = canvas.current
      el.width = Math.floor(viewport.width)
      el.height = Math.floor(viewport.height)
      const context = el.getContext('2d')
      if (!context) return
      task = page.render({ canvas: el, canvasContext: context, viewport })
      task.promise.catch(() => {})
    })
    return () => {
      live = false
      task?.cancel()
    }
  }, [doc, number, width, size.width])

  return (
    <div
      ref={box}
      className="relative w-full max-w-3xl bg-white shadow-sm ring-1 ring-ash"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
      data-testid={`sign-page-${number}`}
    >
      <canvas ref={canvas} className="absolute inset-0 size-full" />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the page places a field; the toolbar says how */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above; fields are moved with the keyboard once placed */}
      <div
        className="absolute inset-0"
        onClick={(e) => {
          if (!onClick || e.target !== e.currentTarget) return
          const r = e.currentTarget.getBoundingClientRect()
          onClick({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
        }}
        data-page-layer={number}
      >
        {overlay}
      </div>
    </div>
  )
}
