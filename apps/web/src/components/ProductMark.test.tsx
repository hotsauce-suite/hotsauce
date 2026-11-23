import { readFileSync } from 'node:fs'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProductMark } from './Icon'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const shapes = (svg: string) => [...svg.matchAll(/ d="([^"]+)"|<rect ([^>]+?)\/?>/g)].length
const paths = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])
/** Every rect and path with all its attributes, so a changed size, colour or stroke shows up. */
const drawing = (svg: string) =>
  [...svg.matchAll(/<(rect|path)\s([^>]*?)\/?>/g)].map(([, tag, attrs = '']) =>
    [
      tag,
      ...[...attrs.matchAll(/([\w-]+)="([^"]*)"/g)]
        .map(([, k = '', v]) => `${k.toLowerCase()}=${v}`)
        .sort(),
    ].join(' '),
  )

describe('the default mark', () => {
  const favicon = read('../../public/favicon.svg')

  it('is the Hotsauce bottle from hotsauce.work, not the old flame', () => {
    expect(favicon).toBe(read('../../../../site/public/favicon.svg'))
    expect(favicon).toContain('<title>Hotsauce</title>')
  })

  it('draws in the app exactly as the favicon does', () => {
    const { container } = render(<ProductMark />)
    const svg = container.innerHTML
    expect(paths(svg)).toEqual(paths(favicon))
    expect(shapes(svg)).toBe(shapes(favicon))
    expect(drawing(svg)).toEqual(drawing(favicon))
  })

  it('is the tuned bottle: the big label, the bold flame and the glint on the glass', () => {
    expect(favicon).toContain('<rect x="18.5" y="33" width="27" height="19.5" rx="4"')
    expect(favicon).toContain('d="M21.5 31.5C22.7 29.1 24.7 27.3 26.8 25.9"')
    expect(favicon).toContain('A6.885 6.885')
  })

  it('is the same drawing inline on every hotsauce.work page that shows it', () => {
    const inner = favicon
      .trim()
      .replace(/^<svg[^>]*><title>Hotsauce<\/title>/, '')
      .replace(/<\/svg>$/, '')
    for (const page of ['index.html', 'faq.html', 'help/index.html', 'help/docs.html']) {
      expect(read(`../../../../site/public/${page}`)).toContain(inner)
    }
  })
})
