import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { createSearchService } from './search-service'

const createTempFile = async (
  name: string,
  content: string
): Promise<{ filePath: string; cleanup: () => Promise<void> }> => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'logeditor-search-'))
  const target = join(dir, name)
  await fs.writeFile(target, content, 'utf-8')
  return {
    filePath: target,
    cleanup: () => fs.rm(dir, { recursive: true, force: true })
  }
}

describe('search service', () => {
  it('searches in-memory tabs with case insensitive queries', async () => {
    const service = createSearchService({ generateId: () => 'search-memory' })
    service.syncTabState({
      id: 'tab-memory',
      title: 'memory.log',
      content: 'foo\nbar\nFoo fighters',
      size: 21,
      isTruncated: false,
      loadedRange: { start: 0, end: 21 }
    })

    const payload = await service.performSearch({
      query: 'foo',
      matchCase: false,
      isRegex: false,
      scope: { kind: 'workspace' }
    })

    expect(payload.results).toHaveLength(1)
    expect(payload.results[0]?.matches.map((match) => match.line)).toEqual([1, 3])
    expect(payload.searchId).toBe('search-memory')
  })

  it('streams truncated files and respects exclude filters', async () => {
    const tempFile = await createTempFile(
      'huge.log',
      ['INFO keep me', 'ERROR ignore me', 'ERROR capture me'].join('\n')
    )

    try {
      const service = createSearchService({ generateId: () => 'search-stream' })
      service.syncTabState({
        id: 'tab-stream',
        title: 'huge.log',
        filePath: tempFile.filePath,
        content: '',
        size: 64,
        isTruncated: true,
        loadedRange: { start: 0, end: 0 }
      })

      const payload = await service.performSearch({
        query: 'ERROR',
        excludeQuery: 'ignore',
        matchCase: true,
        isRegex: false,
        scope: { kind: 'workspace' }
      })

      expect(payload.results).toHaveLength(1)
      expect(payload.results[0]?.matches).toHaveLength(1)
      expect(payload.results[0]?.matches[0]?.preview).toContain('capture me')
    } finally {
      await tempFile.cleanup()
    }
  })

  it('supports nested result filtering via search scope', async () => {
    const service = createSearchService({ generateId: () => 'uuid-1' })
    service.syncTabState({
      id: 'tab-nested',
      title: 'nested.log',
      content: 'alpha\nbeta\ngamma\nalphabet',
      size: 28,
      isTruncated: false,
      loadedRange: { start: 0, end: 28 }
    })

    const baseSearch = await service.performSearch({
      query: 'a',
      matchCase: false,
      isRegex: false,
      scope: { kind: 'workspace' }
    })

    const refined = await service.performSearch({
      query: 'alpha',
      matchCase: false,
      isRegex: false,
      scope: { kind: 'search', searchId: baseSearch.searchId }
    })

    expect(refined.parentSearchId).toBe(baseSearch.searchId)
    expect(refined.results.every((result) => result.matches.every((match) => match.preview.includes('alpha')))).toBe(
      true
    )
  })
})
