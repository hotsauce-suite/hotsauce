import { inflateSync } from 'node:zlib'
import fc from 'fast-check'
import {
  PDFArray,
  type PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  type PDFRef,
  PDFString,
  rgb,
  StandardFonts,
} from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  addTextLayer,
  assemble,
  PdfToolError,
  pageBox,
  parseRanges,
  rangeLabel,
  rebuildPages,
  resultName,
  shrink,
  toPagePoint,
  winAnsi,
} from './tools'

/** A PDF whose page n says "Page n" (or the given words), sized A4 or as given. */
async function makePdf(
  texts: string[],
  opts: { rotate?: number; size?: [number, number]; linkLastToFirst?: boolean } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const t of texts) {
    const page = doc.addPage(opts.size ?? [595, 842])
    page.drawText(t, { x: 50, y: 700, size: 24, font })
    if (opts.rotate) page.setRotation({ type: 'degrees', angle: opts.rotate } as never)
  }
  if (opts.linkLastToFirst && texts.length > 1) {
    const first = doc.getPage(0)
    const last = doc.getPage(texts.length - 1)
    const link = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [0, 0, 100, 100],
      Dest: [first.ref, 'XYZ', null, null, null],
    })
    last.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]))
  }
  return doc.save()
}

/** Every stream in the file, decompressed, as text: to look for what a page said. */
async function everyStream(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  let all = ''
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const filter = obj.dict.lookup(PDFName.of('Filter'))
    let data = obj.contents
    if (filter === PDFName.of('FlateDecode')) {
      try {
        data = inflateSync(data)
      } catch {}
    }
    all += Buffer.from(data).toString('latin1')
  }
  return all
}

const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex').toUpperCase()

async function pagesSay(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  const out: string[] = []
  for (const page of doc.getPages()) {
    const contents = page.node.Contents()
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((r) => doc.context.lookup(r))
        : [contents ? doc.context.lookup(page.node.get(PDFName.of('Contents'))) : null]
    let text = ''
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue
      const f = s.dict.lookup(PDFName.of('Filter'))
      text += Buffer.from(f ? inflateSync(s.contents) : s.contents).toString('latin1')
    }
    const found = ['Page 1', 'Page 2', 'Page 3', 'Page 4', 'A1', 'B1', 'B2'].filter((w) =>
      text.includes(`<${hex(w)}>`),
    )
    out.push(found[0] ?? '?')
  }
  return out
}

/**
 * Two pages built the ways real producers tie pages together: one Resources list shared by both
 * (holding a form only page 2 draws, saying SECRETFORM), a form field with a widget on each page
 * (its value SECRETVALUE), and a link on page 1 that jumps to page 2 through an indirect
 * destination. Page 2 itself says "Page 2".
 */
async function tangledPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const ctx = doc.context
  const p1 = doc.addPage([400, 400])
  const p2 = doc.addPage([400, 400])
  p1.drawText('Page 1', { x: 50, y: 300, size: 20, font })
  p2.drawText('Page 2', { x: 50, y: 300, size: 20, font })
  const form = ctx.register(
    ctx.stream('BT /F1 12 Tf 10 10 Td (SECRETFORM) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 200, 50],
    }),
  )
  for (const page of [p1, p2]) {
    const res = page.node.Resources() as PDFDict
    const xo = (res.lookup(PDFName.of('XObject')) as PDFDict | undefined) ?? ctx.obj({})
    xo.set(PDFName.of('Secret'), form)
    res.set(PDFName.of('XObject'), xo)
  }
  const p2draw = ctx.register(ctx.stream('q /Secret Do Q'))
  const p2contents = p2.node.get(PDFName.of('Contents'))
  p2.node.set(PDFName.of('Contents'), ctx.obj([p2contents as PDFRef, p2draw]))
  const field = ctx.obj({
    FT: 'Tx',
    T: PDFString.of('name'),
    V: PDFString.of('SECRETVALUE'),
  }) as PDFDict
  const fieldRef = ctx.register(field)
  const w1 = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [0, 0, 10, 10],
      Parent: fieldRef,
      P: p1.ref,
    }),
  )
  const w2 = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [0, 0, 10, 10],
      Parent: fieldRef,
      P: p2.ref,
    }),
  )
  field.set(PDFName.of('Kids'), ctx.obj([w1, w2]))
  const dest = ctx.register(ctx.obj([p2.ref, 'Fit']))
  const link = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], A: { S: 'GoTo', D: dest } }),
  )
  p1.node.set(PDFName.of('Annots'), ctx.obj([w1, link]))
  p2.node.set(PDFName.of('Annots'), ctx.obj([w2]))
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [fieldRef] }))
  return doc.save()
}

