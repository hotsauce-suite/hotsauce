import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { type DownloadInputs, fileName, type ReadyImage, wash } from './inputs'
import { docModel, imageSources, taskSources } from './model'
import { toDocx } from './toDocx'
import { pdfDefinition } from './toPdf'

const DOC = `---
id: 01ABC
title: Plan
secret: frontmatter-only
---
# Launch plan

Some **bold**, *italic*, ~~gone~~ and \`code\` with a [link](https://example.com) and a [doc](../other.md).

- one
  - nested
- two

1. first
2. second

- [x] done thing
- [ ] open thing

> [!note] Heads up
> Quoted words

\`\`\`
const x = 1
\`\`\`

| Name | Count |
| :--- | ----: |
| Apples | 3 |

---

![Chart](../assets/chart.png)

\`\`\`tasks
status: open
\`\`\`
`

// 1×1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)
const image: ReadyImage = { bytes: PNG, type: 'png', width: 1, height: 1 }

const link = (href: string) =>
  /^https?:/.test(href) ? href : `https://hotsauce.test/docs/team/${href.replace('../', '')}`

function inputs(over: Partial<DownloadInputs> = {}): DownloadInputs {
  return {
    brand: {
      orgName: 'Acme',
      primary: '#1144aa',
      displayFont: 'Fraunces',
      uiFont: 'IBM Plex Sans',
      logo: null,
    },
    fonts: { display: {}, ui: {} },
    images: new Map([['../assets/chart.png', image]]),
    tasks: new Map([['status: open', [{ title: 'Ship it', done: false }]]]),
    ...over,
  }
}

async function documentXml(blob: Blob): Promise<Record<string, string>> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  return Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => name.endsWith('.xml') || name.endsWith('.rels'))
      .map(([name, bytes]) => [name, strFromU8(bytes)]),
  )
}

describe('the doc model', () => {
  const model = docModel(DOC, 'Launch plan', link)

  it('leaves the frontmatter out (R4)', () => {
    expect(JSON.stringify(model)).not.toContain('frontmatter-only')
  })

  it('reads every block kind', () => {
    expect(model.blocks.map((b) => b.t)).toEqual([
      'heading',
      'para',
      'list',
      'list',
      'list',
      'quote',
      'code',
      'table',
      'rule',
      'para',
      'tasks',
    ])
  })

  it('makes doc links absolute and keeps marks', () => {
    const para = model.blocks[1]
    expect(para?.t).toBe('para')
    const runs = para?.t === 'para' ? para.inlines : []
    expect(runs).toContainEqual({ t: 'text', text: 'bold', bold: true })
    expect(runs).toContainEqual({ t: 'text', text: 'code', code: true })
    expect(runs).toContainEqual({
      t: 'text',
      text: 'doc',
      href: 'https://hotsauce.test/docs/team/other.md',
    })
  })

  it('lists the images and task queries to fetch first', () => {
    expect(imageSources(model)).toEqual(['../assets/chart.png'])
    expect(taskSources(model)).toEqual(['status: open'])
  })

  it('turns a callout into a quote with a bold title', () => {
    const quote = model.blocks[5]
    expect(quote?.t === 'quote' && quote.blocks[0]).toMatchObject({
      t: 'para',
      inlines: [{ t: 'text', text: 'Heads up', bold: true }],
    })
  })
})

describe('Download as Word (R2, R5, R6)', () => {
  const model = docModel(DOC, 'Launch plan', link)

  it('writes the text, lists, table, links, image and task list', async () => {
    const xml = await documentXml(await toDocx(model, inputs()))
    const body = xml['word/document.xml'] ?? ''
    for (const text of [
      'Launch plan',
      'bold',
      'nested',
      'second',
      'Quoted words',
      'const x = 1',
      'Apples',
      'Ship it',
      '☑',
      '☐',
    ]) {
      expect(body).toContain(text)
    }
    expect(body).not.toContain('frontmatter-only')
    // A run never switches bold off, which would undo a heading style's bold.
    expect(body).not.toContain('<w:b w:val="false"/>')
    expect(body).toContain('w:tbl')
    expect(body).toContain('w:drawing')
    expect(xml['word/_rels/document.xml.rels']).toContain('https://example.com')
    expect(xml['word/_rels/document.xml.rels']).toContain(
      'https://hotsauce.test/docs/team/other.md',
    )
  })

  it('uses the brand fonts and colour', async () => {
    const xml = await documentXml(await toDocx(model, inputs()))
    expect(xml['word/styles.xml']).toContain('Fraunces')
    expect(xml['word/styles.xml']).toContain('IBM Plex Sans')
    expect(xml['word/document.xml']).toContain('1144AA')
    expect(xml['word/document.xml']).toContain(wash('#1144aa').slice(1).toUpperCase())
  })

  it('numbers the pages and puts the logo on page one', async () => {
    const xml = await documentXml(
      await toDocx(model, inputs({ brand: { ...inputs().brand, logo: image } })),
    )
    const footer = Object.entries(xml).find(([name]) => name.startsWith('word/footer'))?.[1]
    expect(footer).toContain('PAGE')
    expect(xml['word/document.xml']?.indexOf('Acme')).toBeLessThan(
      xml['word/document.xml']?.indexOf('Launch plan') ?? 0,
    )
  })

  it('embeds the fonts it was given', async () => {
    const font = new Uint8Array(64).fill(7)
    const blob = await toDocx(
      model,
      inputs({ fonts: { display: { regular: font }, ui: { regular: font, bold: font } } }),
    )
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    expect(
      Object.keys(files).filter((n) => n.startsWith('word/fonts/')).length,
    ).toBeGreaterThanOrEqual(3)
  })

  it('shows a missing image as its alt text', async () => {
    const xml = await documentXml(await toDocx(model, inputs({ images: new Map() })))
    expect(xml['word/document.xml']).toContain('[Chart]')
  })
})

