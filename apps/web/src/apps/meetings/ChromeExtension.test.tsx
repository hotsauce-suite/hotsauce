import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/renderApp'

const extension = vi.hoisted(() => ({ version: null as string | null }))
vi.mock('./audio/extension', () => ({
  extensionVersion: async () => extension.version,
}))

beforeEach(() => {
  extension.version = null
})

describe('Chrome extension page', () => {
  it('offers the download and the steps to load it', async () => {
    renderApp('/meetings/extension')
    expect(await screen.findByTestId('extension-download')).toHaveAttribute(
      'href',
      '/downloads/hearth-meetings-chrome.zip',
    )
    expect(screen.getByText(/Load unpacked/)).toBeInTheDocument()
    expect(screen.queryByTestId('extension-installed')).not.toBeInTheDocument()
  })

  it('says when it is already installed in this browser', async () => {
    extension.version = '0.1.0'
    renderApp('/meetings/extension')
    expect(await screen.findByTestId('extension-installed')).toHaveTextContent('version 0.1.0')
  })
})