describe('assemble (R2, R3)', () => {
  it('reorders, rotates and removes pages', async () => {
    const src = await makePdf(['Page 1', 'Page 2', 'Page 3'])
    const out = await assemble(
      [src],
      [
        { source: 0, index: 2, rotate: 90 },
        { source: 0, index: 0 },
      ],
    )
    expect(await pagesSay(out)).toEqual(['Page 3', 'Page 1'])
    const doc = await PDFDocument.load(out)
    expect(doc.getPage(0).getRotation().angle).toBe(90)
    expect(doc.getPage(1).getRotation().angle).toBe(0)
  })

  it('adds to a page’s own rotation, and turning left wraps round', async () => {
    const src = await makePdf(['Page 1'], { rotate: 90 })
    const out = await assemble([src], [{ source: 0, index: 0, rotate: 270 }])
    expect((await PDFDocument.load(out)).getPage(0).getRotation().angle).toBe(0)
  })

  it('combines several PDFs in the picked order', async () => {
    const a = await makePdf(['A1'])
    const b = await makePdf(['B1', 'B2'])
    const out = await assemble(
      [a, b],
      [
        { source: 1, index: 1 },
        { source: 0, index: 0 },
        { source: 1, index: 0 },
      ],
    )
    expect(await pagesSay(out)).toEqual(['B2', 'A1', 'B1'])
  })

  it('leaves nothing of a removed page in the file, even when a kept page links to it', async () => {
    const src = await makePdf(['Page 1', 'Page 2'], { linkLastToFirst: true })
    const out = await assemble([src], [{ source: 0, index: 1 }])
    const all = await everyStream(out)
    expect(all).toContain(hex('Page 2'))
    expect(all).not.toContain(hex('Page 1'))
  })

  it('leaves nothing of a removed page behind through shared resources, fields or links', async () => {
    const out = await assemble([await tangledPdf()], [{ source: 0, index: 0 }])
    const all = await everyStream(out)
    expect(all).toContain(hex('Page 1'))
    expect(all).not.toContain(hex('Page 2'))
    expect(all).not.toContain('SECRETFORM')
    expect(Buffer.from(out).toString('latin1')).not.toContain('SECRETVALUE')
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(1)
    // The widget stays; the link to the removed page goes.
    expect(doc.getPage(0).node.Annots()?.size()).toBe(1)
  })

  it('refuses an empty result and a locked or broken file', async () => {
    const src = await makePdf(['Page 1'])
    await expect(assemble([src], [])).rejects.toBeInstanceOf(PdfToolError)
    await expect(assemble([new Uint8Array([1, 2, 3])], [{ source: 0, index: 0 }])).rejects.toThrow(
      'couldn’t be read as a PDF',
    )
    await expect(assemble([src], [{ source: 0, index: 5 }])).rejects.toBeInstanceOf(PdfToolError)
  })

  it('keeps every picked page, whatever the order (property)', async () => {
    const src = await makePdf(['Page 1', 'Page 2', 'Page 3', 'Page 4'])
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 6 }),
        async (order) => {
          const out = await assemble(
            [src],
            order.map((index) => ({ source: 0, index })),
          )
          expect(await pagesSay(out)).toEqual(order.map((i) => `Page ${i + 1}`))
        },
      ),
      { numRuns: 15 },
    )
  })
})

