import { describe, expect, it } from 'vitest'
import { stampForServer } from './stamp'

const generic = { manifest_version: 3, name: 'Hotsauce', action: { default_popup: 'popup.html' } }

describe('stampForServer', () => {
  it('runs the bridge on the server’s pages and names the server', () => {
    const { manifest, serverJson } = stampForServer(generic, {
      url: 'https://hotsauce.acme.com/docs',
      name: 'Acme Office',
    })
    expect(manifest.content_scripts).toEqual([
      { matches: ['https://hotsauce.acme.com/*'], js: ['bridge.js'], run_at: 'document_start' },
    ])
    expect(manifest.name).toBe('Acme Office')
    expect(manifest.action).toEqual({ default_popup: 'popup.html', default_title: 'Acme Office' })
    expect(JSON.parse(serverJson)).toEqual({
      url: 'https://hotsauce.acme.com',
      name: 'Acme Office',
    })
  })
  it('covers both dev ports on localhost', () => {
    const { manifest } = stampForServer(generic, { url: 'http://localhost:5173', name: '' })
    expect((manifest.content_scripts as Array<{ matches: string[] }>)[0]?.matches).toEqual([
      'http://localhost/*',
    ])
    expect(manifest.name).toBe('Hotsauce')
  })
})
