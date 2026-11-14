import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

// The setup wizard on a brand-new instance (playwright.config.ts starts it on its own port, in
// setup mode, under the container entrypoint so finishing can restart it). One test walks the
// whole thing, because finishing changes the instance for good.

const BASE = `http://localhost:${process.env.E2E_SETUP_PORT ?? 3998}`
test.use({ baseURL: BASE })
test.describe.configure({ mode: 'serial' })

const token = () =>
  readFileSync(
    path.join(process.env.HOTSAUCE_E2E_SETUP_DIR ?? '', 'org', 'setup-token'),
    'utf8',
  ).trim()

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1d4ed8"/><script>alert(1)</script></svg>`
// Shaped like Clerk keys; never sent to Clerk here (the Test button isn't pressed).
const PK = `pk_test_${Buffer.from('acme-e2e.clerk.accounts.dev$').toString('base64')}`
const SK = 'sk_test_e2eNeverShownAgain1234'

test('a fresh instance only offers the wizard, and only with the setup link', async ({
  page,
  request,
}) => {
  const health = await (await request.get('/api/health')).json()
  expect(health).toMatchObject({ authMode: 'setup', setupRequired: true, productName: 'Hotsauce' })

  // Nothing else works: no session can exist yet.
  expect((await request.get('/api/me')).status()).toBe(401)
  // The wizard's API needs the token.
  expect((await request.get('/api/setup/state')).status()).toBe(401)
  expect(
    (await request.get('/api/setup/state', { headers: { 'x-setup-token': 'nope' } })).status(),
  ).toBe(401)

  // Any page leads to the wizard, which asks for the link.
  await page.goto('/docs')
  await expect(page).toHaveURL(`${BASE}/setup`)
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible()
  await expect(page.getByText('fly logs | grep setup')).toBeVisible()
})

