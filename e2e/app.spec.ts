import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'

test.describe('LogEditor shell', () => {
  let electronApp: ElectronApplication | null = null
  let page: Page | null = null

  test.afterEach(async () => {
    if (electronApp) {
      await electronApp.close()
      electronApp = null
    }
  })

  test('renders the welcome view and exposes preload APIs', async () => {
    electronApp = await electron.launch({ args: ['.'] })
    page = await electronApp.firstWindow()

    await expect(page.getByRole('heading', { name: 'Welcome to LogEditor' })).toBeVisible({
      timeout: 15_000
    })

    const apiShape = await page.evaluate(() => ({
      hasApi: typeof window.api === 'object',
      hasOpenFileDialog: typeof window.api?.openFileDialog === 'function'
    }))

    expect(apiShape.hasApi).toBe(true)
    expect(apiShape.hasOpenFileDialog).toBe(true)
  })
})
