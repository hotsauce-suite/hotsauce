import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/renderApp'

const extension = vi.hoisted(() => ({ version: null as string | null }))
vi.mock('./audio/extension', () => ({
  extensionVersion: async () => extension.version,
}))

const release = vi.hoisted(() => ({ store: null as string | null, bundled: '0.8.0', runs: true }))
vi.mock('./extensionRelease', async (importActual) => {
  const actual = await importActual<typeof import('./extensionRelease')>()
  return {
    ...actual,
    get BUNDLED_EXTENSION_VERSION() {
      return release.bundled
    },
    get CHROME_WEB_STORE_URL() {
      return release.store
    },
    canRunExtension: () => release.runs,
  }
})

beforeEach(() => {
  extension.version = null
  release.store = null
  release.bundled = '0.8.0'
  release.runs = true
})
afterEach(() => vi.clearAllMocks())

describe('Chrome extension page', () => {
  it('offers the download and the steps to load it', async () => {
    renderApp('/meetings/extension')
    expect(await screen.findByTestId('extension-download')).toHaveAttribute(
      'href',
      '/downloads/hotsauce-meetings-chrome.zip',
    )
    expect(screen.getByText(/Load unpacked/)).toBeInTheDocument()
    expect(screen.queryByTestId('extension-store')).not.toBeInTheDocument()
    expect(await screen.findByTestId('extension-missing')).toHaveTextContent('Not found')
  })

  it('says when it is installed and current', async () => {
    extension.version = '0.8.0'
    renderApp('/meetings/extension')
    expect(await screen.findByTestId('extension-installed')).toHaveTextContent('version 0.8.0')
    expect(screen.queryByTestId('extension-update')).not.toBeInTheDocument()
  })

  it('says when a newer version is ready', async () => {
    extension.version = '0.7.0'
    renderApp('/meetings/extension')
    const update = await screen.findByTestId('extension-update')
    expect(update).toHaveTextContent('Version 0.7.0 is installed')
    expect(update).toHaveTextContent('Version 0.8.0 is ready')
  })

  it('offers Add to Chrome once the store listing is set, with the by-hand install under it', async () => {
    release.store = 'https://chromewebstore.google.com/detail/hotsauce/abc'
    renderApp('/meetings/extension')
    expect(await screen.findByTestId('extension-store')).toHaveAttribute('href', release.store)
    expect(screen.getByText('Install it by hand instead')).toBeInTheDocument()
  })

  it('says it needs Chrome on a computer elsewhere', async () => {
    release.runs = false
    renderApp('/meetings/extension')
    expect(await screen.findByTestId('extension-elsewhere')).toHaveTextContent(
      'Chrome on a computer',
    )
  })

  it('explains a call, troubleshooting, and the Mac app', async () => {
    renderApp('/meetings/extension')
    expect(await screen.findByTestId('extension-how')).toHaveTextContent('Start recording')
    expect(screen.getByTestId('extension-trouble')).toHaveTextContent('Chrome asked what to share')
    expect(screen.getByTestId('extension-mac')).toHaveTextContent('Take notes for')
  })
})
