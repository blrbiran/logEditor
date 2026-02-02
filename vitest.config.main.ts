import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const rootDir = dirname(fileURLToPath(import.meta.url))
const fromRoot = (...paths: string[]): string => resolve(rootDir, ...paths)

export default defineConfig({
  test: {
    name: 'main-process',
    environment: 'node',
    globals: true,
    include: ['src/main/**/*.test.ts', 'src/common/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: fromRoot('coverage/unit')
    }
  },
  resolve: {
    alias: {
      '@renderer': fromRoot('src/renderer/src'),
      '@main': fromRoot('src/main')
    }
  }
})