describe('parseRanges (R3)', () => {
  it('reads pages, ranges and open ends', () => {
    expect(parseRanges('1-3, 5, 8-', 9)).toEqual([[0, 1, 2], [4], [7, 8]])
    expect(parseRanges('2 to 3; -2', 4)).toEqual([
      [1, 2],
      [0, 1],
    ])
    expect(parseRanges('4–4', 4)).toEqual([[3]])
  })

  it('says what is wrong in plain words', () => {
    expect(() => parseRanges('', 3)).toThrow('Type the pages')
    expect(() => parseRanges('1-9', 3)).toThrow('this PDF has 3 pages')
    expect(() => parseRanges('3-1', 3)).toThrow('runs backwards')
    expect(() => parseRanges('abc', 3)).toThrow('isn’t a page or a range')
    expect(() => parseRanges('0', 3)).toThrow(PdfToolError)
  })

  it('every page it returns is in the document (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.string(), (pages, text) => {
        try {
          for (const r of parseRanges(text, pages)) {
            for (const p of r) expect(p >= 0 && p < pages).toBe(true)
          }
        } catch (err) {
          expect(err).toBeInstanceOf(PdfToolError)
        }
      }),
    )
  })
})

describe('names (R8)', () => {
  it('names results after the original', () => {
    expect(resultName('Contract.pdf', 'redacted')).toBe('Contract (redacted).pdf')
    expect(resultName('scan.PDF', 'searchable')).toBe('scan (searchable).pdf')
    expect(resultName('', 'combined')).toBe('Document (combined).pdf')
    expect(rangeLabel([0, 1, 2])).toBe('pages 1-3')
    expect(rangeLabel([4])).toBe('page 5')
  })
})

describe('page geometry', () => {
  const box = { x: 0, y: 0, width: 600, height: 800, rotation: 0 }
  it('maps the top-left of the shown page for every rotation', () => {
    expect(toPagePoint(box, 0, 0)).toEqual({ x: 0, y: 800 })
    expect(toPagePoint({ ...box, rotation: 90 }, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(toPagePoint({ ...box, rotation: 180 }, 0, 0)).toEqual({ x: 600, y: 0 })
    expect(toPagePoint({ ...box, rotation: 270 }, 0, 0)).toEqual({ x: 600, y: 800 })
  })
  it('keeps every shown spot on the page (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom(0, 90, 180, 270),
        (fx, fy, rotation) => {
          const p = toPagePoint({ x: 10, y: 20, width: 600, height: 800, rotation }, fx, fy)
          expect(p.x).toBeGreaterThanOrEqual(10 - 1e-9)
          expect(p.x).toBeLessThanOrEqual(610 + 1e-9)
          expect(p.y).toBeGreaterThanOrEqual(20 - 1e-9)
          expect(p.y).toBeLessThanOrEqual(820 + 1e-9)
        },
      ),
    )
  })
})

describe('addTextLayer (R5)', () => {
  it('writes invisible words on the pages it is given', async () => {
    const src = await makePdf(['Page 1', 'Page 2'])
    const out = await addTextLayer(
      src,
      new Map([[1, [{ text: 'Invoice 42', x: 0.1, y: 0.1, width: 0.3, height: 0.03 }]]]),
    )
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(2)
    const all = await everyStream(out)
    expect(all).toContain(hex('Invoice 42'))
    expect(all).toMatch(/\b3 Tr\b/)
  })

  it('turns letters Helvetica can’t hold into close ones', () => {
    expect(winAnsi('“Hi” – café…')).toBe('"Hi" - café...')
    expect(winAnsi('日本')).toBe('??')
  })
})

/** A 2×2 white PNG. */
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8//8/AwMDAwMDAAAh+gL+4mSa/AAAAABJRU5ErkJggg==',
    'base64',
  ),
)

