import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import type { LogEditorApi } from '../src/common/ipc'

declare global {
  interface Window {
    api: LogEditorApi
    electron: {
      path: {
        basename(value: string): string
      }
    }
  }
}

const createApiStub = (): LogEditorApi => {
  const cache = new Map<PropertyKey, ReturnType<typeof vi.fn>>()

  const buildStub = (property: PropertyKey): ReturnType<typeof vi.fn> => {
    if (typeof property === 'string' && property.startsWith('on')) {
      return vi.fn(() => () => {})
    }
    return vi.fn()
  }

  return new Proxy(
    {},
    {
      get(_target, property) {
        if (!cache.has(property)) {
          cache.set(property, buildStub(property))
        }
        return cache.get(property)
      }
    }
  ) as unknown as LogEditorApi
}

const ensureElectronGlobals = (): void => {
  window.electron =
    window.electron ??
    ({
      path: {
        basename: (value: string) => value.split(/[/\\]/).pop() ?? value
      }
    } as Window['electron'])
}

const apiStub = createApiStub()
window.api = apiStub
ensureElectronGlobals()

beforeEach(() => {
  vi.clearAllMocks()
  ensureElectronGlobals()
})
