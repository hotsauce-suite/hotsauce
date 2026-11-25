// Small real PDFs for development and tests (docs/PLAN-links-pdfs.md): Helvetica text at given
// sizes, one page per list, so pdf.js reads them like any PDF.

export interface TestPdfLine {
  text: string
  /** Font size; 11 by default. */
  size?: number
  /** Extra space above the line, in points (a new paragraph). */
  gap?: number
}

/** A PDF whose pages hold these lines top to bottom; a page with no lines has no text (scanned). */
export function makeTestPdf(
  pages: Array<Array<string | TestPdfLine>>,
  title?: string,
  /** Each page's /Rotate, in degrees: 90 makes a portrait page show as landscape. */
  opts: { rotate?: number } = {},
): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => objects.push(body) // object n is objects[n - 1]
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('') // the page tree, filled in below
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const kids: number[] = []
  for (const lines of pages) {
    let y = 760
    const ops: string[] = []
    for (const raw of lines) {
      const line = typeof raw === 'string' ? { text: raw } : raw
      const size = line.size ?? 11
      y -= (line.gap ?? 0) + size * 1.25
      ops.push(`BT /F1 ${size} Tf 72 ${y.toFixed(1)} Td (${pdfString(line.text)}) Tj ET`)
    }
    const stream = ops.join('\n')
    add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
    const contents = objects.length
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${opts.rotate ? ` /Rotate ${opts.rotate}` : ''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`,
    )
    kids.push(objects.length)
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let info = ''
  if (title) {
    add(`<< /Title (${pdfString(title)}) /Producer (Hotsauce tests) >>`)
    info = ` /Info ${objects.length} 0 R`
  }
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info} >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}

function pdfString(text: string): string {
  return text.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\xff]/g, '?')
}
