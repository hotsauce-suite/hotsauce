import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { CUSTOM_THEME_KEY, currentTheme, THEME_KEY } from '../lib/theme'
import { server } from '../test/mockServer'
import { renderApp } from '../test/renderApp'

// docs/PLAN-ai-themes.md: making, previewing, keeping, renaming and deleting a theme of your own.

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.getElementById('hotsauce-custom-theme')?.remove()
  document.getElementById('hotsauce-custom-theme-fonts')?.remove()
})

const root = document.documentElement
const customCss = () => document.getElementById('hotsauce-custom-theme')?.textContent ?? ''

async function make(user: ReturnType<typeof userEvent.setup>, words: string) {
  await user.type(await screen.findByTestId('theme-prompt'), words)
  await user.click(screen.getByTestId('theme-make'))
  await screen.findByTestId('theme-preview', {}, { timeout: 3000 })
}

describe('Appearance: themes of your own', () => {
  it('previews a described theme across the app, and Discard puts the old look back (R2)', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    await make(user, 'midnight blue')
    expect(screen.getByTestId('theme-preview')).toHaveTextContent('Previewing Midnight Harbor')
    expect(root.dataset.theme).toBe('custom')
    expect(customCss()).toContain('color-scheme: dark')
    // Nothing is kept until Keep.
    expect(localStorage.getItem(THEME_KEY)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(root.hasAttribute('data-theme')).toBe(false)
    expect(customCss()).toBe('')
  })

  it('refines the preview with a follow-up, sending the previewed theme', async () => {
    const user = userEvent.setup()
    const sent: unknown[] = []
    server.events.on('request:start', async ({ request }) => {
      if (request.url.endsWith('/api/themes/generate')) sent.push(await request.clone().json())
    })
    renderApp('/settings')
    await make(user, 'midnight')
    await user.type(screen.getByTestId('theme-prompt'), 'a pastel take')
    await user.click(screen.getByTestId('theme-make'))
    await waitFor(() => expect(screen.getByTestId('theme-preview')).toHaveTextContent('Pastel'))
    expect(sent[1]).toMatchObject({ prompt: 'a pastel take', base: { name: 'Midnight Harbor' } })
    server.events.removeAllListeners()
  })

  it('keeps a theme: it joins the list, is in use, and is ready to paint on reload (R5, R8)', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    await make(user, 'retro terminal')
    await user.click(screen.getByTestId('theme-keep'))
    const card = await screen.findByTestId('own-theme')
    expect(card).toHaveTextContent('Green Phosphor')
    expect(card).toHaveTextContent('“retro terminal”')
    expect(within(card).getByRole('radio')).toBeChecked()
    expect(currentTheme()).toMatch(/^custom:/)
    expect(JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY) ?? '{}').css).toContain(
      'html:root[data-theme="custom"]',
    )

    // Back to Light, then to the theme again.
    await user.click(screen.getByTestId('theme-light'))
    expect(root.dataset.theme).toBe('light')
    expect(customCss()).toBe('')
    await user.click(within(card).getByRole('radio'))
    expect(root.dataset.theme).toBe('custom')
  })

  it('renames and deletes a theme; deleting the one in use goes back to the device’s look (R9)', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    await make(user, 'forest')
    await user.click(screen.getByTestId('theme-keep'))
    const card = await screen.findByTestId('own-theme')

    await user.click(within(card).getByRole('button', { name: 'Rename' }))
    const box = within(card).getByRole('textbox', { name: 'Theme name' })
    await user.clear(box)
    await user.type(box, 'Cabin{Enter}')
    await waitFor(() => expect(card).toHaveTextContent('Cabin'))

    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByTestId('own-theme')).toBeNull())
    expect(currentTheme()).toBe('system')
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('marks a theme light or dark for the styles that follow the scheme', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    await make(user, 'midnight')
    expect(root.dataset.scheme).toBe('dark')
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(root.hasAttribute('data-scheme')).toBe(false)
  })

  it('picking another look ends the preview', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    await make(user, 'midnight')
    await user.click(screen.getByTestId('theme-light'))
    expect(screen.queryByTestId('theme-preview')).toBeNull()
    expect(root.dataset.theme).toBe('light')
    expect(customCss()).toBe('')
  })

  it('drops a theme that arrives after leaving Settings', async () => {
    let answer: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      answer = resolve
    })
    server.use(
      http.post('/api/themes/generate', async () => {
        await gate
        const { sampleThemeFor } = await import('@hotsauce/format')
        return HttpResponse.json({ theme: sampleThemeFor('midnight') })
      }),
    )
    const user = userEvent.setup()
    const { router } = renderApp('/settings')
    await user.type(await screen.findByTestId('theme-prompt'), 'midnight')
    await user.click(screen.getByTestId('theme-make'))
    await router.navigate('/tasks')
    await screen.findByTestId('tasks-app', {}, { timeout: 3000 }).catch(() => undefined)
    answer?.()
    await new Promise((r) => setTimeout(r, 50))
    expect(root.hasAttribute('data-theme')).toBe(false)
    expect(customCss()).toBe('')
  })

  it('forgets a theme in use here that was deleted on another device (R9)', async () => {
    const { DEFAULT_LIGHT_THEME } = await import('@hotsauce/format')
    const { chooseTheme } = await import('../lib/theme')
    const { forgetDeletedTheme } = await import('./AppearanceSettings')
    chooseTheme('custom:01GONE0000000000000000000', DEFAULT_LIGHT_THEME)
    expect(root.dataset.theme).toBe('custom')
    await forgetDeletedTheme()
    expect(currentTheme()).toBe('system')
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('shows why when the instance has no AI, and no box (R10)', async () => {
    server.use(http.get('/api/themes', () => HttpResponse.json({ themes: [], canGenerate: false })))
    renderApp('/settings')
    expect(await screen.findByTestId('theme-no-ai')).toHaveTextContent('Anthropic key')
    expect(screen.queryByTestId('theme-prompt')).toBeNull()
  })

  it('says so when a description makes no theme, and changes nothing (R3)', async () => {
    server.use(
      http.post('/api/themes/generate', () =>
        HttpResponse.json(
          { error: { code: 'bad_request', message: "Couldn't make a theme from that." } },
          { status: 400 },
        ),
      ),
    )
    const user = userEvent.setup()
    renderApp('/settings')
    await user.type(await screen.findByTestId('theme-prompt'), 'hmm')
    await user.click(screen.getByTestId('theme-make'))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't make a theme")
    expect(root.hasAttribute('data-theme')).toBe(false)
  })
})
