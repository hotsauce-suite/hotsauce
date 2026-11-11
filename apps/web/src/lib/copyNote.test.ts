import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyAsRichText, htmlForCopy, markdownForCopy } from './copyNote'

const NOTE = '---\ntype: meeting\nai_ranges: [[1, 2]]\n---\n\n# Acme sync\n\n- [ ] Send the deck\n'

describe('copying a note', () => {
  it('leaves the frontmatter out of the markdown', () => {
    expect(markdownForCopy(NOTE)).toBe('# Acme sync\n\n- [ ] Send the deck\n')
    expect(markdownForCopy('# Plain\n')).toBe('# Plain\n')
  })

  it('renders rich text with headings and task lists, and no frontmatter', async () => {
    const html = await htmlForCopy(NOTE)
    expect(html).toContain('<h1>Acme sync</h1>')
    expect(html).toContain('type="checkbox"')
    expect(html).not.toContain('ai_ranges')
  })
})

describe('copyAsRichText', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('writes to the clipboard before the HTML is ready, as Safari requires', async () => {
    const items: Array<Record<string, unknown>> = []
    let wroteBeforeHtml = false
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly data: Record<string, unknown>) {
          items.push(data)
        }
      },
    )
    const write = vi.fn(async (list: Array<{ data: Record<string, unknown> }>) => {
      wroteBeforeHtml = list[0]?.data['text/html'] instanceof Promise
    })
    vi.stubGlobal('navigator', { clipboard: { write, writeText: vi.fn() } })

    await copyAsRichText(NOTE)

    expect(write).toHaveBeenCalledTimes(1)
    expect(wroteBeforeHtml).toBe(true)
    const item = items[0] ?? {}
    const html = await (item['text/html'] as Promise<Blob>)
    expect(await html.text()).toContain('<h1>Acme sync</h1>')
    expect(await (item['text/plain'] as Blob).text()).toBe('# Acme sync\n\n- [ ] Send the deck\n')
  })
})
