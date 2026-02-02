import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import type { OpenedFile } from '@renderer/env'
import { isFileTab, type FileTab } from './tab-types'
import { useTabsController } from './useTabsController'

describe('useTabsController', () => {
  it('deduplicates opened files by path and keeps windowed metadata', async () => {
    const syncSpy = window.api.syncTabState as unknown as Mock
    const files: OpenedFile[] = [
      {
        filePath: '/tmp/example.log',
        name: 'example.log',
        content: 'partial chunk',
        size: 5 * 1024 * 1024,
        loadedBytes: 512 * 1024,
        isTruncated: true,
        chunkSize: 512 * 1024,
        lineCount: 100,
        loadedLineCount: 50
      },
      {
        filePath: '/tmp/example.log',
        name: 'example.log',
        content: 'stale chunk',
        size: 5 * 1024 * 1024,
        loadedBytes: 256 * 1024,
        isTruncated: true,
        chunkSize: 512 * 1024,
        lineCount: 100,
        loadedLineCount: 25
      }
    ]

    const { result } = renderHook(() => useTabsController())

    await act(async () => {
      result.current.openFilesFromContent(files)
      await Promise.resolve()
    })

    const fileTabs = result.current.tabs.filter((tab): tab is FileTab => isFileTab(tab))

    expect(fileTabs).toHaveLength(1)
    const [tab] = fileTabs
    expect(tab?.filePath).toBe('/tmp/example.log')
    expect(tab?.isWindowed).toBe(true)
    expect(tab?.isActive).toBe(true)
    expect(tab?.windowOverlap).toBeGreaterThan(0)
    expect(syncSpy).toHaveBeenCalled()
  })
})