describe('rebuildPages (R7)', () => {
  it('replaces a redacted page with its picture and leaves nothing of it behind', async () => {
    const src = await makePdf(['Page 1', 'Page 2', 'Page 3'], { linkLastToFirst: true })
    const out = await rebuildPages(
      src,
      new Map([
        [
          0,
          {
            bytes: PNG,
            type: 'png' as const,
            words: [{ text: 'Kept words', x: 0.1, y: 0.5, width: 0.3, height: 0.03 }],
          },
        ],
      ]),
    )
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(3)
    const all = await everyStream(out)
    expect(all).not.toContain(hex('Page 1'))
    expect(all).toContain(hex('Page 2'))
    expect(all).toContain(hex('Page 3'))
    expect(all).toContain(hex('Kept words'))
  })

  it('leaves nothing of a redacted page behind through shared resources, fields or links', async () => {
    const out = await rebuildPages(
      await tangledPdf(),
      new Map([[1, { bytes: PNG, type: 'png' as const }]]),
    )
    const all = await everyStream(out)
    expect(all).toContain(hex('Page 1'))
    expect(all).not.toContain(hex('Page 2'))
    expect(all).not.toContain('SECRETFORM')
    expect(Buffer.from(out).toString('latin1')).not.toContain('SECRETVALUE')
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2)
  })

  it('makes the new page the size the old one was shown at', async () => {
    const src = await makePdf(['Page 1'], { rotate: 90, size: [400, 600] })
    const out = await rebuildPages(src, new Map([[0, { bytes: PNG, type: 'png' as const }]]))
    const page = (await PDFDocument.load(out)).getPage(0)
    expect(page.getSize()).toEqual({ width: 600, height: 400 })
    expect(pageBox(page).rotation).toBe(0)
  })
})

async function pdfWithJpeg(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([600, 800])
  page.drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(1, 0, 0) })
  // A fake 1000×1000 JPEG: shrink hands it to the browser part, which the test stands in for.
  const stream = doc.context.stream(new Uint8Array(50_000).fill(7), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: 1000,
    Height: 1000,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'DCTDecode',
  })
  const ref = doc.context.register(stream)
  page.node.newXObject('Im1', ref)
  return doc.save()
}

describe('shrink (R4)', () => {
  const inflate = async (b: Uint8Array) => new Uint8Array(inflateSync(b))

  it('swaps big pictures for smaller ones and says it got smaller', async () => {
    const src = await pdfWithJpeg()
    const calls: Array<{ maxSide: number }> = []
    const result = await shrink(src, 'email', {
      inflate,
      recompress: async (pic, target) => {
        calls.push(target)
        expect(pic).toMatchObject({ kind: 'jpeg', width: 1000, height: 1000, components: 3 })
        return { bytes: new Uint8Array(1000).fill(9), width: 500, height: 500, components: 3 }
      },
    })
    expect(calls).toEqual([{ maxSide: 1400, quality: 0.6 }])
    expect(result.smaller).toBe(true)
    expect(result.pictures).toBe(1)
    expect(result.bytes.length).toBeLessThan(src.length - 40_000)
    const doc = await PDFDocument.load(result.bytes)
    const images = [...doc.context.enumerateIndirectObjects()].filter(
      ([, o]) =>
        o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
    )
    expect(images).toHaveLength(1)
    const dict = (images[0] as [unknown, PDFRawStream])[1].dict
    expect(dict.get(PDFName.of('Width'))?.toString()).toBe('500')
  })

  it('Keep quality leaves pictures alone', async () => {
    const src = await pdfWithJpeg()
    const result = await shrink(src, 'keep', {
      inflate,
      recompress: async () => {
        throw new Error('not called')
      },
    })
    expect(result.pictures).toBe(0)
  })

  it('keeps the original when nothing got smaller', async () => {
    const src = await pdfWithJpeg()
    const result = await shrink(src, 'balanced', {
      inflate,
      recompress: async () => null,
    })
    if (!result.smaller) expect(result.bytes).toBe(src)
    else expect(result.bytes.length).toBeLessThan(src.length)
  })
})