test('walks a new organization from the setup link to a branded sign-in page', async ({
  page,
  request,
}) => {
  // Finishing spends the token, so keep it for the checks after.
  const setupToken = token()
  await page.goto(`/setup#token=${setupToken}`)
  // The token leaves the address bar at once.
  await expect(page).toHaveURL(`${BASE}/setup`)
  await expect(page.getByRole('heading', { name: 'Welcome to Hotsauce' })).toBeVisible()
  await page.getByTestId('setup-start').click()

  // Organization. An admin outside the allowed domains is caught before launch.
  await expect(page.getByTestId('setup-step-org')).toBeVisible()
  await page.getByTestId('org-name').fill('Acme Labs')
  await page.getByTestId('product-name').fill('Acme')
  await page.getByTestId('allowed-domains').fill('acme.test')
  await page.getByTestId('admin-emails').fill('not-an-email')
  await page.getByTestId('org-section-save').click()
  await expect(page.getByRole('alert')).toContainText('valid email')
  await page.getByTestId('admin-emails').fill('ada@acme.test')
  await page.getByTestId('org-section-save').click()

  // Brand: it resumes here after a reload, with the token kept for this tab only.
  await expect(page.getByTestId('setup-step-brand')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('setup-step-brand')).toBeVisible()
  await page.getByTestId('brand-primary').fill('#1d4ed8')
  await page.getByTestId('brand-fonts').selectOption('modern')
  await page.getByTestId('upload-logo').setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(LOGO),
  })
  await expect(page.getByTestId('brand-preview').locator('img')).toBeVisible()
  // The preview shows the draft color before anything is saved.
  const previewEmber = await page
    .getByTestId('brand-preview')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--ember').trim())
  expect(previewEmber).toBe('#1d4ed8')
  await page.getByTestId('brand-voice').fill('Plain and short.')
  await page.getByTestId('brand-section-save').click()

  // Sign-in. The secret goes in, and never comes back out.
  await expect(page.getByTestId('setup-step-signin')).toBeVisible()
  await page.getByTestId('clerk-pk').fill(PK)
  await page.getByTestId('clerk-sk').fill(SK)
  await page.getByTestId('signin-section-save').click()
  await expect(page.getByTestId('setup-step-ai')).toBeVisible()
  const state = await (
    await request.get('/api/setup/state', { headers: { 'x-setup-token': setupToken } })
  ).text()
  expect(state).not.toContain(SK)
  expect(state).toContain('"last4":"1234"')
  // Nor is it stored in the clear.
  const secrets = readFileSync(
    path.join(process.env.HOTSAUCE_E2E_SETUP_DIR ?? '', 'org', 'secrets.json'),
    'utf8',
  )
  expect(secrets).not.toContain(SK)

  // AI keys are optional.
  await page.getByTestId('step-skip').click()

  // Files: on this server.
  await expect(page.getByTestId('setup-step-storage')).toBeVisible()
  await expect(page.getByTestId('host-local')).toBeChecked()
  // A Forgejo server and any S3-compatible bucket are on offer too (docs/PLAN-backups-storage.md).
  await page.getByTestId('host-forgejo').check()
  await expect(page.getByTestId('forgejo-url')).toBeVisible()
  await expect(page.getByTestId('test-forgejo')).toBeVisible()
  await page.getByTestId('host-local').check()
  await expect(page.getByTestId('forgejo-fields')).toHaveCount(0)
  await page.getByText('Storage bucket (optional)').click()
  await page.getByTestId('storage-s3').check()
  await expect(page.getByTestId('s3-endpoint')).toBeVisible()
  await expect(page.getByTestId('s3-region')).toBeVisible()
  if (process.env.HOTSAUCE_E2E_SHOTS) {
    await page.screenshot({
      path: `${process.env.HOTSAUCE_E2E_SHOTS}/wizard-storage.png`,
      fullPage: true,
    })
  }
  await page.getByTestId('storage-r2').check()
  await page.getByTestId('storage-section-save').click()

  // Review and launch.
  await expect(page.getByTestId('setup-step-review')).toBeVisible()
  const summary = page.getByTestId('org-summary')
  await expect(summary).toContainText('Acme Labs')
  await expect(summary).toContainText('@acme.test')
  await expect(summary).toContainText('ada@acme.test')
  await expect(page.getByTestId('setup-missing')).toHaveCount(0)
  await page.getByTestId('setup-finish').click()
  await expect(page.getByTestId('setup-restarting')).toBeVisible()

  // The server restarts with the new settings, and the wizard hands over to sign-in.
  await expect(page).toHaveURL(`${BASE}/sign-in`, { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Acme' })).toBeVisible()
  await expect(page.getByText('Sign in with your acme.test account')).toBeVisible()
  const ember = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ember').trim(),
  )
  expect(ember).toBe('#1d4ed8')

  const health = await (await request.get('/api/health')).json()
  expect(health).toMatchObject({
    authMode: 'clerk',
    setupRequired: false,
    productName: 'Acme',
    orgName: 'Acme Labs',
    clerkPublishableKey: PK,
    signInDomain: 'acme.test',
  })
  const manifest = await (await request.get('/manifest.webmanifest')).json()
  expect(manifest.name).toBe('Acme')
  // The served page carries the name before the app boots, on any route.
  expect(await (await request.get('/')).text()).toContain('<title>Acme</title>')
  expect(await (await request.get('/docs/anything')).text()).toContain('<title>Acme</title>')

  // The logo is served so its script can't run.
  const logo = await request.get('/api/org/assets/logo')
  expect(logo.headers()['content-security-policy']).toContain('sandbox')

  // The wizard is closed for good, and the link is spent.
  expect(
    (await request.get('/api/setup/state', { headers: { 'x-setup-token': setupToken } })).status(),
  ).toBe(403)
  await page.goto('/setup')
  await expect(page.getByRole('heading', { name: 'Already set up' })).toBeVisible()
})

test('an instance configured by its environment never shows the wizard', async ({
  page,
  request,
}) => {
  // The main e2e server, set up entirely through in env, no wizard.
  const main = `http://localhost:${process.env.E2E_PORT ?? 3999}`
  expect((await (await request.get(`${main}/api/health`)).json()).setupRequired).toBe(false)
  expect(
    (await request.get(`${main}/api/setup/state`, { headers: { 'x-setup-token': 'x' } })).status(),
  ).toBe(403)
  await page.goto(`${main}/setup`)
  await expect(page.getByRole('heading', { name: 'Already set up' })).toBeVisible()
})
