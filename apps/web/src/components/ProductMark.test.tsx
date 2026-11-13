import { readFileSync } from 'node:fs'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProductMark } from './Icon'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const shapes = (svg: string) => [...svg.matchAll(/ d="([^"]+)"|<rect ([^>]+?)\/?>/g)].length
const paths = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])

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
  })
})
