import { describe, expect, it } from 'vitest'
import { canRunExtension, isOlder } from './extensionRelease'

describe('isOlder', () => {
  it('compares x.y.z versions', () => {
    expect(isOlder('0.7.0', '0.8.0')).toBe(true)
    expect(isOlder('0.8.0', '0.8.0')).toBe(false)
    expect(isOlder('0.10.0', '0.9.1')).toBe(false)
    expect(isOlder('1.0', '1.0.1')).toBe(true)
  })
  it('says no when either version is unknown', () => {
    expect(isOlder('0.7.0', '')).toBe(false)
    expect(isOlder('dev', '0.8.0')).toBe(false)
  })
})

describe('canRunExtension', () => {
  it('is Chrome or Edge on a computer', () => {
    expect(
      canRunExtension(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
    ).toBe(true)
    expect(
      canRunExtension(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      ),
    ).toBe(true)
  })
  it('is not Safari, the Mac app, Firefox or a phone', () => {
    expect(
      canRunExtension(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      ),
    ).toBe(false)
    expect(
      canRunExtension('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)'),
    ).toBe(false)
    expect(
      canRunExtension('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'),
    ).toBe(false)
    expect(
      canRunExtension(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe(false)
  })
})
