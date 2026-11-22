import { describe, expect, it } from 'vitest'
import { makeManifest } from './manifest'
import { stampForServer } from './stamp'

describe('manifest', () => {
  it('makes the setup page the Options page, opened in a tab (R2)', () => {
    const manifest = makeManifest('Hotsauce', '0.8.0')
    expect(manifest.options_ui).toEqual({ page: 'setup.html', open_in_tab: true })
    expect(manifest.version).toBe('0.8.0')
  })
  it('keeps the Options page in a copy stamped for one server', () => {
    const stamped = stampForServer(makeManifest('Acme', '0.8.0'), {
      url: 'https://hotsauce.acme.com',
      name: 'Acme',
    })
    expect(stamped.manifest.options_ui).toEqual({ page: 'setup.html', open_in_tab: true })
  })
})
