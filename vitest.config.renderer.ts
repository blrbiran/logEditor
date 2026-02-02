import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const rootDir = dirname(fileURLToPath(import.meta.url))
const fromRoot = (...paths: string[]): string => resolve(rootDir, ...paths)

export default defineConfig({
  test: {
    name: 'renderer',
    environment: 'jsdom',
    globals: true,
    setupFiles: [fromRoot('tests/setup-renderer.ts')],
    include: ['src/renderer/src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: fromRoot('coverage/renderer')
    }
  },
  resolve: {
    alias: {
      '@renderer': fromRoot('src/renderer/src'),
      '@': fromRoot('src')
    }
  }
})
