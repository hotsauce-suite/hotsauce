import { describe, expect, it } from 'vitest'
import { convertFile, imageToken, linkImages, UnsupportedImport } from './importDoc'

const file = (name: string, content: BlobPart, type = '') => new File([content], name, { type })

describe('converting a file to a doc', () => {
  it('takes markdown exactly as written, named from its heading', async () => {
    const md = '---\ntags: [a]\n---\n\n# Kiln Log\n\n*  odd  spacing kept\n'
    const doc = await convertFile(file('notes.md', md))
    expect(doc.markdown).toBe(md)
    expect(doc.stem).toBe('kiln-log')
    expect(doc.images).toEqual([])
  })

  it('names markdown without a heading from its file name, and adds nothing', async () => {
    const doc = await convertFile(file('Meeting Notes.txt', 'just text\n'))
    expect(doc.markdown).toBe('just text\n')
    expect(doc.stem).toBe('meeting-notes')
  })

  it('converts a Google Docs HTML export, styled spans and all', async () => {
    const html = `<html><head><style>.c1{}</style></head><body>
      <b id="docs-internal-guid-123" style="font-weight:normal">
      <h1>Launch plan</h1>
      <p><span style="font-weight:700">Bold</span> and <span style="font-style:italic">soft</span>.</p>
      <ul><li>One</li><li>Two</li></ul>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      <img src="data:image/png;base64,iVBORw0KGgo=">
      </b></body></html>`
    const doc = await convertFile(file('export.html', html))
    expect(doc.stem).toBe('launch-plan')
    expect(doc.markdown).toContain('# Launch plan')
    expect(doc.markdown).toContain('**Bold** and *soft*.')
    expect(doc.markdown).toContain('- One\n- Two\n')
    expect(doc.markdown).toMatch(/^\| A +\| B +\|$/m)
    expect(doc.markdown).not.toContain('.c1')
    expect(doc.markdown).toContain(`![](${imageToken(0)})`)
    expect(doc.images).toHaveLength(1)
    expect(doc.images[0]?.type).toBe('image/png')
  })

  it('gives converted HTML without a heading one from the file name', async () => {
    const doc = await convertFile(file('Board memo.htm', '<p>Hello</p>'))
    expect(doc.markdown).toBe('# Board memo\n\nHello\n')
    expect(doc.stem).toBe('board-memo')
  })

  // Word goes through mammoth's browser build, so e2e/import.spec.ts covers it in a real browser.

  it('refuses files it can’t read, saying which', async () => {
    await expect(convertFile(file('deck.pdf', 'x'))).rejects.toBeInstanceOf(UnsupportedImport)
  })

  it('links uploaded images in place of their tokens', () => {
    expect(linkImages(`![](${imageToken(0)}) ![](${imageToken(1)})`, ['../a.png', 'b.png'])).toBe(
      '![](../a.png) ![](b.png)',
    )
  })
})