describe('Download as PDF (R3, R5)', () => {
  const model = docModel(DOC, 'Launch plan', link)

  it('lays out every block, in the brand look', () => {
    const def = pdfDefinition(model, inputs())
    const text = JSON.stringify(def.content)
    for (const t of ['Launch plan', 'nested', 'Quoted words', 'const x = 1', 'Apples', 'Ship it']) {
      expect(text).toContain(t)
    }
    expect(text).not.toContain('frontmatter-only')
    expect(text).toContain('https://hotsauce.test/docs/team/other.md')
    expect(text).toContain('#1144aa')
    expect(text).toContain('data:image/png;base64,')
    expect(def.defaultStyle).toMatchObject({ font: 'ui' })
    expect(typeof def.footer).toBe('function')
  })
})

describe('file names (R9)', () => {
  it('names the file after the title, without characters a disk refuses', () => {
    expect(fileName('Q3: plan / budget?', 'docx')).toBe('Q3 plan budget.docx')
    expect(fileName('   ', 'pdf')).toBe('Untitled.pdf')
  })
})

describe('gathering a download', () => {
  it('takes only real font files, not a page a static host sent back', async () => {
    const { isTrueType } = await import('./prepare')
    expect(isTrueType(new Uint8Array([0, 1, 0, 0, 9]))).toBe(true)
    expect(isTrueType(new TextEncoder().encode('OTTO....'))).toBe(true)
    expect(isTrueType(new TextEncoder().encode('<!doctype html>'))).toBe(false)
  })

  it('points doc links at the doc in Hotsauce and drops links that only work inside it', async () => {
    const { linkResolver } = await import('./prepare')
    const link = linkResolver('team', 'docs/plans/q3.md', 'https://hs.example')
    expect(link('https://x.test/a')).toBe('https://x.test/a')
    expect(link('mailto:a@b.test')).toBe('mailto:a@b.test')
    expect(link('../other.md#part')).toMatch(/^https:\/\/hs\.example\/.+other\.md$/)
    expect(link('#part')).toBe('')
  })
})

describe('review fixes', () => {
  it('reads a soft line break as a space, so the PDF does not break lines where the Markdown wraps', () => {
    const model = docModel('one line\nnext line', 'T', link)
    expect(model.blocks[0]).toEqual({
      t: 'para',
      inlines: [{ t: 'text', text: 'one line next line' }],
    })
  })

  it('keeps where a numbered list starts in Word', async () => {
    const model = docModel('3. three\n4. four\n', 'T', link)
    const xml = await documentXml(await toDocx(model, inputs()))
    expect(xml['word/numbering.xml']).toContain('w:start w:val="3"')
  })

  it('keeps images inside table cells in the PDF', () => {
    const model = docModel('| a |\n| - |\n| ![Chart](../assets/chart.png) |\n', 'T', link)
    expect(JSON.stringify(pdfDefinition(model, inputs()).content)).toContain(
      'data:image/png;base64,',
    )
  })

  it('gives plain items in a list with task items a bullet in the PDF', () => {
    const model = docModel('- [ ] task\n- plain\n', 'T', link)
    expect(JSON.stringify(pdfDefinition(model, inputs()).content)).toContain('"text":"•"')
  })

  it('never carries a javascript: link into a file', async () => {
    const { linkResolver } = await import('./prepare')
    const resolve = linkResolver('team', 'docs/a.md', 'https://hs.example')
    expect(resolve('javascript:alert(1)')).toBe('')
    expect(resolve('data:text/html,hi')).toBe('')
  })
})
