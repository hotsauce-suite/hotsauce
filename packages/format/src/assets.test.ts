import { describe, expect, it } from 'vitest'
import { assetPath } from './assets.js'

const ID = '01JA2Z8Q4M7V3K9R5T1XWYB6CD'
const october = new Date(2026, 9, 7, 14, 3)

describe('assetPath', () => {
  it('files by year and month, with a slug and the last eight characters of the id', () => {
    expect(assetPath('Sales Funnel.png', october, ID)).toBe(
      'assets/2026/10/sales-funnel-1XWYB6CD.png',
    )
  })

  it('pads the month', () => {
    expect(assetPath('a.png', new Date(2026, 0, 31), ID)).toBe('assets/2026/01/a-1XWYB6CD.png')
  })

  it('keeps two pastes of the same file in the same second apart', () => {
    const first = assetPath('image.png', october, '01JA2Z8Q4M7V3K9R5T1XWYB6CD')
    const second = assetPath('image.png', october, '01JA2Z8Q4MZZZZZZZZZZZZZZZZ')
    expect(first).not.toBe(second)
  })

  it('drops any directory a browser or OS put in the name', () => {
    expect(assetPath('C:\\fakepath\\Screen Shot 2026.PNG', october, ID)).toBe(
      'assets/2026/10/screen-shot-2026-1XWYB6CD.png',
    )
    expect(assetPath('photos/trip/IMG_0042.JPEG', october, ID)).toBe(
      'assets/2026/10/img-0042-1XWYB6CD.jpeg',
    )
  })

  it('uses only the last extension and cleans it', () => {
    expect(assetPath('data.tar.gz', october, ID)).toBe('assets/2026/10/data-tar-1XWYB6CD.gz')
    expect(assetPath('weird.p-n g', october, ID)).toBe('assets/2026/10/weird-1XWYB6CD.png')
  })

  it('handles names without an extension or without a usable stem', () => {
    expect(assetPath('README', october, ID)).toBe('assets/2026/10/readme-1XWYB6CD')
    expect(assetPath('.env', october, ID)).toBe('assets/2026/10/env-1XWYB6CD')
    expect(assetPath('写真.jpg', october, ID)).toBe('assets/2026/10/untitled-1XWYB6CD.jpg')
  })
})
